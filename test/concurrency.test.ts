import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installHooks } from "../src/install/install.ts";
import { sessionLogsRoot } from "../src/capture/capture.ts";
import { doctor } from "../src/maintain/maintain.ts";

// Handoff test 10: two sessions working at the same time must not corrupt the store
// or lose each other's records. Stop hooks run as separate processes, as Claude Code runs them.

const TOOL_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const STOP = join(TOOL_ROOT, "src/hooks/stop.ts");

function runStop(repo: string, sessionId: string, transcript: string): Promise<number> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [STOP], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", fail);
    child.on("close", (code) => done(code ?? -1));
    child.stdin.end(JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: repo }));
  });
}

function runGit(repo: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((done) => {
    execFile("git", ["-C", repo, ...args], { encoding: "utf8" }, (error, _stdout, stderr) => {
      done({ code: error ? (error as { code?: number }).code ?? 1 : 0, stderr: stderr ?? "" });
    });
  });
}

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "session-logs-conc-"));
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
  installHooks({ repoRoot: repo, toolRoot: TOOL_ROOT });
  return repo;
}

test("parallel Stop hooks from several sessions leave a consistent store", async () => {
  const repo = setupRepo();
  const sessions = Array.from({ length: 8 }, (_, i) => {
    const transcript = join(repo, `s${i}.jsonl`);
    // Give each session a shared opening message as well as its own, so objects overlap.
    const lines = [
      JSON.stringify({ type: "user", uuid: "shared-0", text: "common opening" }),
      JSON.stringify({ type: "user", uuid: `own-${i}`, parentUuid: "shared-0", text: `session ${i} work` }),
    ];
    writeFileSync(transcript, lines.join("\n") + "\n");
    return { id: `conc-${i}`, transcript };
  });

  const codes = await Promise.all(sessions.map((s) => runStop(repo, s.id, s.transcript)));
  assert.ok(codes.every((c) => c === 0), `hook exit codes: ${codes}`);

  const root = sessionLogsRoot(repo);
  for (const s of sessions) {
    const index = JSON.parse(readFileSync(join(root, "sessions", `${s.id}.json`), "utf8"));
    assert.ok(existsSync(join(root, "snapshots", `${index.snapshot}.json`)), `missing snapshot for ${s.id}`);
    const active = JSON.parse(readFileSync(join(root, "active", `${s.id}.json`), "utf8"));
    assert.equal(active.session_id, s.id);
  }
  // No half-written temp files left behind.
  for (const dir of ["objects", "snapshots", "sessions", "active"]) {
    assert.deepEqual(readdirSync(join(root, dir)).filter((f) => f.includes(".tmp-")), []);
  }
  // Every stored object still matches its name, and no errors were logged.
  const findings = doctor(repo);
  assert.equal(findings.filter((f) => f.level === "error").length, 0, JSON.stringify(findings));
  assert.ok(!existsSync(join(root, "errors.log")), "hooks logged errors under concurrency");
  rmSync(repo, { recursive: true, force: true });
});

test("parallel commits: git serialises them, and retried commits all land with their links", async () => {
  const repo = setupRepo();
  const transcript = join(repo, "t.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "u1", text: "work" }) + "\n");
  writeFileSync(join(repo, "base.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "base.txt"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "Base"]);
  await runStop(repo, "conc-commit", transcript);

  const files = Array.from({ length: 4 }, (_, i) => `f${i}.txt`);
  for (const file of files) {
    writeFileSync(join(repo, file), file + "\n");
    execFileSync("git", ["-C", repo, "add", file]);
  }
  // Four commits of different files at once: each needs the index lock.
  // Git refuses concurrent writers rather than corrupting the index, so some attempts fail.
  // The check is that every failure is a lock failure and retrying lands every commit.
  const first = await Promise.all(files.map((file, i) => runGit(repo, ["commit", "-q", "-m", `Change ${i}`, "--", file])));
  for (const result of first) {
    if (result.code !== 0) {
      assert.match(result.stderr, /index\.lock|Unable to create/, `unexpected failure: ${result.stderr}`);
    }
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const pending = files.filter((file) => {
      const subject = execFileSync("git", ["-C", repo, "log", "--format=%s", "--all"], { encoding: "utf8" });
      return !subject.includes(`Change ${files.indexOf(file)}`);
    });
    if (pending.length === 0) break;
    for (const file of pending) {
      await runGit(repo, ["commit", "-q", "-m", `Change ${files.indexOf(file)}`, "--", file]);
    }
  }

  const log = execFileSync("git", ["-C", repo, "log", "--format=%B%x1e"], { encoding: "utf8" });
  const messages = log.split("\x1e").filter((m) => m.includes("Change "));
  assert.equal(messages.length, files.length, "every commit should land");
  // Under the fallback window a commit links at most one session, and never duplicates.
  // Commits made during an open turn are covered in git-ops tests.
  for (const message of messages) {
    assert.ok((message.match(/^Session: /gm)?.length ?? 0) <= 1, `at most one session per commit: ${message}`);
    assert.ok((message.match(/^Transcript: /gm)?.length ?? 0) <= 1, `at most one transcript per commit: ${message}`);
  }
  assert.equal(existsSync(join(repo, ".git", "index.lock")), false, "no stale index lock");
  rmSync(repo, { recursive: true, force: true });
});
