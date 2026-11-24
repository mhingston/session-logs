import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sessionLogsRoot, snapshotTranscript } from "../src/capture/capture.ts";
import { pruneSessions } from "../src/maintain/maintain.ts";
import {
  buildPrompt,
  generateSummary,
  MAX_TRANSCRIPT_CHARS,
  readSummary,
  runClaudePrint,
  SUMMARIZING_ENV,
  SummaryBusyError,
  tryLock,
} from "../src/summaries/summaries.ts";

const TOOL_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const STOP = join(TOOL_ROOT, "src/hooks/stop.ts");

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function tempRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "session-logs-summaries-"));
  execFileSync("git", ["init", "-q", repo]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  return repo;
}

function entry(type: string, uuid: string, text: string): string {
  return JSON.stringify({ type, uuid, text });
}

function writeConfig(repo: string, config: unknown): void {
  mkdirSync(sessionLogsRoot(repo), { recursive: true });
  writeFileSync(join(sessionLogsRoot(repo), "config.json"), JSON.stringify(config));
}

// A fake `claude` that records the prompt it receives on stdin and prints a fixed summary.
function fakeClaude(dir: string): { bin: string; promptFile: string } {
  const promptFile = join(dir, "prompt.txt");
  const bin = join(dir, "fake-claude.sh");
  writeFileSync(bin, `#!/bin/sh\ncat > "${promptFile}"\necho "- fake summary bullet"\n`);
  chmodSync(bin, 0o755);
  return { bin, promptFile };
}

function stop(repo: string, transcript: string, env: NodeJS.ProcessEnv): void {
  const result = spawnSync(process.execPath, [STOP], {
    input: JSON.stringify({ session_id: "s1", transcript_path: transcript, cwd: repo }),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0);
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for background summary");
    await new Promise((done) => setTimeout(done, 100));
  }
}

const SAMPLE = [
  entry("user", "u1", "Should we cache in memory?"),
  entry("assistant", "a1", "Decision: keep the cache in memory for now."),
  entry("attachment", "x1", "INJECTED-CONTEXT-SHOULD-NOT-REACH-MODEL"),
];

test("summaries are off by default: stop does not start a summary", async () => {
  const repo = tempRepo();
  const fake = fakeClaude(mkdtempSync(join(tmpdir(), "fake-claude-")));
  const transcript = join(repo, "t.jsonl");
  writeFileSync(transcript, SAMPLE.join("\n") + "\n");
  stop(repo, transcript, { SESSION_LOGS_CLAUDE_BIN: fake.bin });
  await new Promise((done) => setTimeout(done, 1500));
  assert.equal(existsSync(join(sessionLogsRoot(repo), "summaries")), false);
  assert.equal(existsSync(fake.promptFile), false);
});

test("with summaries enabled, a background worker writes a summary tied to its snapshot", async () => {
  const repo = tempRepo();
  writeConfig(repo, { summaries: { enabled: true } });
  const fake = fakeClaude(mkdtempSync(join(tmpdir(), "fake-claude-")));
  const transcript = join(repo, "t.jsonl");
  writeFileSync(transcript, SAMPLE.join("\n") + "\n");
  stop(repo, transcript, { SESSION_LOGS_CLAUDE_BIN: fake.bin });

  const index = JSON.parse(readFileSync(join(sessionLogsRoot(repo), "sessions", "s1.json"), "utf8"));
  const record = await waitFor(() => readSummary(repo, index.snapshot));
  assert.equal(record.summary, "- fake summary bullet");
  assert.equal(record.snapshot, index.snapshot);
  assert.equal(record.source_content_sha256, index.content_sha256);

  const prompt = readFileSync(fake.promptFile, "utf8");
  assert.match(prompt, /Decision: keep the cache in memory for now\./);
  assert.doesNotMatch(prompt, /INJECTED-CONTEXT-SHOULD-NOT-REACH-MODEL/);
});

test("the summarizer's own run is ignored by the Stop hook and never captured", () => {
  const repo = tempRepo();
  const transcript = join(repo, "t.jsonl");
  writeFileSync(transcript, SAMPLE.join("\n") + "\n");
  stop(repo, transcript, { [SUMMARIZING_ENV]: "1" });
  assert.equal(existsSync(sessionLogsRoot(repo)), false);
});

