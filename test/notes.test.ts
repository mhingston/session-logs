import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installHooks } from "../src/install/install.ts";
import { recordTurnOpen } from "../src/capture/capture.ts";
import { readNote, rebuildNotes, notesRepo } from "../src/notes/notes.ts";

const TOOL_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const iso = (hhmm: string) => new Date(`2026-11-23T${hhmm}:00Z`).toISOString();

function git(repo: string, args: string[], committedAt?: string): string {
  const env = { ...process.env };
  if (committedAt) {
    env.GIT_COMMITTER_DATE = committedAt;
    env.GIT_AUTHOR_DATE = committedAt;
  }
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env });
}

function setupRepo(globalHooksPath?: string): string {
  const repo = mkdtempSync(join(tmpdir(), "session-logs-notes-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  installHooks({ repoRoot: repo, toolRoot: TOOL_ROOT, globalHooksPath });
  return repo;
}

function commit(repo: string, file: string, message: string, hhmm: string): void {
  writeFileSync(join(repo, file), file + "\n");
  git(repo, ["add", file]);
  git(repo, ["commit", "-q", "-m", message], iso(hhmm));
}

function openTurn(repo: string, sessionId: string): void {
  const t = join(repo, `${sessionId}.jsonl`);
  writeFileSync(t, JSON.stringify({ type: "user", uuid: `${sessionId}-u`, text: "work" }) + "\n");
  recordTurnOpen(repo, { session_id: sessionId, transcript_path: t }, new Date(Date.now() - 60_000));
}

test("a linked commit gets a session note under .session-logs, not in the main repository's refs", () => {
  const repo = setupRepo();
  commit(repo, "base.txt", "Base", "10:00");
  openTurn(repo, "note-s1");
  commit(repo, "one.txt", "Linked", "10:20");
  const head = git(repo, ["rev-parse", "HEAD"]).trim();

  assert.ok(existsSync(join(notesRepo(repo), "HEAD")), "notes repository lives under .session-logs");
  const note = readNote(repo, head);
  assert.ok(note);
  assert.match(note, /^Session: note-s1$/m);
  assert.match(note, /^Transcript: [0-9a-f]{64}$/m);
  assert.equal(git(repo, ["for-each-ref", "refs/notes"]).trim(), "", "no notes ref in the main repository");
  rmSync(repo, { recursive: true, force: true });
});

test("commits with no session have no note", () => {
  const repo = setupRepo();
  commit(repo, "plain.txt", "Not in a session", "10:00");
  assert.equal(readNote(repo, "HEAD"), undefined);
  rmSync(repo, { recursive: true, force: true });
});

test("amend refreshes the note for the rewritten commit, with one Session line", () => {
  const repo = setupRepo();
  commit(repo, "base.txt", "Base", "10:00");
  openTurn(repo, "amend-s");
  commit(repo, "one.txt", "Linked", "10:20");
  git(repo, ["commit", "-q", "--amend", "-m", "Linked, reworded"], iso("10:30"));
  const note = readNote(repo, "HEAD");
  assert.ok(note);
  assert.equal(note.match(/^Session: /gm)?.length, 1);
  assert.match(note, /^Session: amend-s$/m);
  rmSync(repo, { recursive: true, force: true });
});

test("rebase refreshes notes for replayed commits", () => {
  const repo = setupRepo();
  commit(repo, "base.txt", "Base", "10:00");
  openTurn(repo, "rebase-s");
  commit(repo, "one.txt", "Linked", "10:20");
  git(repo, ["checkout", "-q", "-b", "newbase", "HEAD~1"]);
  commit(repo, "moved.txt", "Moved base", "10:25");
  git(repo, ["checkout", "-q", "main"]);
  git(repo, ["rebase", "-q", "newbase"], iso("10:40"));
  const note = readNote(repo, "HEAD");
  assert.ok(note, "replayed commit has a note");
  assert.match(note, /^Session: rebase-s$/m);
  rmSync(repo, { recursive: true, force: true });
});

test("rebuild restores every note from trailers after the notes store is lost", () => {
  const repo = setupRepo();
  commit(repo, "base.txt", "Base", "10:00");
  openTurn(repo, "rebuild-s");
  commit(repo, "one.txt", "Linked", "10:20");
  const head = git(repo, ["rev-parse", "HEAD"]).trim();
  rmSync(notesRepo(repo), { recursive: true, force: true });
  assert.equal(readNote(repo, head), undefined);
  const written = rebuildNotes(repo);
  assert.equal(written, 1);
  assert.match(readNote(repo, head) ?? "", /^Session: rebuild-s$/m);
  rmSync(repo, { recursive: true, force: true });
});

test("a global post-rewrite hook still receives stdin when session-logs also reads it", () => {
  const globalDir = mkdtempSync(join(tmpdir(), "session-logs-global-rw-"));
  const received = join(globalDir, "received.txt");
  writeFileSync(join(globalDir, "post-rewrite"), `#!/bin/sh\ncat > ${received}\n`);
  chmodSync(join(globalDir, "post-rewrite"), 0o755);
  const repo = setupRepo(globalDir);
  commit(repo, "base.txt", "Base", "10:00");
  openTurn(repo, "chain-s");
  commit(repo, "one.txt", "Linked", "10:20");
  git(repo, ["commit", "-q", "--amend", "-m", "Linked again"], iso("10:30"));
  assert.ok(existsSync(received), "global hook ran");
  assert.match(readFileSync(received, "utf8"), /[0-9a-f]{40} [0-9a-f]{40}/, "global hook received the rewrite list");
  assert.match(readNote(repo, "HEAD") ?? "", /^Session: chain-s$/m, "note still written after global hook");
  rmSync(repo, { recursive: true, force: true });
  rmSync(globalDir, { recursive: true, force: true });
});
