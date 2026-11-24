import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hookCommandPath, installHooks } from "../src/install/install.ts";

const TOOL_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

function git(repo: string, args: string[], extra: string[] = []): string {
  return execFileSync("git", ["-C", repo, ...extra, ...args], { encoding: "utf8" });
}

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "session-logs-install-"));
  execFileSync("git", ["init", "-q", dir]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  return dir;
}

function hookScript(body: string): string {
  return `#!/bin/sh\n${body}\n`;
}

function writeHook(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, hookScript(body));
  chmodSync(path, 0o755);
}

test("install points core.hooksPath at managed shims and registers the Stop hook", () => {
  const repo = tempRepo();
  const result = installHooks({ repoRoot: repo, toolRoot: TOOL_ROOT });
  assert.equal(git(repo, ["config", "--local", "--get", "core.hooksPath"]).trim(), result.hooksPath);
  for (const name of ["pre-commit", "commit-msg", "post-commit", "prepare-commit-msg"]) {
    assert.ok(existsSync(join(result.hooksPath, name)), `missing shim ${name}`);
  }
  const settings = JSON.parse(readFileSync(result.settingsFile, "utf8"));
  assert.equal(settings.hooks.Stop[0].hooks[0].type, "command");
  assert.match(settings.hooks.Stop[0].hooks[0].command, /src\/hooks\/stop\.ts/);
  assert.match(settings.hooks.UserPromptSubmit[0].hooks[0].command, /src\/hooks\/user-prompt-submit\.ts/);
  const gitignore = readFileSync(join(repo, ".gitignore"), "utf8");
  assert.match(gitignore, /^\.session-logs\/$/m);
  assert.match(gitignore, /^\.claude\/settings\.local\.json$/m);
});

test("install is idempotent: one Stop hook and one gitignore line each", () => {
  const repo = tempRepo();
  installHooks({ repoRoot: repo, toolRoot: TOOL_ROOT });
  const second = installHooks({ repoRoot: repo, toolRoot: TOOL_ROOT });
  const settings = JSON.parse(readFileSync(second.settingsFile, "utf8"));
  assert.equal(settings.hooks.Stop.length, 1);
  const gitignore = readFileSync(join(repo, ".gitignore"), "utf8");
  assert.equal(gitignore.split("\n").filter((l) => l === ".session-logs/").length, 1);
});

test("re-running init from a moved toolRoot replaces stale hook entries without duplicating", () => {
  const repo = tempRepo();
  installHooks({ repoRoot: repo, toolRoot: "/old/checkout/session-logs" });
  const moved = installHooks({ repoRoot: repo, toolRoot: TOOL_ROOT });
  const settings = JSON.parse(readFileSync(moved.settingsFile, "utf8"));
  assert.equal(settings.hooks.Stop.length, 1);
  assert.equal(settings.hooks.UserPromptSubmit.length, 1);
  assert.ok(settings.hooks.Stop[0].hooks[0].command.includes(TOOL_ROOT));
  assert.ok(!settings.hooks.Stop[0].hooks[0].command.includes("/old/checkout/session-logs"));
});

test("install refuses to replace a repo-local core.hooksPath it did not set", () => {
  const repo = tempRepo();
  git(repo, ["config", "--local", "core.hooksPath", ".husky/_"]);
  assert.throws(() => installHooks({ repoRoot: repo, toolRoot: TOOL_ROOT }), /refusing to replace/);
  assert.equal(git(repo, ["config", "--local", "--get", "core.hooksPath"]).trim(), ".husky/_");
});

test("a commit runs the chained global pre-commit hook and links the session", () => {
  const repo = tempRepo();
  const globalDir = mkdtempSync(join(tmpdir(), "session-logs-global-"));
  const marker = join(globalDir, "ran.txt");
  writeHook(globalDir, "pre-commit", `echo global >> ${marker}`);
  installHooks({ repoRoot: repo, toolRoot: TOOL_ROOT, globalHooksPath: globalDir });

  // Record a session the way the Stop hook would.
  const transcript = join(repo, "t.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "user", text: "hello" }) + "\n");
  const stop = spawnSync(process.execPath, [join(TOOL_ROOT, "src/hooks/stop.ts")], {
    input: JSON.stringify({ session_id: "install-s1", transcript_path: transcript, cwd: repo }),
    encoding: "utf8",
  });
  assert.equal(stop.status, 0);

  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, ["add", "a.txt"]);
  git(repo, ["commit", "-q", "-m", "Linked change"]);

  assert.equal(readFileSync(marker, "utf8").trim(), "global");
  const message = git(repo, ["log", "-1", "--format=%B"]);
  assert.match(message, /^Session: install-s1$/m);
  assert.match(message, /^Transcript: [0-9a-f]{64}$/m);
});

test("a failing global pre-commit hook blocks the commit", () => {
  const repo = tempRepo();
  const globalDir = mkdtempSync(join(tmpdir(), "session-logs-global-"));
  writeHook(globalDir, "pre-commit", "exit 1");
  installHooks({ repoRoot: repo, toolRoot: TOOL_ROOT, globalHooksPath: globalDir });
  writeFileSync(join(repo, "b.txt"), "b\n");
  git(repo, ["add", "b.txt"]);
  const result = spawnSync("git", ["-C", repo, "commit", "-q", "-m", "Should be blocked"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
});

test("the repository's own prepare-commit-msg hook is chained when there is no global counterpart", () => {
  const repo = tempRepo();
  const repoHooks = join(repo, ".git", "hooks");
  writeHook(repoHooks, "prepare-commit-msg", `echo repo-hook >> "$1"`);
  installHooks({ repoRoot: repo, toolRoot: TOOL_ROOT });
  writeFileSync(join(repo, "c.txt"), "c\n");
  git(repo, ["add", "c.txt"]);
  git(repo, ["commit", "-q", "-m", "Chained"]);
  assert.match(git(repo, ["log", "-1", "--format=%B"]), /^repo-hook$/m);
});

test("hook command paths quote for POSIX shells and for Windows shells", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const withPlatform = (value: string, fn: () => void) => {
    Object.defineProperty(process, "platform", { value });
    try {
      fn();
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  };
  withPlatform("darwin", () => assert.equal(hookCommandPath("/a b/x.ts"), "'/a b/x.ts'"));
  withPlatform("win32", () => {
    assert.equal(hookCommandPath("C:\\Users\\me\\session logs\\src\\x.ts"), '"C:/Users/me/session logs/src/x.ts"');
    assert.throws(() => hookCommandPath("C:\\a%PATH%\\x.ts"), /Windows hook command/);
  });
});
