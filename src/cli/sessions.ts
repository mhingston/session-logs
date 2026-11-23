// `sessions` command: read-only queries over the local session store.
//   sessions show <rev> [--raw]   transcript as it was when <rev> was committed
//   sessions commits <session>    commits linked to a session
//   sessions list                 sessions recorded in this repository
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { commitsForSession, listSessions, renderSnapshot, snapshotsForCommit } from "../read/read.ts";
import { sessionLogsRoot } from "../capture/capture.ts";
import { doctor, forkSession, pruneSessions } from "../maintain/maintain.ts";
import { decisionsEnabled, generateDecisions } from "../decisions/decisions.ts";
import { readNote, rebuildNotes } from "../notes/notes.ts";

function git(args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

const HELP = [
  "usage: sessions <command> [options]",
  "",
  "Commands:",
  "  list [--full]                               List recorded sessions (use --full for 64-char snapshot IDs)",
  "  show <rev> [--raw] [--session <id>]         Show transcript(s) linked to a commit",
  "  commits <session-id>                        List commits linked to a session",
  "  decisions <rev> [--session <id>] [--json]   Deterministic decision extract for a commit's transcript (opt-in, D21)",
  "  notes show <rev>                            Show the git note for a commit",
  "  notes rebuild                               Rebuild all git notes from commit trailers",
  "  fork <session-id> --at <snapshot>           Create a new session record from a snapshot (ID or unique prefix)",
  "  doctor                                      Check hooks, store integrity, unlinked commits, and notes",
  "  prune [--older-than <days>] [--include-linked] [--apply]",
  "                                              Dry-run or delete old unlinked sessions",
].join("\n");

function usage(): void {
  console.error(HELP);
  process.exitCode = 2;
}

// Piping into `head` closes stdout early; that is not an error.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

function main(argv: string[]): void {
  const [command, ...rest] = argv;
  if (!command) return usage();
  if (command === "--help" || command === "-h" || command === "help") {
    console.log(HELP);
    return;
  }
  const repoRoot = git(["rev-parse", "--show-toplevel"]);
  if (!repoRoot) {
    console.error("sessions: not inside a git repository");
    process.exitCode = 1;
    return;
  }
  if (command === "show") {
    const raw = rest.includes("--raw");
    const sessionFlagIndex = rest.indexOf("--session");
    let sessionFilter: string | undefined;
    if (sessionFlagIndex !== -1) {
      sessionFilter = rest[sessionFlagIndex + 1];
      if (!sessionFilter || sessionFilter.startsWith("-")) return usage();
    }
    const rev = rest.find(
      (arg, idx) =>
        arg !== "--raw" &&
        arg !== "--session" &&
        (sessionFlagIndex === -1 || idx !== sessionFlagIndex + 1),
    );
    if (!rev) return usage();
    const commit = git(["-C", repoRoot, "rev-parse", "--verify", `${rev}^{commit}`]);
    if (!commit) {
      console.error(`sessions: unknown revision ${rev}`);
      process.exitCode = 1;
      return;
    }
    const pairs = snapshotsForCommit(repoRoot, commit);
    if (pairs.length === 0) {
      console.error(`sessions: ${commit} has no Transcript trailer`);
      process.exitCode = 1;
      return;
    }
    const selected = sessionFilter ? pairs.filter((pair) => pair.session === sessionFilter) : pairs;
    if (selected.length === 0) {
      console.error(`sessions: ${commit} has no Transcript trailer for session ${sessionFilter}`);
      process.exitCode = 1;
      return;
    }
    const format = raw ? "raw" : "markdown";
    if (selected.length === 1) {
      process.stdout.write(renderSnapshot(repoRoot, selected[0]!.snapshot!, format));
      return;
    }
    const rendered = selected.map((pair) => {
      const body = renderSnapshot(repoRoot, pair.snapshot!, format);
      if (raw) return body;
      return `## Session ${pair.session} (snapshot ${pair.snapshot!.slice(0, 12)})\n\n${body}`;
    });
    process.stdout.write(rendered.join(raw ? "" : "\n"));
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
    const full = rest.includes("--full");
    const sessions = listSessions(repoRoot);
    if (sessions.length === 0) {
      console.log("no sessions recorded");
      return;
    }
    for (const s of sessions) {
      const snap = full ? s.latest_snapshot : s.latest_snapshot.slice(0, 12);
      console.log(`${s.session_id}  snapshot ${snap}  ${s.created_at}`);
    }
    return;
  }
  if (command === "fork") {
    const atIndex = rest.indexOf("--at");
    const at = atIndex === -1 ? undefined : rest[atIndex + 1];
    const session = rest[0];
    if (!session || atIndex === -1 || !at) return usage();
    const result = forkSession(repoRoot, session, at);
    console.log(`forked session ${result.session_id}`);
    console.log(`first snapshot ${result.snapshot}`);
    return;
  }
  if (command === "decisions") {
    const json = rest.includes("--json");
    const sessionFlagIndex = rest.indexOf("--session");
    const sessionFilter = sessionFlagIndex === -1 ? undefined : rest[sessionFlagIndex + 1];
    if (sessionFlagIndex !== -1 && (!sessionFilter || sessionFilter.startsWith("-"))) return usage();
    const rev = rest.find((arg, idx) => !arg.startsWith("-") && (sessionFlagIndex === -1 || idx !== sessionFlagIndex + 1));
    if (!rev) return usage();
    if (!decisionsEnabled(repoRoot)) {
      console.error('sessions: decision extraction is off. Set {"decisions": {"enabled": true}} in .session-logs/config.json');
      process.exitCode = 1;
      return;
    }
    const commit = git(["-C", repoRoot, "rev-parse", "--verify", `${rev}^{commit}`]);
    if (!commit) {
      console.error(`sessions: unknown revision ${rev}`);
      process.exitCode = 1;
      return;
    }
    const pairs = snapshotsForCommit(repoRoot, commit).filter((pair) => !sessionFilter || pair.session === sessionFilter);
    if (pairs.length === 0) {
      console.error(`sessions: ${commit} has no Transcript trailer${sessionFilter ? ` for session ${sessionFilter}` : ""}`);
      process.exitCode = 1;
      return;
    }
    const extracts = pairs.map((pair) => generateDecisions(repoRoot, pair.snapshot!));
    if (json) {
      console.log(JSON.stringify(extracts, null, 2));
      return;
    }
    for (const extract of extracts) {
      console.log(`## Session ${extract.session_id} (snapshot ${extract.snapshot.slice(0, 12)}, ${extract.extractor})`);
      if (extract.decisions.length === 0) console.log("no decision statements found");
      for (const d of extract.decisions) console.log(`- [message ${d.message}, ${d.role}] ${d.text}`);
      console.log("");
    }
    return;
  }
  if (command === "notes") {
    const sub = rest[0];
    if (sub === "rebuild") {
      console.log(`rebuilt notes for ${rebuildNotes(repoRoot)} linked commit(s) in .session-logs/notes.git`);
      return;
    }
    if (sub === "show" && rest[1]) {
      const commit = git(["-C", repoRoot, "rev-parse", "--verify", `${rest[1]}^{commit}`]);
      const note = commit ? readNote(repoRoot, commit) : undefined;
      if (note === undefined) {
        console.log("no note");
        return;
      }
      process.stdout.write(note);
      return;
    }
    return usage();
  }
  if (command === "doctor") {
    for (const finding of doctor(repoRoot)) {
      console.log(`${finding.level.padEnd(5)} ${finding.message}`);
    }
    return;
  }
  if (command === "prune") {
    const flagIndex = rest.indexOf("--older-than");
    let flagDays: number | undefined;
    if (flagIndex !== -1) {
      const rawValue = rest[flagIndex + 1];
      const parsed = Number(rawValue);
      if (!rawValue || !Number.isFinite(parsed) || parsed <= 0) {
        console.error("sessions: --older-than requires a positive number of days");
        process.exitCode = 2;
        return;
      }
      flagDays = parsed;
    }
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
