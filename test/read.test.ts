import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installHooks } from "../src/install/install.ts";
import { recordActiveSession } from "../src/capture/capture.ts";
import {
  commitsForSession,
  listSessions,
  readManifest,
  renderSnapshot,
  snapshotForCommit,
} from "../src/read/read.ts";

const TOOL_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const STOP = join(TOOL_ROOT, "src/hooks/stop.ts");

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "session-logs-read-"));
  execFileSync("git", ["init", "-q", repo]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  installHooks({ repoRoot: repo, toolRoot: TOOL_ROOT });
  return repo;
}

function userLine(text: string): string {
  return JSON.stringify({ type: "user", text }) + "\n";
}

function stop(repo: string, sessionId: string, transcript: string): void {
  const result = spawnSync(process.execPath, [STOP], {
    input: JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: repo }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
}

function commitFile(repo: string, name: string, message: string): void {
  writeFileSync(join(repo, name), name + "\n");
  git(repo, ["add", name]);
  git(repo, ["commit", "-q", "-m", message]);
}

test("show renders the transcript as it was at commit time, not after later turns", () => {
  const repo = setupRepo();
  const transcript = join(repo, "t.jsonl");
  writeFileSync(transcript, userLine("first request"));
  stop(repo, "sess-a", transcript);
  commitFile(repo, "one.txt", "Change one");
  const commit = git(repo, ["rev-parse", "HEAD"]).trim();

  appendFileSync(transcript, userLine("later request that came after the commit"));
  stop(repo, "sess-a", transcript);

  const snapshot = snapshotForCommit(repo, commit);
  assert.ok(snapshot);
  const shown = renderSnapshot(repo, snapshot, "markdown");
  assert.match(shown, /first request/);
  assert.doesNotMatch(shown, /later request/);
  rmSync(repo, { recursive: true, force: true });
});

test("commits lists the linked commits for a session, and show works from a commit id", () => {
  const repo = setupRepo();
  const transcript = join(repo, "t.jsonl");
  writeFileSync(transcript, userLine("work"));
  stop(repo, "sess-b", transcript);
  commitFile(repo, "a.txt", "Commit A");
  appendFileSync(transcript, userLine("more"));
  stop(repo, "sess-b", transcript);
  commitFile(repo, "b.txt", "Commit B");

  const links = commitsForSession(repo, "sess-b");
  assert.equal(links.length, 2);
  assert.ok(links.every((l) => l.relation === "primary" && l.snapshot));
  assert.notEqual(links[0]?.snapshot, links[1]?.snapshot);
  rmSync(repo, { recursive: true, force: true });
});

test("concurrent sessions: the most recent session is primary, the other is also-active", () => {
  const repo = setupRepo();
  const t1 = join(repo, "s1.jsonl");
  const t2 = join(repo, "s2.jsonl");
  writeFileSync(t1, userLine("from session one"));
  writeFileSync(t2, userLine("from session two"));
  // Baseline commit so the window has a start time.
  commitFile(repo, "base.txt", "Base");
  const base = Date.parse(git(repo, ["log", "-1", "--format=%cI"]).trim());

  recordActiveSession(repo, { session_id: "conc-1", transcript_path: t1 }, new Date(base + 1000));
  recordActiveSession(repo, { session_id: "conc-2", transcript_path: t2 }, new Date(base + 2000));
  commitFile(repo, "feature.txt", "Feature work");

  const message = git(repo, ["log", "-1", "--format=%B"]);
  assert.match(message, /^Session: conc-2$/m);
  assert.match(message, /^Also-Active: conc-1$/m);
  assert.equal(commitsForSession(repo, "conc-2")[0]?.relation, "primary");
  assert.equal(commitsForSession(repo, "conc-1")[0]?.relation, "also-active");
  rmSync(repo, { recursive: true, force: true });
});

test("sessions that stopped before the previous commit are not linked to the next one", () => {
  const repo = setupRepo();
  const stale = join(repo, "stale.jsonl");
  writeFileSync(stale, userLine("old work"));
  // Baseline commit: with no earlier commit the hook uses the latest session,
  // so the window needs a start point first.
  commitFile(repo, "base.txt", "Baseline");
  recordActiveSession(repo, { session_id: "old-1", transcript_path: stale }, new Date("2000-01-01T00:00:00Z"));
  commitFile(repo, "x.txt", "Commit with no new session");
  commitFile(repo, "y.txt", "Second commit, still nothing new");
  assert.equal(commitsForSession(repo, "old-1").length, 0);
  rmSync(repo, { recursive: true, force: true });
});

test("list shows recorded sessions with their latest snapshot", () => {
  const repo = setupRepo();
  const transcript = join(repo, "t.jsonl");
  writeFileSync(transcript, userLine("hello"));
  stop(repo, "sess-list", transcript);
  const sessions = listSessions(repo);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.session_id, "sess-list");
  assert.ok(sessions[0]?.latest_snapshot);
  rmSync(repo, { recursive: true, force: true });
});

test("rendered output never contains a secret from the transcript", () => {
  const repo = setupRepo();
  const transcript = join(repo, "t.jsonl");
  const secret = "AKIAABCDEFGHIJKLMNOP"; // fabricated
  writeFileSync(transcript, userLine(`key ${secret}`));
  stop(repo, "sess-secret", transcript);
  commitFile(repo, "s.txt", "Secret check");
  const snapshot = snapshotForCommit(repo, "HEAD");
  assert.ok(snapshot);
  const shown = renderSnapshot(repo, snapshot, "raw");
  assert.ok(!shown.includes(secret));
  assert.match(shown, /\[REDACTED:aws-access-key\]/);
  rmSync(repo, { recursive: true, force: true });
});

test("snapshot ids are validated before any filesystem access", () => {
  const repo = setupRepo();
  assert.throws(() => readManifest(repo, "../../etc/passwd"), /not a snapshot id/);
  rmSync(repo, { recursive: true, force: true });
});
