// Background summary worker, started detached by the Stop hook (see spawnBackgroundSummary).
// Usage: worker.ts <repoRoot> <snapshot>. Failures are appended to errors.log as error
// text only, never transcript content.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sessionLogsRoot } from "../capture/capture.ts";
import { describeError, pushIfLinked } from "../remote/remote.ts";
import { generateSummary, SummaryBusyError } from "./summaries.ts";

function logError(repoRoot: string, message: string): void {
  try {
    const root = sessionLogsRoot(repoRoot);
    mkdirSync(root, { recursive: true });
    appendFileSync(join(root, "errors.log"), `${new Date().toISOString()} summarize: ${message}\n`);
  } catch {
    // Logging must not fail the worker.
  }
}

async function main(): Promise<void> {
  const [repoRoot, snapshot] = process.argv.slice(2);
  if (!repoRoot || !snapshot) {
    process.exitCode = 2;
    return;
  }
  try {
    generateSummary(repoRoot, snapshot);
  } catch (error) {
    // Another caller is already generating this summary; nothing to report.
    if (error instanceof SummaryBusyError) return;
    logError(repoRoot, error instanceof Error ? error.message : String(error));
    return;
  }
  try {
    await pushIfLinked(repoRoot, snapshot);
  } catch (error) {
    logError(repoRoot, `remote: ${describeError(error)}`);
  }
}

main().catch(() => {
  process.exitCode = 0;
});
