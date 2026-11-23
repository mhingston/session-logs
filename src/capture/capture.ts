import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../storage/object-store.ts";
import { mergeCounts, redact } from "./redact.ts";

// M1 capture core. Local store only: .session-logs/ inside the repository.
//
// Layout under <repo>/.session-logs/:
//   objects/<sha256>            immutable segment bytes (content-addressed)
//   snapshots/<snapshot>.json   manifest; snapshot id = sha256 of manifest bytes (D20)
//   sessions/<session_id>.json  latest snapshot and transcript hash for the session
//   current.json                session the next commit should be linked to
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
  parent: null;
  segments: SegmentRef[];
  source: { agent: "claude-code"; transcript_path: string };
  includes_subagents: false;
  redactions: Record<string, number>;
  created_at: string;
}

export interface SessionIndex {
  session_id: string;
  transcript_sha256: string;
  snapshot: string;
}

export interface CurrentSession {
  session_id: string;
  transcript_path: string;
}

export function sessionLogsRoot(repoRoot: string): string {
  return join(repoRoot, ".session-logs");
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

function writeFileAtomic(path: string, data: string | Uint8Array): void {
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

export function readCurrentSession(repoRoot: string): CurrentSession | undefined {
  return readJson<CurrentSession>(join(sessionLogsRoot(repoRoot), "current.json"));
}

export function writeCurrentSession(repoRoot: string, current: CurrentSession): void {
  const root = sessionLogsRoot(repoRoot);
  mkdirSync(root, { recursive: true });
  writeFileAtomic(join(root, "current.json"), JSON.stringify(current, null, 2) + "\n");
}

// Takes a snapshot of the transcript. Returns the existing snapshot when the
// transcript content has not changed since the last one, so no new work is
// written (skip-if-unchanged compares content, not the manifest).
export function snapshotTranscript(
  repoRoot: string,
  sessionId: string,
  transcriptPath: string,
  now: Date = new Date(),
): string {
  const root = sessionLogsRoot(repoRoot);
  const raw = readFileSync(transcriptPath);
  const transcriptHash = sha256Hex(raw);

  const sessionFile = join(root, "sessions", `${sessionId}.json`);
  const existing = readJson<SessionIndex>(sessionFile);
  if (existing && existing.transcript_sha256 === transcriptHash) {
    return existing.snapshot;
  }

  // Redact before anything is written (D24). Only redacted text is stored.
  const redactions: Record<string, number> = {};
  const lines = raw
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const result = redact(line);
      mergeCounts(redactions, result.counts);
      return result.text;
    });
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
    parent: null,
    segments,
    source: { agent: "claude-code", transcript_path: transcriptPath },
    includes_subagents: false,
    redactions,
    created_at: now.toISOString(),
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const snapshot = sha256Hex(manifestBytes);

  mkdirSync(join(root, "snapshots"), { recursive: true });
  mkdirSync(join(root, "sessions"), { recursive: true });
  writeFileAtomic(join(root, "snapshots", `${snapshot}.json`), manifestBytes);
  const index: SessionIndex = { session_id: sessionId, transcript_sha256: transcriptHash, snapshot };
  writeFileAtomic(sessionFile, JSON.stringify(index, null, 2) + "\n");
  return snapshot;
}
