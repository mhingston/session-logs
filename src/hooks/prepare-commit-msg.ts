// Git prepare-commit-msg hook. Links the commit to sessions (D4, D36, handoff §6):
//   Session / Transcript   ordered pairs; the primary is the most recent session
//                          that stopped since the previous commit
//   Also-Active            other sessions that stopped in that window
//   Reverts                set by `git revert` (from the generated message)
// Cherry-pick and rebase replay existing commits, so they keep their trailers and
// are never linked to a new session.
// Always exits 0: a failed snapshot must not block the developer's commit (test 11).
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { candidateSessions, sessionLogsRoot, snapshotTranscript } from "../capture/capture.ts";
import { extractTrailers, linkPrimary, union, type Pair } from "../capture/trailers.ts";

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function logError(repoRoot: string, message: string): void {
  try {
    const root = sessionLogsRoot(repoRoot);
    mkdirSync(root, { recursive: true });
    appendFileSync(join(root, "errors.log"), `${new Date().toISOString()} prepare-commit-msg: ${message}\n`);
  } catch {
    // Logging must not fail the hook.
  }
}

function main(): void {
  const messageFile = process.argv[2];
  const repoRoot = git(process.cwd(), ["rev-parse", "--show-toplevel"]) ?? process.cwd();
  try {
    if (!messageFile) {
      throw new Error("no commit message file argument");
    }
    const gitDir = resolve(repoRoot, git(repoRoot, ["rev-parse", "--git-dir"]) ?? ".git");
    const replaying =
      existsSync(join(gitDir, "CHERRY_PICK_HEAD")) ||
      existsSync(join(gitDir, "rebase-merge")) ||
      existsSync(join(gitDir, "rebase-apply"));
    if (replaying) {
      return; // Existing trailers are kept as they are.
    }

    const existing = extractTrailers(readFileSync(messageFile, "utf8").split("\n"));

    // Window: sessions that stopped after the previous commit. On the first
    // commit there is no previous commit, so only the latest session is used.
    const previousCommitTime = git(repoRoot, ["log", "-1", "--format=%cI", "HEAD"]);
    const candidates = candidateSessions(repoRoot, previousCommitTime);
    const [first, ...others] = candidates;
    const primary: Pair | undefined = first
      ? { session: first.session_id, snapshot: snapshotTranscript(repoRoot, first.session_id, first.transcript_path) }
      : undefined;

    // git removes REVERT_HEAD before this hook runs, so take the reverted commit
    // from the message git generates for a revert.
    const revertedSha = existing.body.join("\n").match(/^This reverts commit ([0-9a-f]{40})\./m)?.[1];

    if (!primary && others.length === 0 && !revertedSha) {
      return; // Nothing to add; the message stays exactly as it was.
    }

    const pairs = linkPrimary(existing.pairs, primary);
    const alsoActive = union(existing.alsoActive, others.map((s) => s.session_id));
    const reverts = revertedSha ? union(existing.reverts, [revertedSha]) : existing.reverts;

    writeFileSync(messageFile, existing.body.join("\n"));
    const trailers = (pair: Pair) => [
      "--trailer", `Session: ${pair.session}`,
      "--trailer", `Transcript: ${pair.snapshot ?? ""}`,
    ];
    execFileSync(
      "git",
      ["interpret-trailers", "--in-place", "--if-exists", "add", ...pairs.flatMap(trailers), messageFile],
      { stdio: "ignore" },
    );
    const sets = [
      ...alsoActive.flatMap((session) => ["--trailer", `Also-Active: ${session}`]),
      ...reverts.flatMap((sha) => ["--trailer", `Reverts: ${sha}`]),
    ];
    if (sets.length > 0) {
      execFileSync("git", ["interpret-trailers", "--in-place", "--if-exists", "addIfDifferent", ...sets, messageFile], {
        stdio: "ignore",
      });
    }
  } catch (error) {
    logError(repoRoot, error instanceof Error ? error.message : String(error));
    process.stderr.write("session-logs: could not link this commit to a session (see .session-logs/errors.log)\n");
  }
  process.exitCode = 0;
}

main();
