// `init`: installs session-logs into the current git repository (opt-in).
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installHooks } from "../install/install.ts";

function git(args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

const repoRoot = git(["rev-parse", "--show-toplevel"]);
if (!repoRoot) {
  console.error("session-logs init: not inside a git repository");
  process.exitCode = 1;
} else {
  const toolRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const globalHooksPath = git(["config", "--global", "--type=path", "--get", "core.hooksPath"]);
  try {
    const result = installHooks({ repoRoot, toolRoot, globalHooksPath });
    console.log(`Hooks: ${result.hooksPath}`);
    console.log(`Stop hook registered in: ${result.settingsFile}`);
    console.log(globalHooksPath ? `Chaining global hooks from: ${globalHooksPath}` : "No global core.hooksPath set.");
  } catch (error) {
    console.error(`session-logs init: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
