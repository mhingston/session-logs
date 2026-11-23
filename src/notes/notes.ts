// Git notes for session links (handoff §5, D5, D53).
//
// Notes are ordinary git notes (refs/notes/sessions), but they live in their own bare
// repository under .session-logs/notes.git. That repository reads commit objects from
// the main repository through git alternates, so nothing is written to the main
// repository's refs. The notes are a cache: every note is derived from the commit's
// trailers, and `rebuild` restores them all.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionLogsRoot } from "../capture/capture.ts";

const NOTES_REF = "refs/notes/sessions";
const TRAILER_KEYS = /^(Session|Transcript|Also-Active|Reverts): /;

export function notesRepo(repoRoot: string): string {
  return join(sessionLogsRoot(repoRoot), "notes.git");
}

function gitCommonDir(repoRoot: string): string {
  return execFileSync("git", ["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
  }).trim();
}

// Creates the notes repository on first use, reading objects from the main repository.
export function ensureNotesRepo(repoRoot: string): string {
  const dir = notesRepo(repoRoot);
  if (!existsSync(join(dir, "HEAD"))) {
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q", "--bare", dir]);
  }
  const alternates = join(dir, "objects", "info", "alternates");
  mkdirSync(join(dir, "objects", "info"), { recursive: true });
  const wanted = join(gitCommonDir(repoRoot), "objects");
  if (!existsSync(alternates) || !readFileSync(alternates, "utf8").includes(wanted)) {
    writeFileSync(alternates, wanted + "\n");
  }
  return dir;
}

// The note text for a commit: its session-logs trailers, in order. Undefined when none.
export function noteTextFor(repoRoot: string, commit: string): string | undefined {
  const body = execFileSync("git", ["-C", repoRoot, "log", "-1", "--format=%B", commit], { encoding: "utf8" });
  const lines = body.split("\n").filter((line) => TRAILER_KEYS.test(line));
  return lines.length > 0 ? lines.join("\n") + "\n" : undefined;
}

// Resolves a revision in the main repository. The notes repository has its own HEAD,
// so revisions must be turned into SHAs before they reach it.
function resolveCommit(repoRoot: string, rev: string): string {
  return execFileSync("git", ["-C", repoRoot, "rev-parse", "--verify", `${rev}^{commit}`], { encoding: "utf8" }).trim();
}

// Writes (or removes) the note for one commit, derived from its trailers.
export function syncNote(repoRoot: string, rev: string): void {
  const commit = resolveCommit(repoRoot, rev);
  const dir = ensureNotesRepo(repoRoot);
  const text = noteTextFor(repoRoot, commit);
  if (text === undefined) {
    try {
      execFileSync("git", ["--git-dir", dir, "notes", `--ref=${NOTES_REF}`, "remove", "--ignore-missing", commit], {
        stdio: "ignore",
      });
    } catch {
      // Nothing to remove.
    }
    return;
  }
  execFileSync("git", ["--git-dir", dir, "notes", `--ref=${NOTES_REF}`, "add", "-f", "-F", "-", commit], {
    input: text,
    stdio: ["pipe", "ignore", "pipe"],
  });
}

export function readNote(repoRoot: string, rev: string): string | undefined {
  const dir = notesRepo(repoRoot);
  if (!existsSync(join(dir, "HEAD"))) return undefined;
  let commit: string;
  try {
    commit = resolveCommit(repoRoot, rev);
  } catch {
    return undefined;
  }
  try {
    return execFileSync("git", ["--git-dir", dir, "notes", `--ref=${NOTES_REF}`, "show", commit], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

// Rebuilds every note from trailers across all refs. Returns the number of notes written.
export function rebuildNotes(repoRoot: string): number {
  const commits = execFileSync("git", ["-C", repoRoot, "rev-list", "--all"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  let written = 0;
  for (const commit of commits) {
    if (noteTextFor(repoRoot, commit) !== undefined) {
      written += 1;
    }
    syncNote(repoRoot, commit);
  }
  return written;
}
