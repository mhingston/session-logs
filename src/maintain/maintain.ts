// M3 maintenance: fork, doctor, prune (handoff §7, D10, D25).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { activityAt, allActiveSessions, sessionLogsRoot, type Manifest, type SessionIndex } from "../capture/capture.ts";
import { sha256Hex } from "../storage/object-store.ts";
import { readSnapshotLines, readManifest, commitsForSession, resolveSnapshotId } from "../read/read.ts";
import { readNote } from "../notes/notes.ts";
import { lockBusy, tryLock } from "../summaries/summaries.ts";

const HASH_PREFIX = /^[0-9a-f]{4,64}$/;

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function snapshotFiles(repoRoot: string): string[] {
  const dir = join(sessionLogsRoot(repoRoot), "snapshots");
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length));
}

function allManifests(repoRoot: string): Array<{ snapshot: string; manifest: Manifest }> {
  return snapshotFiles(repoRoot).map((snapshot) => ({ snapshot, manifest: readManifest(repoRoot, snapshot) }));
}

// ---- fork ------------------------------------------------------------------

export interface ForkResult {
  session_id: string;
  snapshot: string;
}

// Creates a new session whose first snapshot records the parent snapshot (D10).
// The parent and its snapshots are not modified.
export function forkSession(
  repoRoot: string,
  parentSession: string,
  atSnapshot: string,
  now: Date = new Date(),
  newSessionId: string = randomUUID(),
): ForkResult {
  if (!HASH_PREFIX.test(atSnapshot)) {
    throw new Error("--at must be a snapshot id");
  }
  const resolvedSnapshot = resolveSnapshotId(repoRoot, atSnapshot);
  const parent = readManifest(repoRoot, resolvedSnapshot);
  if (parent.session_id !== parentSession) {
    throw new Error(`snapshot ${resolvedSnapshot} belongs to session ${parent.session_id}, not ${parentSession}`);
  }
  const forked: Manifest = {
    ...parent,
    session_id: newSessionId,
    parent: { session_id: parentSession, snapshot: resolvedSnapshot },
    created_at: now.toISOString(),
  };
  const bytes = Buffer.from(JSON.stringify(forked, null, 2) + "\n", "utf8");
  const snapshot = sha256Hex(bytes);
  const root = sessionLogsRoot(repoRoot);
  mkdirSync(join(root, "snapshots"), { recursive: true });
  mkdirSync(join(root, "sessions"), { recursive: true });
  writeFileSync(join(root, "snapshots", `${snapshot}.json`), bytes);
  const index: SessionIndex = {
    session_id: newSessionId,
    content_sha256: sha256Hex(Buffer.from(readSnapshotLines(repoRoot, resolvedSnapshot).join("\n") + "\n", "utf8")),
    snapshot,
  };
  writeFileSync(join(root, "sessions", `${newSessionId}.json`), JSON.stringify(index, null, 2) + "\n");
  return { session_id: newSessionId, snapshot };
}

// ---- doctor ----------------------------------------------------------------

export interface Finding {
  level: "error" | "warn" | "info";
  message: string;
}

