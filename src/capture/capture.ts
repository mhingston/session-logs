import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../storage/object-store.ts";
import { mergeCounts, redact } from "./redact.ts";

// M1 capture core. Local store only: .session-logs/ inside the repository.
//
// Layout under <repo>/.session-logs/:
//   objects/<sha256>            immutable segment bytes (content-addressed, redacted)
//   snapshots/<snapshot>.json   manifest; snapshot id = sha256 of manifest bytes (D20)
//   sessions/<session_id>.json  latest snapshot and redacted-content hash for the session
//   active/<session_id>.json    one file per session that has stopped in this repo
//
// Segmentation is fixed from the start of the file, so closed segments never
// change as a transcript grows (D8).

export const SEGMENT_MAX_MESSAGES = 500;
export const SEGMENT_MAX_BYTES = 1024 * 1024;
export const SCHEMA_VERSION = 1;

export interface SegmentRef {
  name: string;
  sha256: string;
  messages: number;
  bytes: number;
}

export interface Manifest {
  schema_version: number;
  session_id: string;
  parent: { session_id: string; snapshot: string } | null;
  segments: SegmentRef[];
  source: { agent: "claude-code"; transcript_path: string };
  includes_subagents: false;
  redactions: Record<string, number>;
  // Entries not stored, counted by type (D38). Only conversation turns are stored.
  excluded: Record<string, number>;
  created_at: string;
}

export interface SessionIndex {
  session_id: string;
  // Hash of the redacted transcript text, so no secret-derived digest is stored.
  content_sha256: string;
  snapshot: string;
}

export interface ActiveSession {
  session_id: string;
  transcript_path: string;
  // First time this session was seen in the repository (prompt or stop).
  first_stop_at: string;
  last_stop_at?: string;
  // Set on UserPromptSubmit; cleared in effect by a later Stop (D50).
  turn_open_at?: string;
}

// An open turn with no Stop is treated as ended after this long. Stop does not run
// when a turn is interrupted, so without a limit an interrupted turn would stay open.
export const TURN_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export function sessionLogsRoot(repoRoot: string): string {
  return join(repoRoot, ".session-logs");
}

// Only conversation turns are stored (D38). Other entry types carry injected
// system context (api-request-blob, attachments of subtype "instructions") or
// runtime metadata; they are counted in the manifest instead.
const STORED_TYPES = new Set(["user", "assistant"]);

function entryType(line: string): string {
  try {
    const record = JSON.parse(line) as { type?: unknown };
    return typeof record.type === "string" ? record.type : "unparsed";
  } catch {
    return "unparsed";
  }
}

// Splits transcript lines into segments. A segment closes at 500 messages or
// 1 MB, whichever comes first.
export function segmentLines(lines: string[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    current.push(line);
    bytes += Buffer.byteLength(line, "utf8") + 1;
    if (current.length >= SEGMENT_MAX_MESSAGES || bytes >= SEGMENT_MAX_BYTES) {
      segments.push(current);
      current = [];
      bytes = 0;
    }
  }
  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
}

export function writeFileAtomic(path: string, data: string | Uint8Array): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

// Records that a session has stopped in this repository. Each session has its
// own file, so concurrent sessions do not overwrite each other.
export function recordActiveSession(
  repoRoot: string,
  session: { session_id: string; transcript_path: string },
  now: Date = new Date(),
): void {
  const dir = join(sessionLogsRoot(repoRoot), "active");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${session.session_id}.json`);
  const previous = readJson<ActiveSession>(file);
  const record: ActiveSession = {
    ...previous,
    ...session,
    first_stop_at: previous?.first_stop_at ?? now.toISOString(),
    last_stop_at: now.toISOString(),
  };
  writeFileAtomic(file, JSON.stringify(record, null, 2) + "\n");
}

// Records that a turn has started (UserPromptSubmit). Commits made while the turn
// is open link to this session (D50).
export function recordTurnOpen(
  repoRoot: string,
  session: { session_id: string; transcript_path: string },
  now: Date = new Date(),
): void {
  const dir = join(sessionLogsRoot(repoRoot), "active");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${session.session_id}.json`);
  const previous = readJson<ActiveSession>(file);
  const record: ActiveSession = {
    ...previous,
    ...session,
    first_stop_at: previous?.first_stop_at ?? now.toISOString(),
    turn_open_at: now.toISOString(),
  };
  writeFileAtomic(file, JSON.stringify(record, null, 2) + "\n");
}

