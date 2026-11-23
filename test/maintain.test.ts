import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installHooks } from "../src/install/install.ts";
import { recordActiveSession, sessionLogsRoot, snapshotTranscript } from "../src/capture/capture.ts";
import { renderSnapshot, snapshotForCommit, readManifest } from "../src/read/read.ts";
import { doctor, forkSession, pruneSessions } from "../src/maintain/maintain.ts";

const TOOL_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const at = (hhmm: string) => new Date(`2026-11-23T${hhmm}:00Z`);
const iso = (hhmm: string) => at(hhmm).toISOString();

function git(repo: string, args: string[], committedAt?: string, extraConfig: string[] = []): string {
  const env = { ...process.env };
  if (committedAt) {
    env.GIT_COMMITTER_DATE = committedAt;
    env.GIT_AUTHOR_DATE = committedAt;
  }
  return execFileSync("git", ["-C", repo, ...extraConfig, ...args], { encoding: "utf8", env });
}

function setupRepo(withHooks = true): string {
  const repo = mkdtempSync(join(tmpdir(), "session-logs-maint-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  if (withHooks) installHooks({ repoRoot: repo, toolRoot: TOOL_ROOT });
  return repo;
}

function transcript(repo: string, name: string, lines: string[]): string {
  const path = join(repo, `${name}.jsonl`);
  writeFileSync(path, lines.map((text) => JSON.stringify({ type: "user", text }) + "\n").join(""));
  return path;
}

function commit(repo: string, file: string, message: string, hhmm: string, unhooked = false): void {
  writeFileSync(join(repo, file), file + "\n");
  git(repo, ["add", file]);
  const extra = unhooked ? ["-c", `core.hooksPath=${join(repo, "no-hooks")}`] : [];
  mkdirSync(join(repo, "no-hooks"), { recursive: true });
  git(repo, ["commit", "-q", "-m", message], iso(hhmm), extra);
}

test("fork records the parent snapshot and leaves the parent untouched", () => {
  const repo = setupRepo();
  const t = transcript(repo, "p", ["parent work"]);
  commit(repo, "base.txt", "Base", "10:00");
  recordActiveSession(repo, { session_id: "parent-s", transcript_path: t }, at("10:10"));
  commit(repo, "one.txt", "Linked", "10:20");
  const parentSnapshot = snapshotForCommit(repo, "HEAD");
  assert.ok(parentSnapshot);
  const parentFile = join(sessionLogsRoot(repo), "snapshots", `${parentSnapshot}.json`);
  const parentBytes = readFileSync(parentFile);

  const fork = forkSession(repo, "parent-s", parentSnapshot, at("11:00"), "fork-s");
  assert.equal(fork.session_id, "fork-s");
  const forked = readManifest(repo, fork.snapshot);
  assert.deepEqual(forked.parent, { session_id: "parent-s", snapshot: parentSnapshot });
  assert.equal(forked.session_id, "fork-s");
  assert.deepEqual(readFileSync(parentFile), parentBytes);
  assert.equal(renderSnapshot(repo, fork.snapshot, "raw"), renderSnapshot(repo, parentSnapshot, "raw"));
  rmSync(repo, { recursive: true, force: true });
});

test("fork rejects a snapshot that belongs to a different session", () => {
  const repo = setupRepo();
  const t = transcript(repo, "p", ["work"]);
  const snapshot = snapshotTranscript(repo, "owner", t);
  assert.throws(() => forkSession(repo, "someone-else", snapshot), /belongs to session owner/);
  rmSync(repo, { recursive: true, force: true });
});

test("fork accepts a unique snapshot prefix", () => {
  const repo = setupRepo();
  const t = transcript(repo, "p", ["prefix fork"]);
  const snapshot = snapshotTranscript(repo, "prefix-parent", t, at("10:00"));
  const fork = forkSession(repo, "prefix-parent", snapshot.slice(0, 12), at("10:05"), "prefix-child");
  const forked = readManifest(repo, fork.snapshot);
  assert.deepEqual(forked.parent, { session_id: "prefix-parent", snapshot });
  rmSync(repo, { recursive: true, force: true });
});

test("doctor warns when registered Claude Code hook scripts are missing on disk", () => {
  const repo = setupRepo(false);
  installHooks({ repoRoot: repo, toolRoot: "/nonexistent/moved/session-logs" });
  const findings = doctor(repo);
  assert.ok(findings.some((f) => f.level === "warn" && /Stop hook.*missing script/.test(f.message)));
  assert.ok(findings.some((f) => f.level === "warn" && /UserPromptSubmit hook.*missing script/.test(f.message)));
  rmSync(repo, { recursive: true, force: true });
});

test("doctor warns when hooks are not installed", () => {
  const repo = setupRepo(false);
  const findings = doctor(repo);
  assert.ok(findings.some((f) => f.level === "warn" && /hooks are not installed/.test(f.message)));
  rmSync(repo, { recursive: true, force: true });
});

test("doctor reports an unlinked commit made during a recorded session", () => {
  const repo = setupRepo();
  const t = transcript(repo, "s", ["work"]);
  commit(repo, "base.txt", "Base", "10:00");
  recordActiveSession(repo, { session_id: "during", transcript_path: t }, at("10:10"));
  recordActiveSession(repo, { session_id: "during", transcript_path: t }, at("10:30"));
  commit(repo, "stray.txt", "No link", "10:20", true);
  const findings = doctor(repo);
  assert.ok(findings.some((f) => f.level === "warn" && /no session link.*during/.test(f.message)));
  rmSync(repo, { recursive: true, force: true });
});

test("doctor reports a commit whose snapshot is missing from the store", () => {
  const repo = setupRepo();
  const t = transcript(repo, "m", ["work"]);
  commit(repo, "base.txt", "Base", "10:00");
  recordActiveSession(repo, { session_id: "gone", transcript_path: t }, at("10:10"));
  commit(repo, "x.txt", "Linked", "10:20");
  const snapshot = snapshotForCommit(repo, "HEAD");
  assert.ok(snapshot);
  rmSync(join(sessionLogsRoot(repo), "snapshots", `${snapshot}.json`));
  assert.ok(doctor(repo).some((f) => f.level === "error" && /missing snapshot/.test(f.message)));
  rmSync(repo, { recursive: true, force: true });
});

test("prune is off without a retention setting", () => {
  const repo = setupRepo();
  assert.throws(() => pruneSessions(repo, { apply: false, includeLinked: false }), /off by default/);
  rmSync(repo, { recursive: true, force: true });
});

test("prune dry run lists unlinked old sessions without deleting; apply removes them and their objects", () => {
  const repo = setupRepo();
  const old = transcript(repo, "old", ["old unlinked work"]);
  const keep = transcript(repo, "keep", ["linked work that must stay"]);
  commit(repo, "base.txt", "Base", "10:00");
  const oldSnapshot = snapshotTranscript(repo, "old-s", old, at("10:05"));
  recordActiveSession(repo, { session_id: "keep-s", transcript_path: keep }, at("10:10"));
  commit(repo, "k.txt", "Linked to keep", "10:20");
  const keepSnapshot = snapshotForCommit(repo, "HEAD");
  assert.ok(keepSnapshot);

  const later = new Date(at("10:30").getTime() + 2 * 24 * 60 * 60 * 1000);
  const dry = pruneSessions(repo, { olderThanDays: 1, apply: false, includeLinked: false, now: later });
  assert.deepEqual(dry.sessions, ["old-s"]);
  assert.ok(existsSync(join(sessionLogsRoot(repo), "snapshots", `${oldSnapshot}.json`)));

  const applied = pruneSessions(repo, { olderThanDays: 1, apply: true, includeLinked: false, now: later });
  assert.equal(applied.applied, true);
  assert.ok(!existsSync(join(sessionLogsRoot(repo), "snapshots", `${oldSnapshot}.json`)));
  assert.ok(existsSync(join(sessionLogsRoot(repo), "snapshots", `${keepSnapshot}.json`)));
  assert.equal(renderSnapshot(repo, keepSnapshot, "markdown").includes("linked work that must stay"), true);
  rmSync(repo, { recursive: true, force: true });
});

test("prune keeps a session that a fork depends on", () => {
  const repo = setupRepo();
  const t = transcript(repo, "f", ["parent of a fork"]);
  const snapshot = snapshotTranscript(repo, "root-s", t, at("10:00"));
  forkSession(repo, "root-s", snapshot, at("10:05"), "child-s");
  const later = new Date(at("10:30").getTime() + 2 * 24 * 60 * 60 * 1000);
  const plan = pruneSessions(repo, { olderThanDays: 1, apply: false, includeLinked: false, now: later });
  assert.ok(!plan.sessions.includes("root-s"));
  rmSync(repo, { recursive: true, force: true });
});

