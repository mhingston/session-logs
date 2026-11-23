// Git post-commit hook: records the session note for HEAD (D53). Always exits 0.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sessionLogsRoot } from "../capture/capture.ts";
import { syncNote } from "../notes/notes.ts";

function main(): void {
  let repoRoot = process.cwd();
  try {
    repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    syncNote(repoRoot, "HEAD");
  } catch (error) {
    try {
      const root = sessionLogsRoot(repoRoot);
      mkdirSync(root, { recursive: true });
      appendFileSync(join(root, "errors.log"), `${new Date().toISOString()} post-commit: ${error instanceof Error ? error.message : String(error)}\n`);
    } catch {
      // Logging must not fail the hook.
    }
  }
  process.exitCode = 0;
}

main();
