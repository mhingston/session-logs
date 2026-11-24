import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installHooks } from "../src/install/install.ts";
import { recordActiveSession, sessionLogsRoot, snapshotTranscript } from "../src/capture/capture.ts";
import { renderSnapshot, snapshotForCommit } from "../src/read/read.ts";
import { pushSnapshots, fetchSnapshot } from "../src/remote/sync.ts";
import { remoteConfig } from "../src/remote/remote.ts";
import { sha256Hex, type ObjectStore } from "../src/storage/object-store.ts";

const TOOL_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const at = (hhmm: string) => new Date(`2026-11-23T${hhmm}:00Z`);
const iso = (hhmm: string) => at(hhmm).toISOString();

// In-memory ObjectStore with the same hash checks as the Azure adapter.
class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly named = new Map<string, Uint8Array>();
  async has(hash: string): Promise<boolean> {
    return this.objects.has(hash);
  }
  async put(hash: string, bytes: Uint8Array): Promise<void> {
    if (sha256Hex(bytes) !== hash) throw new Error("bytes do not match hash");
    this.objects.set(hash, bytes);
  }
  async get(hash: string): Promise<Uint8Array | undefined> {
    const bytes = this.objects.get(hash);
    if (bytes && sha256Hex(bytes) !== hash) throw new Error("integrity");
    return bytes;
  }
  async putNamed(name: string, bytes: Uint8Array): Promise<void> {
    if (!this.named.has(name)) this.named.set(name, bytes);
  }
  async getNamed(name: string): Promise<Uint8Array | undefined> {
    return this.named.get(name);
  }
}

function git(cwd: string, args: string[], committedAt?: string): string {
  const env = { ...process.env };
  if (committedAt) {
    env.GIT_COMMITTER_DATE = committedAt;
    env.GIT_AUTHOR_DATE = committedAt;
  }
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env });
}

function userLine(text: string): string {
  return JSON.stringify({ type: "user", text }) + "\n";
}

test("teammate clone: a commit made elsewhere shows its transcript after fetch (handoff test 13)", async () => {
  const author = mkdtempSync(join(tmpdir(), "session-logs-author-"));
  execFileSync("git", ["init", "-q", "-b", "main", author]);
  git(author, ["config", "user.name", "Author"]);
  git(author, ["config", "user.email", "a@example.invalid"]);
  installHooks({ repoRoot: author, toolRoot: TOOL_ROOT });
  const t = join(author, "t.jsonl");
  writeFileSync(t, userLine("designed the retry policy"));
  writeFileSync(join(author, "base.txt"), "b\n");
  git(author, ["add", "base.txt"]);
  git(author, ["commit", "-q", "-m", "Base"], iso("10:00"));
  recordActiveSession(author, { session_id: "author-s", transcript_path: t }, at("10:10"));
  writeFileSync(join(author, "retry.txt"), "r\n");
  git(author, ["add", "retry.txt"]);
  git(author, ["commit", "-q", "-m", "Add retry"], iso("10:20"));
  const snapshot = snapshotForCommit(author, "HEAD");
  assert.ok(snapshot);

  const store = new MemoryStore();
  const pushed = await pushSnapshots(author, store);
  assert.ok(pushed.pushed.includes(snapshot));

  // The teammate has the commit (via git) but no local .session-logs.
  const clone = mkdtempSync(join(tmpdir(), "session-logs-clone-"));
  rmSync(clone, { recursive: true, force: true });
  execFileSync("git", ["clone", "-q", author, clone]);
  const cloneSnapshot = snapshotForCommit(clone, "HEAD");
  assert.equal(cloneSnapshot, snapshot);
  assert.equal(existsSync(join(sessionLogsRoot(clone), "snapshots")), false);

  await fetchSnapshot(clone, store, snapshot);
  assert.equal(renderSnapshot(clone, snapshot, "raw"), renderSnapshot(author, snapshot, "raw"));
  assert.match(renderSnapshot(clone, snapshot, "markdown"), /designed the retry policy/);

  rmSync(author, { recursive: true, force: true });
  rmSync(clone, { recursive: true, force: true });
});

test("summaries and decision extracts are pushed with their snapshot and fetched with it", async () => {
  const author = mkdtempSync(join(tmpdir(), "session-logs-derived-"));
  execFileSync("git", ["init", "-q", author]);
  const t = join(author, "t.jsonl");
  writeFileSync(t, userLine("chose the simple cache"));
  const snapshot = snapshotTranscript(author, "derived-s", t, at("10:00"));
  const root = sessionLogsRoot(author);
  mkdirSync(join(root, "summaries"), { recursive: true });
  writeFileSync(join(root, "summaries", `${snapshot}.json`), JSON.stringify({ snapshot, summary: "- chose the simple cache" }));
  mkdirSync(join(root, "decisions"), { recursive: true });
  writeFileSync(join(root, "decisions", `${snapshot}.json`), JSON.stringify({ snapshot, decisions: [] }));

  const store = new MemoryStore();
  await pushSnapshots(author, store);
  assert.deepEqual([...store.named.keys()].sort(), [`decisions/${snapshot}.json`, `summaries/${snapshot}.json`]);

  const reader = mkdtempSync(join(tmpdir(), "session-logs-reader-"));
  execFileSync("git", ["init", "-q", reader]);
  await fetchSnapshot(reader, store, snapshot);
  assert.match(readFileSync(join(sessionLogsRoot(reader), "summaries", `${snapshot}.json`), "utf8"), /simple cache/);
  assert.equal(existsSync(join(sessionLogsRoot(reader), "decisions", `${snapshot}.json`)), true);

  rmSync(author, { recursive: true, force: true });
  rmSync(reader, { recursive: true, force: true });
});

