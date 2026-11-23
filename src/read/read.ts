// M2 read path (handoff §7). Reads only from the local .session-logs store and
// from git commit messages. Nothing here writes.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { allActiveSessions, sessionLogsRoot, type Manifest, type SessionIndex } from "../capture/capture.ts";
import { extractTrailers, type Pair } from "../capture/trailers.ts";
import { sha256Hex } from "../storage/object-store.ts";

const HASH = /^[0-9a-f]{64}$/;
const HASH_PREFIX = /^[0-9a-f]{4,64}$/;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function assertSnapshotId(id: string): void {
  if (!HASH.test(id)) {
    throw new Error(`not a snapshot id: ${id}`);
  }
}

export function resolveSnapshotId(repoRoot: string, idOrPrefix: string): string {
  if (!HASH_PREFIX.test(idOrPrefix)) {
    throw new Error(`not a snapshot id: ${idOrPrefix}`);
  }
  if (HASH.test(idOrPrefix)) {
    return idOrPrefix;
  }
  const dir = join(sessionLogsRoot(repoRoot), "snapshots");
  if (!existsSync(dir)) {
    throw new Error(`snapshot ${idOrPrefix} is not in the local store`);
  }
  const matches = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .filter((id) => id.startsWith(idOrPrefix));
  if (matches.length === 0) {
    throw new Error(`snapshot ${idOrPrefix} is not in the local store`);
  }
  if (matches.length > 1) {
    throw new Error(`snapshot prefix ${idOrPrefix} is ambiguous (${matches.length} matches)`);
  }
  return matches[0]!;
}

export function readManifest(repoRoot: string, snapshot: string): Manifest {
  assertSnapshotId(snapshot);
  const path = join(sessionLogsRoot(repoRoot), "snapshots", `${snapshot}.json`);
  if (!existsSync(path)) {
    throw new Error(`snapshot ${snapshot} is not in the local store`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

// Returns the redacted JSONL lines of a snapshot, verifying every segment hash.
export function readSnapshotLines(repoRoot: string, snapshot: string): string[] {
  const manifest = readManifest(repoRoot, snapshot);
  const lines: string[] = [];
  for (const segment of manifest.segments) {
    assertSnapshotId(segment.sha256);
    const bytes = readFileSync(join(sessionLogsRoot(repoRoot), "objects", segment.sha256));
    if (sha256Hex(bytes) !== segment.sha256) {
      throw new Error(`segment ${segment.sha256} failed its integrity check`);
    }
    lines.push(...bytes.toString("utf8").split("\n").filter((line) => line.length > 0));
  }
  return lines;
}

// Best-effort text for one JSONL entry. Returns undefined for entries that carry
// no conversation content (session metadata, queue operations). Non-text content
// inside a message is labelled, not dropped.
// Only conversation turns are rendered. Other entry types (api-request-blob,
// which carries injected system context, attachments, cost state) stay in the
// raw JSONL and are not shown as markdown.
const RENDERED_ROLES = new Set(["user", "assistant"]);

export function entryToText(line: string): { role: string; text: string } | undefined {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  const record = (entry ?? {}) as Record<string, unknown>;
  const role = typeof record.type === "string" ? record.type : "unknown";
  if (!RENDERED_ROLES.has(role)) {
    return undefined;
  }
  if (typeof record.text === "string") {
    return { role, text: record.text };
  }
  const message = record.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content === "string") {
    return { role, text: content };
  }
  if (message === undefined) {
    return undefined;
  }
  if (Array.isArray(content)) {
    const parts = content.map((part) => {
      const p = (part ?? {}) as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") {
        return p.text;
      }
      return `(${typeof p.type === "string" ? p.type : "non-text"} content)`;
    });
    return { role, text: parts.join("\n") };
  }
  return { role, text: "(message with no content)" };
}

export function renderSnapshot(repoRoot: string, snapshot: string, format: "markdown" | "raw"): string {
  const lines = readSnapshotLines(repoRoot, snapshot);
  if (format === "raw") {
    return lines.join("\n") + "\n";
  }
  return lines
    .map((line) => entryToText(line))
    .filter((entry): entry is { role: string; text: string } => entry !== undefined)
    .map(({ role, text }) => `### ${role}\n\n${text}\n`)
    .join("\n");
}

export interface CommitLink {
  commit: string;
  subject: string;
  relation: "primary" | "also-active";
  snapshot?: string;
}

// Commits whose trailers name the session, on any ref.
export function commitsForSession(repoRoot: string, sessionId: string): CommitLink[] {
  const raw = git(repoRoot, ["log", "--all", "--format=%H%x1f%B%x1e"]);
  const links: CommitLink[] = [];
  for (const record of raw.split("\x1e")) {
    const [hash, body] = record.split("\x1f");
    if (!hash || body === undefined) {
      continue;
    }
    const lines = body.split("\n");
    const subject = lines[0] ?? "";
    const extracted = extractTrailers(lines);
    const pair = extracted.pairs.find((p) => p.session === sessionId);
    if (pair) {
      links.push({ commit: hash.trim(), subject, relation: "primary", snapshot: pair.snapshot });
    } else if (extracted.alsoActive.includes(sessionId)) {
      links.push({ commit: hash.trim(), subject, relation: "also-active" });
    }
  }
  return links;
}

export function snapshotsForCommit(repoRoot: string, rev: string): Pair[] {
  const body = git(repoRoot, ["log", "-1", "--format=%B", rev]);
  return extractTrailers(body.split("\n")).pairs.filter((pair) => Boolean(pair.snapshot));
}

export function snapshotForCommit(repoRoot: string, rev: string): string | undefined {
  return snapshotsForCommit(repoRoot, rev)[0]?.snapshot;
}

export interface SessionSummary {
  session_id: string;
  latest_snapshot: string;
  created_at: string;
  last_stop_at?: string;
}

export function listSessions(repoRoot: string): SessionSummary[] {
  const dir = join(sessionLogsRoot(repoRoot), "sessions");
  if (!existsSync(dir)) {
    return [];
  }
  const active = new Map(allActiveSessions(repoRoot).map((record) => [record.session_id, record.last_stop_at]));
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const index = JSON.parse(readFileSync(join(dir, name), "utf8")) as SessionIndex;
      const manifest = readManifest(repoRoot, index.snapshot);
      return {
        session_id: index.session_id,
        latest_snapshot: index.snapshot,
        created_at: manifest.created_at,
        last_stop_at: active.get(index.session_id),
      };
    })
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}