// Most recent activity for ordering: a stop, or the start of an open turn.
export function activityAt(record: ActiveSession): string {
  return [record.last_stop_at, record.turn_open_at].filter((t): t is string => t !== undefined).sort().pop() ?? record.first_stop_at;
}

function turnIsOpen(record: ActiveSession, nowMs: number): boolean {
  if (!record.turn_open_at) return false;
  const opened = Date.parse(record.turn_open_at);
  const stopped = record.last_stop_at ? Date.parse(record.last_stop_at) : -Infinity;
  return opened > stopped && nowMs - opened < TURN_MAX_AGE_MS;
}

export function allActiveSessions(repoRoot: string): ActiveSession[] {
  const dir = join(sessionLogsRoot(repoRoot), "active");
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson<ActiveSession>(join(dir, name)))
    .filter((record): record is ActiveSession => record !== undefined)
    .sort((a, b) => Date.parse(activityAt(b)) - Date.parse(activityAt(a)));
}

// Sessions that stopped after `since` (exclusive), most recent first.
// With no `since` (no earlier commit), only the single most recent session.
export function candidateSessions(repoRoot: string, since?: string, now: Date = new Date()): ActiveSession[] {
  const all = allActiveSessions(repoRoot);
  // A commit made during one or more open turns belongs to those sessions (D50).
  const open = all.filter((record) => turnIsOpen(record, now.getTime()));
  if (open.length > 0) {
    return open.sort((a, b) => Date.parse(b.turn_open_at!) - Date.parse(a.turn_open_at!));
  }
  // Otherwise: sessions that stopped since the previous commit (D36).
  const stopped = all.filter((record) => record.last_stop_at !== undefined);
  if (since === undefined) {
    return stopped.slice(0, 1);
  }
  // Compare parsed times: git gives offset timestamps, we store UTC with milliseconds.
  const sinceMs = Date.parse(since);
  return stopped.filter((record) => Date.parse(record.last_stop_at!) > sinceMs);
}

