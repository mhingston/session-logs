// Push and fetch of snapshots, with their summaries and decision extracts, between the
// local store and any ObjectStore (D18, D19, D24). Used by the CLI and post-commit hook.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sessionLogsRoot, type Manifest } from "../capture/capture.ts";
import { sha256Hex, type ObjectStore } from "../storage/object-store.ts";

const HASH = /^[0-9a-f]{64}$/;

function assertId(id: string): void {
  if (!HASH.test(id)) {
    throw new Error(`not a snapshot id: ${id}`);
  }
}

export interface PushOptions {
  // Snapshots to push; default is every local snapshot.
  snapshots?: string[];
  // D24: snapshots whose manifest records redactions are blocked unless overridden.
  allowRedacted?: boolean;
}

export interface PushReport {
  pushed: string[];
  skipped: Array<{ snapshot: string; reason: string }>;
}

function totalRedactions(manifest: Manifest): number {
  return Object.values(manifest.redactions).reduce((sum, n) => sum + n, 0);
}

export async function pushSnapshots(repoRoot: string, store: ObjectStore, options: PushOptions = {}): Promise<PushReport> {
  const root = sessionLogsRoot(repoRoot);
  const local = options.snapshots ?? readdirSync(join(root, "snapshots")).map((f) => f.replace(/\.json$/, ""));
  const report: PushReport = { pushed: [], skipped: [] };
  for (const snapshot of local) {
    assertId(snapshot);
    const manifestBytes = readFileSync(join(root, "snapshots", `${snapshot}.json`));
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as Manifest;
    const redactions = totalRedactions(manifest);
    if (redactions > 0 && !options.allowRedacted) {
      report.skipped.push({ snapshot, reason: `${redactions} redaction(s) present; blocked by D24` });
      continue;
    }
    if (redactions > 0) {
      // The override is logged by count and kind only, never by content.
      mkdirSync(root, { recursive: true });
      appendFileSync(
        join(root, "remote.log"),
        `${new Date().toISOString()} override push ${snapshot} redactions=${JSON.stringify(manifest.redactions)}\n`,
      );
    }
    for (const segment of manifest.segments) {
      assertId(segment.sha256);
      if (!(await store.has(segment.sha256))) {
        await store.put(segment.sha256, readFileSync(join(root, "objects", segment.sha256)));
      }
    }
    if (!(await store.has(snapshot))) {
      await store.put(snapshot, manifestBytes);
    }
    // Derived records follow the snapshot's redaction gate above. They are written
    // after the snapshot exists, so they are pushed again when created later.
    for (const name of derivedNames(snapshot)) {
      if (existsSync(join(root, name))) {
        await store.putNamed(name, readFileSync(join(root, name)));
      }
    }
    report.pushed.push(snapshot);
  }
  return report;
}

function derivedNames(snapshot: string): string[] {
  return [`summaries/${snapshot}.json`, `decisions/${snapshot}.json`];
}

// Brings one snapshot into the local store. Local objects that already exist
// are not re-fetched. Every fetched object is verified by the store. Derived
// records (summaries, decisions) are fetched when the remote has them.
export async function fetchSnapshot(repoRoot: string, store: ObjectStore, snapshot: string): Promise<void> {
  assertId(snapshot);
  const root = sessionLogsRoot(repoRoot);
  const manifestPath = join(root, "snapshots", `${snapshot}.json`);
  if (!existsSync(manifestPath)) {
    const manifestBytes = await store.get(snapshot);
    if (!manifestBytes) {
      throw new Error(`snapshot ${snapshot} is not in the remote store`);
    }
    const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8")) as Manifest;
    mkdirSync(join(root, "objects"), { recursive: true });
    for (const segment of manifest.segments) {
      assertId(segment.sha256);
      const target = join(root, "objects", segment.sha256);
      if (existsSync(target)) continue;
      const bytes = await store.get(segment.sha256);
      if (!bytes) {
        throw new Error(`segment ${segment.sha256} for ${snapshot} is missing from the remote store`);
      }
      if (sha256Hex(bytes) !== segment.sha256) {
        throw new Error(`segment ${segment.sha256} failed its integrity check`);
      }
      writeFileSync(target, bytes);
    }
    mkdirSync(join(root, "snapshots"), { recursive: true });
    writeFileSync(manifestPath, Buffer.from(manifestBytes));
  }
  for (const name of derivedNames(snapshot)) {
    const target = join(root, name);
    if (existsSync(target)) continue;
    const bytes = await store.getNamed(name);
    if (!bytes) continue;
    const record = JSON.parse(Buffer.from(bytes).toString("utf8")) as { snapshot?: unknown };
    if (record.snapshot !== snapshot) {
      throw new Error(`remote ${name} does not name snapshot ${snapshot}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
}
