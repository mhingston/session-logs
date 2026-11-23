// Git prepare-commit-msg hook. Takes a snapshot of the current session's
// transcript and adds Session and Transcript trailers (D4). Always exits 0:
// a failed snapshot must not block the developer's commit (test 11).
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  readCurrentSession,
  sessionLogsRoot,
  snapshotTranscript,
} from "../capture/capture.ts";

function repoTop(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

function logError(repoRoot: string, message: string): void {
  try {
    const root = sessionLogsRoot(repoRoot);
    mkdirSync(root, { recursive: true });
    appendFileSync(join(root, "errors.log"), `${new Date().toISOString()} prepare-commit-msg: ${message}\n`);
  } catch {
    // Logging must not fail the hook.
  }
}

function main(): void {
  const messageFile = process.argv[2];
  let repoRoot = process.cwd();
  try {
    repoRoot = repoTop();
    if (!messageFile) {
      throw new Error("no commit message file argument");
    }
    const current = readCurrentSession(repoRoot);
    if (!current) {
      return; // No session recorded: nothing to link.
    }
    const snapshot = snapshotTranscript(repoRoot, current.session_id, current.transcript_path);
    // --if-exists replace keeps one Session and one Transcript line, so
    // amend does not duplicate them.
    execFileSync(
      "git",
      [
        "interpret-trailers",
        "--in-place",
        "--if-exists",
        "replace",
        "--trailer",
        `Session: ${current.session_id}`,
        "--trailer",
        `Transcript: ${snapshot}`,
        messageFile,
      ],
      { stdio: "ignore" },
    );
  } catch (error) {
    logError(repoRoot, error instanceof Error ? error.message : String(error));
    process.stderr.write("session-logs: could not link this commit to a session (see .session-logs/errors.log)\n");
  }
  process.exitCode = 0;
}

main();
