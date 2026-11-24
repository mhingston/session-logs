// Claude Code Stop hook. Records the current session and snapshots its
// transcript. Always exits 0: a capture failure must never make Claude Code
// keep running (exit 2 on Stop would continue the conversation).
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { recordActiveSession, sessionLogsRoot, snapshotTranscript } from "../capture/capture.ts";
import { decisionsEnabled, generateDecisions } from "../decisions/decisions.ts";
import { spawnBackgroundSummary, summariesEnabled, SUMMARIZING_ENV } from "../summaries/summaries.ts";

interface StopInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
}

function resolveRepoRoot(cwd: string): string {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || cwd;
  } catch {
    return cwd;
  }
}

function logError(repoRoot: string, message: string): void {
  // Error text only: never transcript content.
  try {
    const root = sessionLogsRoot(repoRoot);
    mkdirSync(root, { recursive: true });
    appendFileSync(join(root, "errors.log"), `${new Date().toISOString()} stop: ${message}\n`);
  } catch {
    // Logging must not fail the hook.
  }
}

function main(): void {
  // Skip the summarizer's own headless run (see src/summaries/summaries.ts), so it is
  // never captured or summarized.
  if (process.env[SUMMARIZING_ENV] === "1") return;
  let repoRoot = resolveRepoRoot(process.cwd());
  let snapshot: string | undefined;
  try {
    const input = JSON.parse(readFileSync(0, "utf8")) as StopInput;
    if (input.cwd) {
      repoRoot = resolveRepoRoot(input.cwd);
    }
    if (!input.session_id || !input.transcript_path) {
      throw new Error("hook input missing session_id or transcript_path");
    }
    snapshot = snapshotTranscript(repoRoot, input.session_id, input.transcript_path);
    recordActiveSession(repoRoot, {
      session_id: input.session_id,
      transcript_path: input.transcript_path,
    });
  } catch (error) {
    logError(repoRoot, error instanceof Error ? error.message : String(error));
  }
  // Decision extraction is a separate opt-in layer (D21): it runs only when the
  // repository enables it, and a failure here never affects the capture above.
  if (snapshot !== undefined) {
    try {
      if (decisionsEnabled(repoRoot)) {
        generateDecisions(repoRoot, snapshot);
      }
    } catch (error) {
      logError(repoRoot, `decisions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Summaries are opt-in (P1) and run in a detached worker so the hook returns at once.
  if (snapshot !== undefined) {
    try {
      if (summariesEnabled(repoRoot)) {
        spawnBackgroundSummary(repoRoot, snapshot);
      }
    } catch (error) {
      logError(repoRoot, `summaries: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  process.exitCode = 0;
}

main();
