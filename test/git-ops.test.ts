import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installHooks } from "../src/install/install.ts";
import { recordActiveSession } from "../src/capture/capture.ts";
import { commitsForSession } from "../src/read/read.ts";

const TOOL_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

// Fixed timeline so the window rules are deterministic (git dates have 1 s precision).
const at = (hhmm: string) => new Date(`2026-11-23T${hhmm}:00Z`);
const iso = (hhmm: string) => at(hhmm).toISOString();

function git(repo: string, args: string[], committedAt?: string): string {
  const env = { ...process.env };
  if (committedAt) {
    env.GIT_COMMITTER_DATE = committedAt;
    env.GIT_AUTHOR_DATE = committedAt;
  }
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env });
}

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "session-logs-gitops-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  installHooks({ repoRoot: repo, toolRoot: TOOL_ROOT });
  return repo;
}

function transcript(repo: string, name: string, text: string): string {
  const path = join(repo, `${name}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: "user", text }) + "\n");
  return path;
}

function commit(repo: string, file: string, message: string, hhmm: string): void {
  writeFileSync(join(repo, file), file + "\n");
  git(repo, ["add", file]);
  git(repo, ["commit", "-q", "-m", message], iso(hhmm));
}

function trailerLines(repo: string, rev = "HEAD"): string[] {
  return git(repo, ["log", "-1", "--format=%B", rev]).split("\n").filter((l) => /^(Session|Transcript|Also-Active|Reverts): /.test(l));
}

function cleanup(repo: string): void {
  rmSync(repo, { recursive: true, force: true });
}

test("amend (reword) keeps one Session and one Transcript and updates the snapshot", () => {
  const repo = setupRepo();
  const t = transcript(repo, "b", "turn one");
  commit(repo, "base.txt", "Base", "10:00");
  recordActiveSession(repo, { session_id: "sA", transcript_path: t }, at("10:10"));
  commit(repo, "one.txt", "Linked", "10:20");
  const before = trailerLines(repo).find((l) => l.startsWith("Transcript: "));

  // The transcript grows, and the session stops again before the amend.
  appendTurn(t, "turn two");
  recordActiveSession(repo, { session_id: "sA", transcript_path: t }, at("10:30"));
  git(repo, ["commit", "-q", "--amend", "-m", "Linked, reworded"], iso("10:31"));

  const lines = trailerLines(repo);
  assert.equal(lines.filter((l) => l.startsWith("Session: ")).length, 1);
  assert.equal(lines.filter((l) => l.startsWith("Transcript: ")).length, 1);
  assert.notEqual(lines.find((l) => l.startsWith("Transcript: ")), before);
  cleanup(repo);
});

test("squash keeps every session pair and does not link a new session", () => {
  const repo = setupRepo();
  const ta = transcript(repo, "a", "session A work");
  const tb = transcript(repo, "b", "session B work");
  commit(repo, "base.txt", "Base", "10:00");
  recordActiveSession(repo, { session_id: "sA", transcript_path: ta }, at("10:10"));
  commit(repo, "one.txt", "Commit one", "10:20");
  recordActiveSession(repo, { session_id: "sB", transcript_path: tb }, at("10:30"));
  commit(repo, "two.txt", "Commit two", "10:40");

  // Squash commit two into commit one, replaying both with the hooks active.
  const env = { ...process.env, GIT_SEQUENCE_EDITOR: "sed -i.bak '2s/^pick/squash/'", GIT_COMMITTER_DATE: iso("10:50"), GIT_AUTHOR_DATE: iso("10:50") };
  execFileSync("git", ["-C", repo, "rebase", "-q", "-i", "HEAD~2"], { env, stdio: "ignore" });

  const sessions = trailerLines(repo).filter((l) => l.startsWith("Session: "));
  assert.deepEqual(sessions.sort(), ["Session: sA", "Session: sB"]);
  assert.equal(trailerLines(repo).filter((l) => l.startsWith("Transcript: ")).length, 2);
  assert.equal(commitsForSession(repo, "sA").length, 1);
  assert.equal(commitsForSession(repo, "sB").length, 1);
  cleanup(repo);
});

test("cherry-pick keeps the original session link and adds no new session", () => {
  const repo = setupRepo();
  const tb = transcript(repo, "b", "session B work");
  const tc = transcript(repo, "c", "session C work");
  commit(repo, "base.txt", "Base", "10:00");
  recordActiveSession(repo, { session_id: "sB", transcript_path: tb }, at("10:30"));
  commit(repo, "two.txt", "Linked to B", "10:40");
  const original = git(repo, ["rev-parse", "HEAD"]).trim();
  recordActiveSession(repo, { session_id: "sC", transcript_path: tc }, at("10:55"));

  git(repo, ["checkout", "-q", "-b", "other", "HEAD~1"]);
  git(repo, ["cherry-pick", original], iso("11:00"));

  const lines = trailerLines(repo);
  assert.deepEqual(lines.filter((l) => l.startsWith("Session: ")), ["Session: sB"]);
  assert.equal(lines.filter((l) => l.startsWith("Transcript: ")).length, 1);
  cleanup(repo);
});

test("revert links the reverting session and records Reverts:", () => {
  const repo = setupRepo();
  const ta = transcript(repo, "a", "session A work");
  const tc = transcript(repo, "c", "session C reverting");
  commit(repo, "base.txt", "Base", "10:00");
  recordActiveSession(repo, { session_id: "sA", transcript_path: ta }, at("10:10"));
  commit(repo, "one.txt", "Linked to A", "10:20");
  const linked = git(repo, ["rev-parse", "HEAD"]).trim();
  recordActiveSession(repo, { session_id: "sC", transcript_path: tc }, at("10:30"));

  git(repo, ["revert", "--no-edit", linked], iso("10:40"));

  const lines = trailerLines(repo);
  assert.deepEqual(lines.filter((l) => l.startsWith("Session: ")), ["Session: sC"]);
  assert.deepEqual(lines.filter((l) => l.startsWith("Reverts: ")), [`Reverts: ${linked}`]);
  // The reverted commit itself is untouched.
  assert.equal(commitsForSession(repo, "sA").length, 1);
  cleanup(repo);
});

test("rebase onto a new base keeps trailers and adds no session", () => {
  const repo = setupRepo();
  const tb = transcript(repo, "b", "session B work");
  const tc = transcript(repo, "c", "session C work");
  commit(repo, "base.txt", "Base", "10:00");
  recordActiveSession(repo, { session_id: "sB", transcript_path: tb }, at("10:30"));
  commit(repo, "two.txt", "Linked to B", "10:40");
  const before = trailerLines(repo);

  git(repo, ["checkout", "-q", "-b", "newbase", "HEAD~1"]);
  commit(repo, "moved.txt", "Moved base", "10:45");
  recordActiveSession(repo, { session_id: "sC", transcript_path: tc }, at("10:50"));
  git(repo, ["checkout", "-q", "main"]);
  git(repo, ["rebase", "-q", "newbase"], iso("10:55"));

  assert.deepEqual(trailerLines(repo), before);
  cleanup(repo);
});

function appendTurn(path: string, text: string): void {
  appendFileSync(path, JSON.stringify({ type: "user", text }) + "\n");
}
