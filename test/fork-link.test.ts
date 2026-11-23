import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionLogsRoot, snapshotTranscript } from "../src/capture/capture.ts";

function setup(): string {
  const repo = mkdtempSync(join(tmpdir(), "session-logs-forklink-"));
  execFileSync("git", ["init", "-q", repo]);
  return repo;
}

// Fabricated transcript entries; uuids are arbitrary test values.
const entry = (uuid: string, parentUuid: string | null, text: string) =>
  JSON.stringify({ type: "user", uuid, parentUuid, text }) + "\n";

function manifestOf(repo: string, snapshot: string) {
  return JSON.parse(readFileSync(join(sessionLogsRoot(repo), "snapshots", `${snapshot}.json`), "utf8"));
}

test("a forked transcript is linked to the parent snapshot that holds the fork point (D48)", () => {
  const repo = setup();
  const parentFile = join(repo, "parent.jsonl");
  writeFileSync(parentFile, entry("p1", null, "first") + entry("p2", "p1", "second"));
  const parentSnapshot = snapshotTranscript(repo, "parent-s", parentFile, new Date("2026-11-23T10:00:00Z"));

  // The fork copies the parent's history, then continues from p2.
  const forkFile = join(repo, "fork.jsonl");
  writeFileSync(forkFile, entry("p1", null, "first") + entry("p2", "p1", "second") + entry("f1", "p2", "fork turn"));
  const forkSnapshot = snapshotTranscript(repo, "fork-s", forkFile, new Date("2026-11-23T11:00:00Z"));

  assert.deepEqual(manifestOf(repo, forkSnapshot).parent, { session_id: "parent-s", snapshot: parentSnapshot });
  rmSync(repo, { recursive: true, force: true });
});

test("later snapshots of a fork keep its parent link", () => {
  const repo = setup();
  const parentFile = join(repo, "parent.jsonl");
  writeFileSync(parentFile, entry("p1", null, "first"));
  snapshotTranscript(repo, "parent-s", parentFile, new Date("2026-11-23T10:00:00Z"));
  const forkFile = join(repo, "fork.jsonl");
  writeFileSync(forkFile, entry("p1", null, "first") + entry("f1", "p1", "fork turn"));
  const first = snapshotTranscript(repo, "fork-s", forkFile, new Date("2026-11-23T11:00:00Z"));
  appendFileSync(forkFile, entry("f2", "f1", "more"));
  const second = snapshotTranscript(repo, "fork-s", forkFile, new Date("2026-11-23T11:30:00Z"));
  assert.notEqual(first, second);
  assert.equal(manifestOf(repo, second).parent?.session_id, "parent-s");
  rmSync(repo, { recursive: true, force: true });
});

test("an unrelated session has no parent", () => {
  const repo = setup();
  const file = join(repo, "solo.jsonl");
  writeFileSync(file, entry("s1", null, "fresh start") + entry("s2", "s1", "reply"));
  const snapshot = snapshotTranscript(repo, "solo-s", file, new Date("2026-11-23T10:00:00Z"));
  assert.equal(manifestOf(repo, snapshot).parent, null);
  rmSync(repo, { recursive: true, force: true });
});

test("a fork whose parent is not in the local store has no parent link", () => {
  const repo = setup();
  const file = join(repo, "orphan.jsonl");
  writeFileSync(file, entry("x1", null, "shared") + entry("x2", "elsewhere", "continues from unknown message"));
  const snapshot = snapshotTranscript(repo, "orphan-s", file, new Date("2026-11-23T10:00:00Z"));
  assert.equal(manifestOf(repo, snapshot).parent, null);
  rmSync(repo, { recursive: true, force: true });
});
