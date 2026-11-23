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
// Claude Code: a Stop hook is registered in .claude/settings.local.json (per
// developer, not committed).

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

const GIT_HOOK_NAMES = ["pre-commit", "commit-msg", "post-commit", "prepare-commit-msg"] as const;

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
  name: (typeof GIT_HOOK_NAMES)[number],
  repoGitHooks: string,
  globalHooksPath: string | undefined,
  toolRoot: string,
): string {
  const lines = ["#!/bin/sh", "# Managed by session-logs. Chains global and repository hooks, then session-logs."];
  if (globalHooksPath) {
    lines.push(`g=${sh(join(globalHooksPath, name))}`, `[ -x "$g" ] && { "$g" "$@" || exit $?; }`);
  }
  if (name === "prepare-commit-msg") {
    lines.push(`r=${sh(join(repoGitHooks, name))}`, `[ -x "$r" ] && { "$r" "$@" || exit $?; }`);
    lines.push(`exec node ${sh(join(toolRoot, "src/hooks/prepare-commit-msg.ts"))} "$@"`);
  } else if (!globalHooksPath) {
    lines.push(`r=${sh(join(repoGitHooks, name))}`, `[ -x "$r" ] && { "$r" "$@" || exit $?; }`);
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

function registerStopHook(settingsFile: string, toolRoot: string): void {
  mkdirSync(dirname(settingsFile), { recursive: true });
  const settings = existsSync(settingsFile)
    ? (JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>)
    : {};
  const hooks = (settings.hooks ?? {}) as Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
  const command = `node ${sh(join(toolRoot, "src/hooks/stop.ts"))}`;
  const stop = hooks.Stop ?? [];
  const already = stop.some((group) => group.hooks.some((hook) => hook.command === command));
  if (!already) {
    stop.push({ hooks: [{ type: "command", command }] });
  }
  hooks.Stop = stop;
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
  registerStopHook(settingsFile, toolRoot);

  return { hooksPath: ourHooksDir, shims, settingsFile };
}