export function doctor(repoRoot: string): Finding[] {
  const findings: Finding[] = [];
  const root = sessionLogsRoot(repoRoot);

  // Hooks installed?
  const hooksPath = (() => {
    try {
      return resolve(repoRoot, git(repoRoot, ["config", "--local", "--get", "core.hooksPath"]).trim());
    } catch {
      return undefined;
    }
  })();
  if (hooksPath !== resolve(root, "git-hooks")) {
    findings.push({ level: "warn", message: "commit hooks are not installed in this repository (run init)" });
  }
  const settings = join(repoRoot, ".claude", "settings.local.json");
  const settingsText = existsSync(settings) ? readFileSync(settings, "utf8") : "";
  const registeredHookPaths = (event: string, suffix: string): string[] => {
    if (!settingsText) return [];
    try {
      const parsed = JSON.parse(settingsText) as {
        hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
      };
      const commands = (parsed.hooks?.[event] ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command ?? ""));
      const paths: string[] = [];
      for (const cmd of commands) {
        const match = cmd.match(/^node\s+(['"]?)(.+?)\1$/);
        if (match?.[2]?.endsWith(suffix)) {
          paths.push(match[2].replace(/'\\''/g, "'"));
        }
      }
      return paths;
    } catch {
      return [];
    }
  };

  const stopPaths = registeredHookPaths("Stop", "src/hooks/stop.ts");
  if (stopPaths.length === 0) {
    findings.push({ level: "warn", message: "Stop hook is not registered in .claude/settings.local.json (run init)" });
  } else if (stopPaths.some((p) => !existsSync(p))) {
    findings.push({
      level: "warn",
      message: "Stop hook in .claude/settings.local.json points to a missing script; re-run init",
    });
  }
  const promptPaths = registeredHookPaths("UserPromptSubmit", "src/hooks/user-prompt-submit.ts");
  if (promptPaths.length === 0) {
    findings.push({ level: "warn", message: "UserPromptSubmit hook is not registered; commits made mid-turn will not link (run init)" });
  } else if (promptPaths.some((p) => !existsSync(p))) {
    findings.push({
      level: "warn",
      message: "UserPromptSubmit hook in .claude/settings.local.json points to a missing script; re-run init",
    });
  }
  if (existsSync(join(root, "errors.log"))) {
    const count = readFileSync(join(root, "errors.log"), "utf8").split("\n").filter(Boolean).length;
    findings.push({ level: "warn", message: `${count} hook error(s) logged in .session-logs/errors.log` });
  }

  // Snapshot store integrity.
  const manifests = allManifests(repoRoot);
  const snapshotSet = new Set(manifests.map((m) => m.snapshot));
  for (const { snapshot, manifest } of manifests) {
    for (const segment of manifest.segments) {
      if (!existsSync(join(root, "objects", segment.sha256))) {
        findings.push({ level: "error", message: `snapshot ${snapshot.slice(0, 12)} is missing segment ${segment.sha256.slice(0, 12)}` });
      }
    }
  }

  // Commit trailers.
  const log = git(repoRoot, ["log", "--all", "--format=%H%x1f%cI%x1f%B%x1e"]);
  const sessionDir = join(root, "sessions");
  const sessionIds = new Set(
    existsSync(sessionDir) ? readdirSync(sessionDir).map((f) => f.replace(/\.json$/, "")) : [],
  );
  const activeSessions = allActiveSessions(repoRoot);
  let unlinkedDuringSession = 0;
  let missingNotes = 0;
  for (const record of log.split("\x1e")) {
    const [hash, committed, body] = record.split("\x1f");
    if (!hash || body === undefined || !committed) continue;
    const lines = body.split("\n");
    const transcripts = lines.filter((l) => l.startsWith("Transcript: ")).map((l) => l.slice(12).trim());
    const sessions = lines.filter((l) => l.startsWith("Session: ")).map((l) => l.slice(9).trim());
    for (const snapshot of transcripts) {
      if (!snapshotSet.has(snapshot)) {
        findings.push({ level: "error", message: `commit ${hash.slice(0, 12)} points to missing snapshot ${snapshot.slice(0, 12)}` });
      }
    }
    if (sessions.length !== transcripts.length) {
      findings.push({ level: "warn", message: `commit ${hash.slice(0, 12)} has ${sessions.length} Session and ${transcripts.length} Transcript trailers` });
    }
    for (const session of sessions) {
      if (!sessionIds.has(session) && session !== "unknown-session") {
        findings.push({ level: "warn", message: `commit ${hash.slice(0, 12)} names session ${session}, which has no record here` });
      }
    }
    if (sessions.length > 0 && readNote(repoRoot, hash.trim()) === undefined) {
      missingNotes += 1;
    }
    if (sessions.length === 0) {
      const t = Date.parse(committed);
      const during = activeSessions.find((s) => Date.parse(s.first_stop_at) <= t && t <= Date.parse(activityAt(s)));
      if (during) {
        unlinkedDuringSession += 1;
        findings.push({
          level: "warn",
          message: `commit ${hash.slice(0, 12)} has no session link but was made during session ${during.session_id} (heuristic)`,
        });
      }
    }
  }
  if (missingNotes > 0) {
    findings.push({ level: "warn", message: `${missingNotes} linked commit(s) have no session note; run sessions notes rebuild` });
  }
  if (unlinkedDuringSession === 0) {
    findings.push({ level: "info", message: "no unlinked commits found during recorded sessions" });
  }
  return findings;
}

// ---- prune -----------------------------------------------------------------

export interface PruneOptions {
  olderThanDays?: number; // from --older-than or config; pruning is off when absent
  apply: boolean;
  includeLinked: boolean;
  now?: Date;
}

export interface PrunePlan {
  sessions: string[];
  snapshots: number;
  objects: number;
  applied: boolean;
}

// Deletes whole sessions (D25). Dry run unless apply is set. A session is kept if
// a commit links it (unless includeLinked), or another session forks from it.
export function pruneSessions(repoRoot: string, options: PruneOptions): PrunePlan {
  if (options.olderThanDays === undefined || !(options.olderThanDays > 0)) {
    throw new Error("pruning is off by default: pass --older-than <days> or set prune.olderThanDays");
  }
  const cutoff = (options.now ?? new Date()).getTime() - options.olderThanDays * 24 * 60 * 60 * 1000;
  const manifests = allManifests(repoRoot);

  const latestBySession = new Map<string, string>();
  for (const { manifest } of manifests) {
    const existing = latestBySession.get(manifest.session_id);
    if (!existing || manifest.created_at > existing) {
      latestBySession.set(manifest.session_id, manifest.created_at);
    }
  }
  const forkedFrom = new Set(
    manifests.map((m) => m.manifest.parent?.session_id).filter((s): s is string => s !== undefined),
  );

  const candidates = [...latestBySession.entries()]
    .filter(([, latest]) => Date.parse(latest) < cutoff)
    .map(([session]) => session)
    .filter((session) => !forkedFrom.has(session))
    .filter((session) => options.includeLinked || commitsForSession(repoRoot, session).length === 0)
    // A session with a summary in progress is kept for this run (see summaries.ts locks).
    .filter((session) => !manifests.some((m) => m.manifest.session_id === session && lockBusy(repoRoot, m.snapshot)));

  const doomed = new Set(candidates);
  const doomedSnapshots = manifests.filter((m) => doomed.has(m.manifest.session_id));
  const remaining = manifests.filter((m) => !doomed.has(m.manifest.session_id));
  const liveObjects = new Set(remaining.flatMap((m) => m.manifest.segments.map((s) => s.sha256)));
  const objectDir = join(sessionLogsRoot(repoRoot), "objects");
  const deadObjects = existsSync(objectDir)
    ? readdirSync(objectDir).filter((name) => !liveObjects.has(name))
    : [];

  const plan: PrunePlan = {
    sessions: candidates,
    snapshots: doomedSnapshots.length,
    objects: deadObjects.length,
    applied: options.apply,
  };
  if (!options.apply) {
    return plan;
  }
  const root = sessionLogsRoot(repoRoot);
  // Hold each doomed snapshot's summary lock while deleting, so no summary is published
  // for a snapshot that is being removed.
  const releases: Array<() => void> = [];
  try {
    for (const { snapshot } of doomedSnapshots) {
      const release = tryLock(repoRoot, snapshot);
      if (!release) throw new Error(`snapshot ${snapshot} has a summary in progress; retry prune`);
      releases.push(release);
    }
    for (const { snapshot } of doomedSnapshots) {
      rmSync(join(root, "snapshots", `${snapshot}.json`), { force: true });
      rmSync(join(root, "decisions", `${snapshot}.json`), { force: true });
      rmSync(join(root, "summaries", `${snapshot}.json`), { force: true });
    }
    for (const session of candidates) {
      rmSync(join(root, "sessions", `${session}.json`), { force: true });
      rmSync(join(root, "active", `${session}.json`), { force: true });
    }
    for (const name of deadObjects) {
      rmSync(join(objectDir, name), { force: true });
    }
  } finally {
    for (const release of releases) release();
  }
  return plan;
}
