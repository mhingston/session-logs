import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  segmentLines,
  snapshotTranscript,
  sessionLogsRoot,
  writeCurrentSession,
  SEGMENT_MAX_MESSAGES,
} from "../src/capture/capture.ts";

const here = new URL(".", import.meta.url).pathname;
const stopHook = join(here, "../src/hooks/stop.ts");
const prepareHook = join(here, "../src/hooks/prepare-commit-msg.ts");

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "session-logs-test-"));
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}

function transcriptLines(count: number, prefix = "m"): string[] {
  return Array.from({ length: count }, (_, i) =>
    JSON.stringify({ type: i % 2 ? "user" : "assistant", uuid: `${prefix}${i}`, text: "x".repeat(40) }),
  );
}

test("segments close at 500 messages and keep earlier segments stable as the file grows", () => {
  const short = segmentLines(transcriptLines(1200));
  assert.deepEqual(short.map((s) => s.length), [SEGMENT_MAX_MESSAGES, SEGMENT_MAX_MESSAGES, 200]);

  const longer = segmentLines([...transcriptLines(1200), ...transcriptLines(300, "later")]);
  // Closed segments are identical, so they dedupe in the store (D8).
  assert.deepEqual(longer[0], short[0]);
  assert.deepEqual(longer[1], short[1]);
});

test("snapshot is skipped when transcript content is unchanged", () => {
  const repo = tempRepo();
  const transcript = join(repo, "t.jsonl");
  writeFileSync(transcript, transcriptLines(10).join("\n") + "\n");
  const first = snapshotTranscript(repo, "s1", transcript);
  const second = snapshotTranscript(repo, "s1", transcript);
  assert.equal(second, first);
  assert.equal(readdirSync(join(sessionLogsRoot(repo), "snapshots")).length, 1);
});

test("a changed transcript gets a new snapshot and the old one is unchanged", () => {
  const repo = tempRepo();
  const transcript = join(repo, "t.jsonl");
  writeFileSync(transcript, transcriptLines(10).join("\n") + "\n");
  const first = snapshotTranscript(repo, "s1", transcript);
  const firstManifest = readFileSync(join(sessionLogsRoot(repo), "snapshots", `${first}.json`), "utf8");

  writeFileSync(transcript, transcriptLines(12).join("\n") + "\n");
  const second = snapshotTranscript(repo, "s1", transcript);

  assert.notEqual(second, first);
  assert.equal(
    readFileSync(join(sessionLogsRoot(repo), "snapshots", `${first}.json`), "utf8"),
    firstManifest,
  );
});

test("manifest matches the schema in the handoff and its id is the hash of its bytes", () => {
  const repo = tempRepo();
  const transcript = join(repo, "t.jsonl");
  writeFileSync(transcript, transcriptLines(3).join("\n") + "\n");
  const snapshot = snapshotTranscript(repo, "s1", transcript);
  const path = join(sessionLogsRoot(repo), "snapshots", `${snapshot}.json`);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.session_id, "s1");
  assert.equal(manifest.parent, null);
  assert.equal(manifest.includes_subagents, false);
  assert.equal(manifest.source.agent, "claude-code");
  assert.equal(manifest.segments[0].messages, 3);
  for (const seg of manifest.segments) {
    assert.ok(existsSync(join(sessionLogsRoot(repo), "objects", seg.sha256)));
  }
  assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"), snapshot);
});

test("stop hook records the session and exits 0 on valid input", () => {
  const repo = tempRepo();
  const transcript = join(repo, "t.jsonl");
  writeFileSync(transcript, transcriptLines(4).join("\n") + "\n");
  const result = spawnSync(process.execPath, [stopHook], {
    input: JSON.stringify({ session_id: "s9", transcript_path: transcript, cwd: repo }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.ok(existsSync(join(sessionLogsRoot(repo), "current.json")));
  assert.ok(existsSync(join(sessionLogsRoot(repo), "sessions", "s9.json")));
});

test("stop hook exits 0 and logs when input is invalid", () => {
  const repo = tempRepo();
  const result = spawnSync(process.execPath, [stopHook], {
    input: JSON.stringify({ cwd: repo }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  const log = readFileSync(join(sessionLogsRoot(repo), "errors.log"), "utf8");
  assert.match(log, /missing session_id or transcript_path/);
});

test("prepare-commit-msg adds one Session and one Transcript trailer, idempotently", () => {
  const repo = tempRepo();
  const transcript = join(repo, "t.jsonl");
  writeFileSync(transcript, transcriptLines(4).join("\n") + "\n");
  mkdirSync(sessionLogsRoot(repo), { recursive: true });
  writeCurrentSession(repo, { session_id: "s5", transcript_path: transcript });

  const msgFile = join(repo, "COMMIT_EDITMSG");
  writeFileSync(msgFile, "Add feature\n");
  const run = () =>
    spawnSync(process.execPath, [prepareHook, msgFile], { cwd: repo, encoding: "utf8" });

  assert.equal(run().status, 0);
  assert.equal(run().status, 0); // amend-style second pass must not duplicate
  const message = readFileSync(msgFile, "utf8");
  assert.equal(message.match(/^Session: s5$/gm)?.length, 1);
  assert.equal(message.match(/^Transcript: [0-9a-f]{64}$/gm)?.length, 1);
});

test("prepare-commit-msg with no current session leaves the message untouched", () => {
  const repo = tempRepo();
  const msgFile = join(repo, "COMMIT_EDITMSG");
  writeFileSync(msgFile, "Plain commit\n");
  const result = spawnSync(process.execPath, [prepareHook, msgFile], { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(readFileSync(msgFile, "utf8"), "Plain commit\n");
});

test("prepare-commit-msg does not block the commit when snapshotting fails", () => {
  const repo = tempRepo();
  mkdirSync(sessionLogsRoot(repo), { recursive: true });
  writeCurrentSession(repo, { session_id: "s6", transcript_path: join(repo, "missing.jsonl") });
  const msgFile = join(repo, "COMMIT_EDITMSG");
  writeFileSync(msgFile, "Commit anyway\n");
  const result = spawnSync(process.execPath, [prepareHook, msgFile], { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /could not link/);
  assert.equal(readFileSync(msgFile, "utf8"), "Commit anyway\n");
});
