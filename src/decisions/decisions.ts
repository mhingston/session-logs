// Deterministic decision extracts (D21). Opt-in per repository through
// .session-logs/config.json ("decisions": { "enabled": true }). Independent of
// transcript capture: enabling capture never enables extraction. No LLM or
// network call is made here.
//
// An extract is derived only from the stored, redacted snapshot lines (D24), so it
// cannot contain anything the snapshot does not. It is stored under the snapshot
// ID, and records the content hash of the snapshot's lines (the same value the
// sessions index holds), so it can be traced to the immutable transcript version.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sessionLogsRoot, writeFileAtomic } from "../capture/capture.ts";
import { entryToText, readManifest, readSnapshotLines } from "../read/read.ts";
import { sha256Hex } from "../storage/object-store.ts";

export const EXTRACTOR_VERSION = "deterministic-v1";
export const EXTRACT_SCHEMA_VERSION = 1;
const SNAPSHOT_ID = /^[0-9a-f]{64}$/;

// A sentence is a candidate decision when it matches one of these signals.
// Heuristic by design: it finds explicit decision language, not every choice.
const SIGNALS: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: "decision-label", pattern: /\bdecision\s*:/i },
  { id: "decided", pattern: /\b(?:decided|chose|opted|settled on)\b/i },
  { id: "going-with", pattern: /\b(?:going|go) with\b/i },
  { id: "instead-of", pattern: /\binstead of\b/i },
  { id: "tradeoff", pattern: /\btrade-?offs?\b/i },
];

export interface ExtractedDecision {
  // Index of the stored line (message) the sentence came from.
  message: number;
  role: string;
  uuid?: string;
  text: string;
  signals: string[];
}

export interface DecisionExtract {
  schema_version: number;
  extractor: string;
  snapshot: string;
  session_id: string;
  // sha256 of the snapshot's stored lines, as in the sessions index (D37).
  source_content_sha256: string;
  decisions: ExtractedDecision[];
}

interface ConfigFile {
  decisions?: { enabled?: unknown };
}

function readConfig(repoRoot: string): ConfigFile {
  const file = join(sessionLogsRoot(repoRoot), "config.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ConfigFile;
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
}

// Off unless the repository's config sets decisions.enabled to true.
export function decisionsEnabled(repoRoot: string): boolean {
  return readConfig(repoRoot).decisions?.enabled === true;
}

// Splits text into candidate sentences, treating line breaks as boundaries.
function sentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

// Pure: the same lines always produce the same decisions, in transcript order.
// Repeated sentences are reported once, at their first occurrence.
export function extractDecisionsFromLines(lines: string[]): ExtractedDecision[] {
  const seen = new Set<string>();
  const decisions: ExtractedDecision[] = [];
  lines.forEach((line, message) => {
    const entry = entryToText(line);
    if (!entry) return;
    const uuid = (JSON.parse(line) as { uuid?: unknown }).uuid;
    for (const sentence of sentences(entry.text)) {
      const signals = SIGNALS.filter((s) => s.pattern.test(sentence)).map((s) => s.id);
      if (signals.length === 0 || seen.has(sentence)) continue;
      seen.add(sentence);
      decisions.push({
        message,
        role: entry.role,
        ...(typeof uuid === "string" ? { uuid } : {}),
        text: sentence,
        signals,
      });
    }
  });
  return decisions;
}

function extractPath(repoRoot: string, snapshot: string): string {
  // Snapshot IDs come from commit trailers too, so validate before touching the filesystem.
  if (!SNAPSHOT_ID.test(snapshot)) {
    throw new Error(`not a snapshot id: ${snapshot}`);
  }
  return join(sessionLogsRoot(repoRoot), "decisions", `${snapshot}.json`);
}

export function readDecisions(repoRoot: string, snapshot: string): DecisionExtract | undefined {
  const file = extractPath(repoRoot, snapshot);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as DecisionExtract;
}

// Returns the stored extract for a snapshot, generating it first if absent.
// An existing extract is never rewritten: a snapshot's content is immutable.
export function generateDecisions(repoRoot: string, snapshot: string): DecisionExtract {
  const existing = readDecisions(repoRoot, snapshot);
  if (existing) return existing;
  const manifest = readManifest(repoRoot, snapshot);
  const lines = readSnapshotLines(repoRoot, snapshot);
  const extract: DecisionExtract = {
    schema_version: EXTRACT_SCHEMA_VERSION,
    extractor: EXTRACTOR_VERSION,
    snapshot,
    session_id: manifest.session_id,
    source_content_sha256: sha256Hex(Buffer.from(lines.join("\n") + "\n", "utf8")),
    decisions: extractDecisionsFromLines(lines),
  };
  mkdirSync(join(sessionLogsRoot(repoRoot), "decisions"), { recursive: true });
  writeFileAtomic(extractPath(repoRoot, snapshot), JSON.stringify(extract, null, 2) + "\n");
  return extract;
}
