// Installs session-logs into one repository (opt-in, D11/D21/D32).
//
// Git hooks: a repo-local core.hooksPath shadows the user's global hooks, so
// installation points core.hooksPath at managed shims under .session-logs/git-hooks.
// Each shim first runs the matching global hook (which already chains Husky and
// the repo's .git/hooks for pre-commit and post-commit), then session-logs.
// prepare-commit-msg has no global counterpart, so the repo's own hook is chained
// directly. Installation refuses to replace a repo-local core.hooksPath it did
// not set, because that would silently disable Husky or similar tooling.
//
// Claude Code: Stop and UserPromptSubmit hooks are registered in
// .claude/settings.local.json (per developer, not committed).

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface InstallOptions {
  repoRoot: string;
  // Absolute path to this package (the directory containing src/).
  toolRoot: string;
  // Global core.hooksPath, if the user has one. Undefined means no global chain.
  globalHooksPath?: string;
}

export interface InstallResult {
  hooksPath: string;
  shims: string[];
  settingsFile: string;
}

// Hooks session-logs manages. `ours` is the session-logs script run after the
// chained hooks. `stdin` hooks get their input buffered, because a chained hook would
// otherwise consume it. `repoChain` also runs the repository's own hook of that name.
interface HookSpec {
  ours?: string;
  stdin?: boolean;
  repoChain?: boolean;
}

export const HOOK_SPECS: Record<string, HookSpec> = {
  "pre-commit": {},
  "commit-msg": {},
  "post-commit": { ours: "src/hooks/post-commit.ts" },
  "post-rewrite": { ours: "src/hooks/post-rewrite.ts", stdin: true },
  "prepare-commit-msg": { ours: "src/hooks/prepare-commit-msg.ts", repoChain: true },
};

const GIT_HOOK_NAMES = Object.keys(HOOK_SPECS);

function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function git(repoRoot: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

export function shimBody(
  name: string,
  repoGitHooks: string,
  globalHooksPath: string | undefined,
  toolRoot: string,
): string {
  const spec = HOOK_SPECS[name];
  if (!spec) {
    throw new Error(`no hook spec for ${name}`);
  }
  const lines = ["#!/bin/sh", "# Managed by session-logs. Chains global and repository hooks, then session-logs."];
  if (spec.stdin) {
    lines.push(
      `in=$(mktemp "\${TMPDIR:-/tmp}/session-logs-stdin.XXXXXX") || exit 1`,
      `trap 'rm -f "$in"' EXIT`,
      `cat > "$in"`,
    );
  }
  const run = (path: string) => (spec.stdin ? `"${path}" "$@" < "$in"` : `"${path}" "$@"`);
  if (globalHooksPath) {
    lines.push(`g=${sh(join(globalHooksPath, name))}`, `[ -x "$g" ] && { ${run("$g")} || exit $?; }`);
  }
  if (spec.repoChain || !globalHooksPath) {
    lines.push(`r=${sh(join(repoGitHooks, name))}`, `[ -x "$r" ] && { ${run("$r")} || exit $?; }`);
  }
  if (spec.ours) {
    const script = sh(join(toolRoot, spec.ours));
    if (name === "prepare-commit-msg") {
      // Must not fail the commit; the script always exits 0 itself.
      lines.push(`exec node ${script} "$@"`);
    } else {
      // Post hooks cannot block; their failures are ignored.
      lines.push(spec.stdin ? `node ${script} "$@" < "$in" || true` : `node ${script} "$@" || true`);
    }
  }
  lines.push("exit 0", "");
  return lines.join("\n");
}

function ensureLine(path: string, line: string): void {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (!current.split("\n").includes(line)) {
    const prefix = current.length === 0 || current.endsWith("\n") ? current : current + "\n";
    writeFileSync(path, prefix + line + "\n");
  }
}

function registerHook(settingsFile: string, toolRoot: string, event: string, script: string): void {
  mkdirSync(dirname(settingsFile), { recursive: true });
  const settings = existsSync(settingsFile)
    ? (JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>)
    : {};
  const hooks = (settings.hooks ?? {}) as Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
  const command = `node ${sh(join(toolRoot, script))}`;
  const groups = hooks[event] ?? [];
  const already = groups.some((group) => group.hooks.some((hook) => hook.command === command));
  if (!already) {
    groups.push({ hooks: [{ type: "command", command }] });
  }
  hooks[event] = groups;
  settings.hooks = hooks;
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
}

export function installHooks(options: InstallOptions): InstallResult {
  const repoRoot = resolve(options.repoRoot);
  const toolRoot = resolve(options.toolRoot);

  const existingHooksPath = git(repoRoot, ["config", "--local", "--get", "core.hooksPath"]);
  const ourHooksDir = join(repoRoot, ".session-logs", "git-hooks");
  if (existingHooksPath && resolve(repoRoot, existingHooksPath) !== resolve(ourHooksDir)) {
    throw new Error(
      `repository already sets core.hooksPath to ${existingHooksPath}; refusing to replace it`,
    );
  }

  // --git-path hooks would honour core.hooksPath (possibly the global one), so
  // resolve the common git directory instead.
  const gitCommonDir = resolve(repoRoot, git(repoRoot, ["rev-parse", "--git-common-dir"]) ?? ".git");
  const repoGitHooks = join(gitCommonDir, "hooks");
  mkdirSync(ourHooksDir, { recursive: true });
  const shims: string[] = [];
  for (const name of GIT_HOOK_NAMES) {
    const path = join(ourHooksDir, name);
    writeFileSync(path, shimBody(name, repoGitHooks, options.globalHooksPath, toolRoot));
    chmodSync(path, 0o755);
    shims.push(path);
  }
  execFileSync("git", ["-C", repoRoot, "config", "--local", "core.hooksPath", ourHooksDir]);

  ensureLine(join(repoRoot, ".gitignore"), ".session-logs/");
  ensureLine(join(repoRoot, ".gitignore"), ".claude/settings.local.json");

  const settingsFile = join(repoRoot, ".claude", "settings.local.json");
  registerHook(settingsFile, toolRoot, "Stop", "src/hooks/stop.ts");
  registerHook(settingsFile, toolRoot, "UserPromptSubmit", "src/hooks/user-prompt-submit.ts");

  return { hooksPath: ourHooksDir, shims, settingsFile };
}
