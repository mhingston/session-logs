// Git post-commit hook: records the session note for HEAD (D53) and pushes the linked
// snapshots when remote storage is enabled. Always exits 0.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sessionLogsRoot } from "../capture/capture.ts";
import { syncNote } from "../notes/notes.ts";
import { pushCommit } from "../remote/remote.ts";

function logLine(repoRoot: string, message: string): void {
  try {
    const root = sessionLogsRoot(repoRoot);
    mkdirSync(root, { recursive: true });
    appendFileSync(join(root, "errors.log"), `${new Date().toISOString()} post-commit: ${message}\n`);
  } catch {
    // Logging must not fail the hook.
  }
}

async function main(): Promise<void> {
  let repoRoot = process.cwd();
  try {
    repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    syncNote(repoRoot, "HEAD");
  } catch (error) {
    logLine(repoRoot, error instanceof Error ? error.message : String(error));
  }
  try {
    const report = await pushCommit(repoRoot, "HEAD");
    for (const skipped of report?.skipped ?? []) {
      logLine(repoRoot, `remote: ${skipped.snapshot} not pushed: ${skipped.reason}`);
    }
  } catch (error) {
    logLine(repoRoot, `remote: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 0;
}

main().catch(() => {
  process.exitCode = 0;
});
