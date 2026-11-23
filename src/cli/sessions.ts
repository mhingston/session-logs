// `sessions` command: read-only queries over the local session store.
//   sessions show <rev> [--raw]   transcript as it was when <rev> was committed
//   sessions commits <session>    commits linked to a session
//   sessions list                 sessions recorded in this repository
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { commitsForSession, listSessions, renderSnapshot, snapshotForCommit } from "../read/read.ts";
import { sessionLogsRoot } from "../capture/capture.ts";
import { doctor, forkSession, pruneSessions } from "../maintain/maintain.ts";

function git(args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function usage(): void {
  console.error(
    "usage: sessions show <rev> [--raw] | commits <session> | list | fork <session> --at <snapshot>\n" +
      "       sessions doctor | prune [--older-than <days>] [--include-linked] [--apply]",
  );
  process.exitCode = 2;
}

// Piping into `head` closes stdout early; that is not an error.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

function main(argv: string[]): void {
  const repoRoot = git(["rev-parse", "--show-toplevel"]);
  if (!repoRoot) {
    console.error("sessions: not inside a git repository");
    process.exitCode = 1;
    return;
  }
  const [command, ...rest] = argv;
  if (command === "show") {
    const raw = rest.includes("--raw");
    const rev = rest.find((arg) => arg !== "--raw");
    if (!rev) return usage();
    const commit = git(["-C", repoRoot, "rev-parse", "--verify", `${rev}^{commit}`]);
    if (!commit) {
      console.error(`sessions: unknown revision ${rev}`);
      process.exitCode = 1;
      return;
    }
    const snapshot = snapshotForCommit(repoRoot, commit);
    if (!snapshot) {
      console.error(`sessions: ${commit} has no Transcript trailer`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(renderSnapshot(repoRoot, snapshot, raw ? "raw" : "markdown"));
    return;
  }
  if (command === "commits") {
    const session = rest[0];
    if (!session) return usage();
    const links = commitsForSession(repoRoot, session);
    if (links.length === 0) {
      console.log("no linked commits");
      return;
    }
    for (const link of links) {
      const note = link.relation === "also-active" ? " (also active)" : "";
      console.log(`${link.commit.slice(0, 12)}  ${link.subject}${note}`);
    }
    return;
  }
  if (command === "list") {
    const sessions = listSessions(repoRoot);
    if (sessions.length === 0) {
      console.log("no sessions recorded");
      return;
    }
    for (const s of sessions) {
      console.log(`${s.session_id}  snapshot ${s.latest_snapshot.slice(0, 12)}  ${s.created_at}`);
    }
    return;
  }
  if (command === "fork") {
    const at = rest[rest.indexOf("--at") + 1];
    const session = rest[0];
    if (!session || rest.indexOf("--at") === -1 || !at) return usage();
    const result = forkSession(repoRoot, session, at);
    console.log(`forked session ${result.session_id}`);
    console.log(`first snapshot ${result.snapshot}`);
    return;
  }
  if (command === "doctor") {
    for (const finding of doctor(repoRoot)) {
      console.log(`${finding.level.padEnd(5)} ${finding.message}`);
    }
    return;
  }
  if (command === "prune") {
    const flagIndex = rest.indexOf("--older-than");
    const flagDays = flagIndex === -1 ? undefined : Number(rest[flagIndex + 1]);
    const configFile = join(sessionLogsRoot(repoRoot), "config.json");
    const configDays = existsSync(configFile)
      ? (JSON.parse(readFileSync(configFile, "utf8")).prune?.olderThanDays as number | undefined)
      : undefined;
    const plan = pruneSessions(repoRoot, {
      olderThanDays: flagDays ?? configDays,
      apply: rest.includes("--apply"),
      includeLinked: rest.includes("--include-linked"),
    });
    console.log(`${plan.applied ? "pruned" : "would prune"} ${plan.sessions.length} session(s), ${plan.snapshots} snapshot(s), ${plan.objects} object(s)`);
    for (const session of plan.sessions) console.log(`  ${session}`);
    if (!plan.applied) console.log("dry run: pass --apply to delete");
    return;
  }
  usage();
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`sessions: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
