// Background summary worker, started detached by the Stop hook (see spawnBackgroundSummary).
// Usage: worker.ts <repoRoot> <snapshot>. Failures are appended to errors.log as error
// text only, never transcript content.
import { appendFileSync, closeSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { sessionLogsRoot } from "../capture/capture.ts";
import { generateSummary, lockPath } from "./summaries.ts";

// A lock older than this belongs to a worker that died, so it is taken over.
const LOCK_STALE_MS = 15 * 60 * 1000;

// Atomic lock file. Returns false when another worker holds the snapshot's lock, so the
// same snapshot is never sent to the model twice at once.
function takeLock(path: string): boolean {
  mkdirSync(dirname(path), { recursive: true });
  try {
    closeSync(openSync(path, "wx"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (Date.now() - statSync(path).mtimeMs < LOCK_STALE_MS) return false;
    rmSync(path, { force: true });
    try {
      closeSync(openSync(path, "wx"));
      return true;
    } catch {
      return false;
    }
  }
}

function logError(repoRoot: string, message: string): void {
  try {
    const root = sessionLogsRoot(repoRoot);
    mkdirSync(root, { recursive: true });
    appendFileSync(join(root, "errors.log"), `${new Date().toISOString()} summarize: ${message}\n`);
  } catch {
    // Logging must not fail the worker.
  }
}

function main(): void {
  const [repoRoot, snapshot] = process.argv.slice(2);
  if (!repoRoot || !snapshot) {
    process.exitCode = 2;
    return;
  }
  const lock = lockPath(repoRoot, snapshot);
  try {
    if (!takeLock(lock)) return;
    try {
      generateSummary(repoRoot, snapshot);
    } finally {
      rmSync(lock, { force: true });
    }
  } catch (error) {
    logError(repoRoot, error instanceof Error ? error.message : String(error));
  }
}

main();
