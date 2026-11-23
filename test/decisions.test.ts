import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installHooks } from "../src/install/install.ts";
import { sessionLogsRoot, snapshotTranscript } from "../src/capture/capture.ts";
import {
  decisionsEnabled,
  extractDecisionsFromLines,
  generateDecisions,
  readDecisions,
} from "../src/decisions/decisions.ts";

const TOOL_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const STOP = join(TOOL_ROOT, "src/hooks/stop.ts");
const CLI = join(TOOL_ROOT, "src/cli/sessions.ts");

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "session-logs-decisions-"));
  execFileSync("git", ["init", "-q", repo]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  installHooks({ repoRoot: repo, toolRoot: TOOL_ROOT });
  return repo;
}

function entry(type: "user" | "assistant", uuid: string, text: string): string {
  return JSON.stringify({ type, uuid, text });
}

function writeConfig(repo: string, config: unknown): void {
  mkdirSync(sessionLogsRoot(repo), { recursive: true });
  writeFileSync(join(sessionLogsRoot(repo), "config.json"), JSON.stringify(config));
}

function stop(repo: string, sessionId: string, transcript: string): void {
  const result = spawnSync(process.execPath, [STOP], {
    input: JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: repo }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
}

const SAMPLE = [
  entry("user", "u1", "Can we store the cache in memory?"),
  entry("assistant", "a1", "Sure. Decision: keep the cache in memory for now. Looks good."),
  entry("assistant", "a2", "We chose SQLite instead of Postgres because it needs no server. Hello there."),
  entry("assistant", "a3", "Decision: keep the cache in memory for now."),
];

test("decision extraction is off by default, and capture alone never writes an extract", () => {
  const repo = setupRepo();
  const transcript = join(repo, "t.jsonl");
  writeFileSync(transcript, SAMPLE.join("\n") + "\n");
  stop(repo, "s1", transcript);
  assert.equal(decisionsEnabled(repo), false);
  assert.equal(existsSync(join(sessionLogsRoot(repo), "decisions")), false);
  assert.ok(existsSync(join(sessionLogsRoot(repo), "snapshots")), "capture still ran");
});

test("a config that only sets other keys does not enable decisions", () => {
  const repo = setupRepo();
  writeConfig(repo, { prune: { olderThanDays: 30 } });
  assert.equal(decisionsEnabled(repo), false);
  const transcript = join(repo, "t.jsonl");
  writeFileSync(transcript, SAMPLE.join("\n") + "\n");
  stop(repo, "s1", transcript);
  assert.equal(existsSync(join(sessionLogsRoot(repo), "decisions")), false);
});

test("enabling decisions writes an extract for each captured snapshot", () => {
  const repo = setupRepo();
  writeConfig(repo, { decisions: { enabled: true } });
  const transcript = join(repo, "t.jsonl");
  writeFileSync(transcript, SAMPLE.join("\n") + "\n");
  stop(repo, "s1", transcript);
  const index = JSON.parse(readFileSync(join(sessionLogsRoot(repo), "sessions", "s1.json"), "utf8"));
  const extract = readDecisions(repo, index.snapshot);
  assert.ok(extract, "extract written under the snapshot id");
  assert.equal(extract.snapshot, index.snapshot);
  assert.equal(extract.source_content_sha256, index.content_sha256);
});

test("extraction picks decision sentences with their signals and skips the rest", () => {
  const decisions = extractDecisionsFromLines(SAMPLE);
  assert.deepEqual(
    decisions.map((d) => [d.text, d.signals, d.uuid]),
    [
      ["Decision: keep the cache in memory for now.", ["decision-label"], "a1"],
      ["We chose SQLite instead of Postgres because it needs no server.", ["decided", "instead-of"], "a2"],
    ],
  );
});

test("the same transcript gives the same decisions and content hash in two repositories", () => {
  const extracts = [setupRepo(), setupRepo()].map((repo) => {
    writeConfig(repo, { decisions: { enabled: true } });
    const transcript = join(repo, "t.jsonl");
    writeFileSync(transcript, SAMPLE.join("\n") + "\n");
    return generateDecisions(repo, snapshotTranscript(repo, "s1", transcript));
  });
  // The snapshot ID includes the transcript path and time, so only content is compared.
  assert.deepEqual(extracts[0]!.decisions, extracts[1]!.decisions);
  assert.equal(extracts[0]!.source_content_sha256, extracts[1]!.source_content_sha256);
});

test("a grown transcript gets its own extract and the earlier extract is unchanged", () => {
  const repo = setupRepo();
  writeConfig(repo, { decisions: { enabled: true } });
  const transcript = join(repo, "t.jsonl");
  writeFileSync(transcript, SAMPLE.join("\n") + "\n");
  const first = snapshotTranscript(repo, "s1", transcript);
  const firstExtract = generateDecisions(repo, first);

  appendFileSync(transcript, entry("assistant", "a9", "Decision: ship it on Friday.") + "\n");
  const second = snapshotTranscript(repo, "s1", transcript);
  const secondExtract = generateDecisions(repo, second);

  assert.notEqual(second, first);
  assert.equal(firstExtract.decisions.length, 2);
  assert.equal(secondExtract.decisions.length, 3);
  assert.notEqual(secondExtract.source_content_sha256, firstExtract.source_content_sha256);
  assert.equal(readDecisions(repo, first)?.decisions.length, 2);
  assert.equal(readdirSync(join(sessionLogsRoot(repo), "decisions")).length, 2);
});

test("extracts contain only redacted text from the snapshot", () => {
  const repo = setupRepo();
  writeConfig(repo, { decisions: { enabled: true } });
  const secret = "sk-ant-" + "a".repeat(30);
  const transcript = join(repo, "t.jsonl");
  writeFileSync(transcript, entry("assistant", "a1", `Decision: use the key ${secret} for staging.`) + "\n");
  const snapshot = generateDecisions(repo, snapshotTranscript(repo, "s1", transcript)).snapshot;
  const raw = readFileSync(join(sessionLogsRoot(repo), "decisions", `${snapshot}.json`), "utf8");
  assert.doesNotMatch(raw, /sk-ant-a/);
  assert.match(raw, /\[REDACTED:anthropic-key\]/);
});

test("sessions decisions prints the extract for a commit and refuses when disabled", () => {
  const repo = setupRepo();
  const transcript = join(repo, "t.jsonl");
  writeFileSync(transcript, SAMPLE.join("\n") + "\n");
  stop(repo, "s1", transcript);
  writeFileSync(join(repo, "f.txt"), "x\n");
  git(repo, ["add", "f.txt"]);
  git(repo, ["commit", "-q", "-m", "Add file"]);

  const disabled = spawnSync(process.execPath, [CLI, "decisions", "HEAD"], { cwd: repo, encoding: "utf8" });
  assert.equal(disabled.status, 1);
  assert.match(disabled.stderr, /decision extraction is off/);

  writeConfig(repo, { decisions: { enabled: true } });
  const enabled = spawnSync(process.execPath, [CLI, "decisions", "HEAD"], { cwd: repo, encoding: "utf8" });
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.match(enabled.stdout, /- \[message 1, assistant\] Decision: keep the cache in memory for now\./);
});