// Takes a snapshot of the transcript. Returns the existing snapshot when the
// redacted content has not changed since the last one, so no new work is
// written (skip-if-unchanged compares content, not the manifest).
// Finds the session this one was forked from (D48). A forked transcript copies the
// parent's messages, so its uuids overlap with the parent's stored snapshots and with
// no other session's. Picks the other session sharing the most uuids (ties: most
// recent), and within it the snapshot holding the most of them. Returns null when no
// stored session shares any message.
export function findForkParent(
  repoRoot: string,
  sessionId: string,
  storedLines: string[],
): { session_id: string; snapshot: string } | null {
  const mine = new Set<string>();
  for (const line of storedLines) {
    try {
      const uuid = (JSON.parse(line) as { uuid?: unknown }).uuid;
      if (typeof uuid === "string") mine.add(uuid);
    } catch {
      // Stored lines are JSON; anything else is ignored.
    }
  }
  if (mine.size === 0) {
    return null;
  }
  const root = sessionLogsRoot(repoRoot);
  const dir = join(root, "snapshots");
  if (!existsSync(dir)) {
    return null;
  }
  // Per other snapshot: how many of this transcript's uuids it holds.
  const matches: Array<{ session_id: string; snapshot: string; created_at: string; count: number }> = [];
  for (const name of readdirSync(dir)) {
    const manifest = readJson<Manifest>(join(dir, name));
    if (!manifest || manifest.session_id === sessionId) continue;
    const shared = new Set<string>();
    for (const segment of manifest.segments) {
      const objectPath = join(root, "objects", segment.sha256);
      if (!existsSync(objectPath)) continue;
      for (const line of readFileSync(objectPath, "utf8").split("\n")) {
        try {
          const uuid = (JSON.parse(line) as { uuid?: unknown }).uuid;
          if (typeof uuid === "string" && mine.has(uuid)) shared.add(uuid);
        } catch {
          // Skip non-JSON lines.
        }
      }
    }
    if (shared.size > 0) {
      matches.push({ session_id: manifest.session_id, snapshot: name.replace(/\.json$/, ""), created_at: manifest.created_at, count: shared.size });
    }
  }
  if (matches.length === 0) {
    return null;
  }
  // Parent session: most shared uuids, then most recent snapshot.
  const bySession = new Map<string, number>();
  for (const m of matches) bySession.set(m.session_id, (bySession.get(m.session_id) ?? 0) + m.count);
  const parentSession = [...bySession.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  // Snapshot of that session holding the most shared uuids, then most recent.
  const best = matches
    .filter((m) => m.session_id === parentSession)
    .sort((a, b) => b.count - a.count || (a.created_at < b.created_at ? 1 : -1))[0]!;
  return { session_id: best.session_id, snapshot: best.snapshot };
}

export function snapshotTranscript(
  repoRoot: string,
  sessionId: string,
  transcriptPath: string,
  now: Date = new Date(),
): string {
  const root = sessionLogsRoot(repoRoot);
  // Redact before anything is hashed or written (D24). Only redacted text is
  // stored, and only its hash is kept in the index.
  const redactions: Record<string, number> = {};
  const excluded: Record<string, number> = {};
  const lines = readFileSync(transcriptPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const type = entryType(line);
      if (!STORED_TYPES.has(type)) {
        excluded[type] = (excluded[type] ?? 0) + 1;
        return [];
      }
      const result = redact(line);
      mergeCounts(redactions, result.counts);
      return [result.text];
    });
  const contentHash = sha256Hex(Buffer.from(lines.join("\n") + "\n", "utf8"));

  const sessionFile = join(root, "sessions", `${sessionId}.json`);
  const existing = readJson<SessionIndex>(sessionFile);
  if (existing && existing.content_sha256 === contentHash) {
    return existing.snapshot;
  }

  // A session's parent is fixed at its first snapshot (D48). Later snapshots keep it.
  let parent: Manifest["parent"] = null;
  if (existing) {
    parent = readJson<Manifest>(join(root, "snapshots", `${existing.snapshot}.json`))?.parent ?? null;
  } else {
    parent = findForkParent(repoRoot, sessionId, lines);
  }

  const segments: SegmentRef[] = [];
  mkdirSync(join(root, "objects"), { recursive: true });
  for (const group of segmentLines(lines)) {
    const bytes = Buffer.from(group.join("\n") + "\n", "utf8");
    const hash = sha256Hex(bytes);
    const objectPath = join(root, "objects", hash);
    if (!existsSync(objectPath)) {
      writeFileAtomic(objectPath, bytes);
    }
    segments.push({ name: hash, sha256: hash, messages: group.length, bytes: bytes.length });
  }

  const manifest: Manifest = {
    schema_version: SCHEMA_VERSION,
    session_id: sessionId,
    parent,
    segments,
    source: { agent: "claude-code", transcript_path: transcriptPath },
    includes_subagents: false,
    redactions,
    excluded,
    created_at: now.toISOString(),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const snapshot = sha256Hex(manifestBytes);

  mkdirSync(join(root, "snapshots"), { recursive: true });
  mkdirSync(join(root, "sessions"), { recursive: true });
  writeFileAtomic(join(root, "snapshots", `${snapshot}.json`), manifestBytes);
  const index: SessionIndex = { session_id: sessionId, content_sha256: contentHash, snapshot };
  writeFileAtomic(sessionFile, JSON.stringify(index, null, 2) + "\n");
  return snapshot;
}
