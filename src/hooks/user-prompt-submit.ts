// Claude Code UserPromptSubmit hook. Marks a turn as open for this session so commits
// made during the turn link to it (D50). Always exits 0; errors go to errors.log.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { recordTurnOpen, sessionLogsRoot } from "../capture/capture.ts";

interface PromptInput {
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
  try {
    const root = sessionLogsRoot(repoRoot);
    mkdirSync(root, { recursive: true });
    appendFileSync(join(root, "errors.log"), `${new Date().toISOString()} user-prompt-submit: ${message}\n`);
  } catch {
    // Logging must not fail the hook.
  }
}

function main(): void {
  let repoRoot = resolveRepoRoot(process.cwd());
  try {
    const input = JSON.parse(readFileSync(0, "utf8")) as PromptInput;
    if (input.cwd) {
      repoRoot = resolveRepoRoot(input.cwd);
    }
    if (!input.session_id || !input.transcript_path) {
      throw new Error("hook input missing session_id or transcript_path");
    }
    recordTurnOpen(repoRoot, { session_id: input.session_id, transcript_path: input.transcript_path });
  } catch (error) {
    logError(repoRoot, error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 0;
}

main();