test("an existing summary is returned without calling the model", () => {
  const repo = tempRepo();
  const transcript = join(repo, "t.jsonl");
  writeFileSync(transcript, SAMPLE.join("\n") + "\n");
  const snapshot = snapshotTranscript(repo, "s1", transcript);
  const first = generateSummary(repo, snapshot, () => "first");
  const second = generateSummary(repo, snapshot, () => {
    throw new Error("model must not be called again");
  });
  assert.equal(second.summary, first.summary);
});

test("a transcript over the cap keeps its most recent messages and says so", () => {
  const big = "x".repeat(MAX_TRANSCRIPT_CHARS / 2 + 1000);
  const lines = [entry("user", "old", big), entry("assistant", "new", big)];
  const built = buildPrompt(lines);
  assert.equal(built.truncated, true);
  assert.match(built.prompt, /ASSISTANT: x/);
  assert.doesNotMatch(built.prompt, /USER: x/);
});

test("prune --apply removes a pruned session's summary; a dry run keeps it", () => {
  const repo = tempRepo();
  const transcript = join(repo, "t.jsonl");
  writeFileSync(transcript, SAMPLE.join("\n") + "\n");
  const snapshot = snapshotTranscript(repo, "s1", transcript);
  generateSummary(repo, snapshot, () => "kept until pruned");
  const later = { olderThanDays: 1, now: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000) };
  const file = join(sessionLogsRoot(repo), "summaries", `${snapshot}.json`);

  pruneSessions(repo, { ...later, apply: false, includeLinked: false });
  assert.equal(existsSync(file), true);

  pruneSessions(repo, { ...later, apply: true, includeLinked: false });
  assert.equal(existsSync(file), false);
});

test("a newest message larger than the cap is rejected before the model is called", () => {
  const repo = tempRepo();
  const transcript = join(repo, "t.jsonl");
  writeFileSync(transcript, entry("assistant", "huge", "y".repeat(MAX_TRANSCRIPT_CHARS + 10)) + "\n");
  const snapshot = snapshotTranscript(repo, "s1", transcript);
  assert.throws(
    () =>
      generateSummary(repo, snapshot, () => {
        throw new Error("model must not be called");
      }),
    /larger than the summary limit/,
  );
});

test("a failed claude run reports exit status only, never its stderr", () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-fail-"));
  const bin = join(dir, "fail.sh");
  writeFileSync(bin, "#!/bin/sh\necho 'TRANSCRIPT-SECRET-TEXT' >&2\nexit 3\n");
  chmodSync(bin, 0o755);
  const previous = process.env.SESSION_LOGS_CLAUDE_BIN;
  process.env.SESSION_LOGS_CLAUDE_BIN = bin;
  try {
    assert.throws(() => runClaudePrint("prompt"), (error: Error) => {
      assert.equal(error.message, "claude -p failed (exit 3)");
      assert.doesNotMatch(error.message, /TRANSCRIPT-SECRET-TEXT/);
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env.SESSION_LOGS_CLAUDE_BIN;
    else process.env.SESSION_LOGS_CLAUDE_BIN = previous;
  }
});

test("a snapshot whose summary is in progress is not generated twice and is kept by prune", () => {
  const repo = tempRepo();
  const transcript = join(repo, "t.jsonl");
  writeFileSync(transcript, SAMPLE.join("\n") + "\n");
  const snapshot = snapshotTranscript(repo, "s1", transcript);
  const release = tryLock(repo, snapshot);
  assert.ok(release, "first caller takes the lock");
  try {
    assert.throws(() => generateSummary(repo, snapshot, () => "second"), SummaryBusyError);
    const later = { olderThanDays: 1, now: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000) };
    assert.deepEqual(pruneSessions(repo, { ...later, apply: true, includeLinked: false }).sessions, []);
    assert.equal(existsSync(join(sessionLogsRoot(repo), "snapshots", `${snapshot}.json`)), true);
  } finally {
    release();
  }
  assert.equal(generateSummary(repo, snapshot, () => "after release").summary, "after release");
});