test("a redacted snapshot's summary is blocked by the same gate as its transcript", async () => {
  const repo = mkdtempSync(join(tmpdir(), "session-logs-derived-gate-"));
  execFileSync("git", ["init", "-q", repo]);
  const t = join(repo, "t.jsonl");
  writeFileSync(t, userLine(`key ${"AKIAABCDEFGHIJKLMNOP"}`)); // fabricated
  const snapshot = snapshotTranscript(repo, "derived-gate-s", t, at("10:00"));
  const root = sessionLogsRoot(repo);
  mkdirSync(join(root, "summaries"), { recursive: true });
  writeFileSync(join(root, "summaries", `${snapshot}.json`), JSON.stringify({ snapshot, summary: "- x" }));

  const store = new MemoryStore();
  await pushSnapshots(repo, store);
  assert.equal(store.named.size, 0);
  assert.equal(store.objects.size, 0);

  rmSync(repo, { recursive: true, force: true });
});

test("push blocks snapshots with redactions unless overridden, and logs the override by count only", async () => {
  const repo = mkdtempSync(join(tmpdir(), "session-logs-gate-"));
  execFileSync("git", ["init", "-q", repo]);
  const secret = "AKIAABCDEFGHIJKLMNOP"; // fabricated
  const t = join(repo, "t.jsonl");
  writeFileSync(t, userLine(`key ${secret}`));
  const snapshot = snapshotTranscript(repo, "gate-s", t, at("10:00"));

  const store = new MemoryStore();
  const blocked = await pushSnapshots(repo, store);
  assert.deepEqual(blocked.pushed, []);
  assert.equal(blocked.skipped[0]?.snapshot, snapshot);
  assert.equal(store.objects.size, 0);

  const overridden = await pushSnapshots(repo, store, { allowRedacted: true });
  assert.deepEqual(overridden.pushed, [snapshot]);
  const log = readFileSync(join(sessionLogsRoot(repo), "remote.log"), "utf8");
  assert.match(log, /override push/);
  assert.ok(!log.includes(secret));
  rmSync(repo, { recursive: true, force: true });
});

test("fetch refuses a segment whose bytes do not match its hash", async () => {
  const repo = mkdtempSync(join(tmpdir(), "session-logs-fetch-"));
  execFileSync("git", ["init", "-q", repo]);
  const t = join(repo, "t.jsonl");
  writeFileSync(t, userLine("clean text"));
  const snapshot = snapshotTranscript(repo, "f-s", t, at("10:00"));
  const store = new MemoryStore();
  await pushSnapshots(repo, store);

  // Tamper with a stored segment under its original key, bypassing put's check.
  const manifest = JSON.parse(readFileSync(join(sessionLogsRoot(repo), "snapshots", `${snapshot}.json`), "utf8"));
  const key = manifest.segments[0].sha256 as string;
  store.objects.set(key, new TextEncoder().encode("tampered"));

  const other = mkdtempSync(join(tmpdir(), "session-logs-fetch2-"));
  execFileSync("git", ["init", "-q", other]);
  await assert.rejects(fetchSnapshot(other, store, snapshot), /integrity/);
  rmSync(repo, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});

test("remote config accepts a bare account URL and rejects one carrying a SAS query", () => {
  const repo = mkdtempSync(join(tmpdir(), "session-logs-remote-config-"));
  execFileSync("git", ["init", "-q", repo]);
  mkdirSync(sessionLogsRoot(repo), { recursive: true });
  const configFile = join(sessionLogsRoot(repo), "config.json");
  const write = (accountUrl: string) =>
    writeFileSync(configFile, JSON.stringify({ remote: { enabled: true, provider: "azure-blob", accountUrl, container: "c" } }));

  write("https://acct.blob.core.windows.net/c?sp=r&sig=fabricated");
  assert.throws(() => remoteConfig(repo), /bare account URL/);

  write("https://acct.blob.core.windows.net");
  assert.deepEqual(remoteConfig(repo), {
    enabled: true,
    provider: "azure-blob",
    accountUrl: "https://acct.blob.core.windows.net",
    container: "c",
    prefix: undefined,
  });

  rmSync(repo, { recursive: true, force: true });
});
