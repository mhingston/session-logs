// Live check for two open M0 items. Run this in YOUR terminal: it needs api.anthropic.com.
//   1. Does a Stop hook's stderr reach the user? (marker printed to stderr by the probe)
//   2. Does a forked session emit SessionStart with source "resume" or "fork"?
// Output: a fresh repo with probe hooks, the captured payloads (field names and
// source values only), and a summary. Nothing is sent anywhere except to Claude.
// Usage: node scripts/live-check.ts [outputDir]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hookCommandPath } from "../src/install/install.ts";
import { runClaudeCli } from "../src/summaries/summaries.ts";

const TOOL = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = resolve(process.argv[2] ?? join(homedir(), "Downloads", `live-check-${stamp}`));
const PROBE = join(OUT, "probe");
const REPO = join(OUT, "repo");
const MARKER = "PROBE_STOP_STDERR_MARKER";

// Plain JavaScript, so it runs without any type-stripping setup.
const PROBE_SCRIPT = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
const [dir, name, marker] = process.argv.slice(2);
let data = "";
process.stdin.on("data", (chunk) => (data += chunk));
process.stdin.on("end", () => {
  writeFileSync(join(dir, \`\${Date.now()}-\${process.pid}-\${name}.json\`), data);
  if (marker) process.stderr.write(marker + "\\n");
});
`;

function probeCommand(name: string, marker = ""): string {
  const script = join(PROBE, "hook.mjs");
  return `node ${hookCommandPath(script)} ${hookCommandPath(PROBE)} ${name}${marker ? ` ${marker}` : ""}`;
}

function payloads(name: string): Array<Record<string, unknown>> {
  return readdirSync(PROBE)
    .filter((file) => file.endsWith(`-${name}.json`))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(PROBE, file), "utf8")) as Record<string, unknown>);
}

function runClaude(args: string[], name: string): string | undefined {
  try {
    const stdout = runClaudeCli("claude", args, { cwd: REPO });
    writeFileSync(join(OUT, `${name}.stdout`), stdout);
    writeFileSync(join(OUT, `${name}.stderr`), "");
    return stdout;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    writeFileSync(join(OUT, `${name}.stdout`), failure.stdout ?? "");
    writeFileSync(join(OUT, `${name}.stderr`), failure.stderr ?? String(error));
    return undefined;
  }
}

function git(args: string[]): void {
  execFileSync("git", ["-C", REPO, ...args], { stdio: "ignore" });
}

mkdirSync(REPO, { recursive: true });
mkdirSync(PROBE, { recursive: true });
writeFileSync(join(PROBE, "hook.mjs"), PROBE_SCRIPT);
git(["init", "-q", "-b", "main", "."]);
git(["config", "user.name", "live-check"]);
git(["config", "user.email", "live-check@example.invalid"]);
execFileSync(process.execPath, [join(TOOL, "dist/cli/init.js")], { cwd: REPO, stdio: "ignore" });

// Add probe hooks next to the session-logs hooks, without removing them.
const settingsPath = join(REPO, ".claude", "settings.local.json");
const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
  hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
};
const addProbe = (event: string, command: string) => {
  (settings.hooks[event] ??= []).push({ hooks: [{ type: "command", command }] });
};
addProbe("SessionStart", probeCommand("sessionstart"));
addProbe("Stop", probeCommand("stop", MARKER));
addProbe("UserPromptSubmit", probeCommand("prompt"));
writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

console.log("== run 1: new session");
runClaude(["-p", "Reply OK."], "run1");

const sessionStart = payloads("sessionstart");
const sessionId = sessionStart[0]?.session_id;
if (typeof sessionId !== "string") {
  console.log(`No SessionStart payload captured. Check ${join(OUT, "run1.stderr")}`);
  process.exit(1);
}

console.log(`== run 2: fork of session ${sessionId}`);
runClaude(["-p", "--resume", sessionId, "--fork-session", "Reply OK."], "fork");

const keys = (rows: Array<Record<string, unknown>>) => rows.map((row) => Object.keys(row).sort());
console.log("\n== SessionStart payloads (field names and source only)");
for (const row of payloads("sessionstart")) {
  console.log(`  source=${JSON.stringify(row.source)} session_id=${JSON.stringify(row.session_id)} keys=${JSON.stringify(Object.keys(row).sort())}`);
}
console.log("\n== UserPromptSubmit payloads (field names only)");
for (const keyList of keys(payloads("prompt"))) console.log(`  keys=${JSON.stringify(keyList)}`);
console.log("\n== Stop payloads (field names only)");
for (const keyList of keys(payloads("stop"))) console.log(`  keys=${JSON.stringify(keyList)}`);
console.log("\n== Stop stderr visibility");
for (const name of ["run1", "fork"]) {
  const stderr = readFileSync(join(OUT, `${name}.stderr`), "utf8");
  const stdout = readFileSync(join(OUT, `${name}.stdout`), "utf8");
  console.log(`  ${name}: marker in claude stderr=${stderr.includes(MARKER)}, in stdout=${stdout.includes(MARKER)}`);
}
console.log("\nFor the user-visible check, run an interactive `claude` in the repo and watch for the marker in the UI.");
console.log(`Output in: ${OUT}`);
