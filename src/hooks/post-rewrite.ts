// Git post-rewrite hook (amend, rebase): refreshes the session note for each rewritten
// commit from its trailers (D53). stdin: "<old> <new> [extra]" per line. Always exits 0.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sessionLogsRoot } from "../capture/capture.ts";
import { syncNote } from "../notes/notes.ts";

function main(): void {
  let repoRoot = process.cwd();
  try {
    repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const pairs = readFileSync(0, "utf8").split("\n").filter(Boolean);
    for (const line of pairs) {
      const newSha = line.split(" ")[1];
      if (newSha) syncNote(repoRoot, newSha);
    }
  } catch (error) {
    try {
      const root = sessionLogsRoot(repoRoot);
      mkdirSync(root, { recursive: true });
      appendFileSync(join(root, "errors.log"), `${new Date().toISOString()} post-rewrite: ${error instanceof Error ? error.message : String(error)}\n`);
    } catch {
      // Logging must not fail the hook.
    }
  }
  process.exitCode = 0;
}

main();
