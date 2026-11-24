// Repository wiring for remote storage. Reads the "remote" section of
// .session-logs/config.json and opens the store (D18, D29). Off unless enabled.
// Authentication is Entra ID through DefaultAzureCredential, so the config holds
// no secrets: a SAS or account key in accountUrl is rejected.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readConfig } from "../capture/config.ts";
import { sessionLogsRoot } from "../capture/capture.ts";
import { snapshotsForCommit } from "../read/read.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { createRemoteStore, type RemoteConfig } from "../storage/remote-config.ts";
import { fetchSnapshot, pushSnapshots, type PushReport } from "./sync.ts";

export function remoteConfig(repoRoot: string): RemoteConfig {
  const raw = readConfig(repoRoot).remote;
  if (raw?.enabled !== true) return { enabled: false };
  if (raw.provider !== "azure-blob") {
    throw new Error(`unsupported remote provider: ${String(raw.provider)}`);
  }
  if (typeof raw.accountUrl !== "string" || typeof raw.container !== "string") {
    throw new Error("remote needs accountUrl and container in .session-logs/config.json");
  }
  const url = new URL(raw.accountUrl);
  if (url.search || url.hash || url.username || url.password || url.pathname !== "/") {
    throw new Error("remote accountUrl must be the bare account URL (no path, query or credentials)");
  }
  return {
    enabled: true,
    provider: "azure-blob",
    accountUrl: raw.accountUrl,
    container: raw.container,
    prefix: typeof raw.prefix === "string" ? raw.prefix : undefined,
  };
}

export function openRemote(repoRoot: string): ObjectStore | undefined {
  return createRemoteStore(remoteConfig(repoRoot));
}

// Error text for logs and CLI output. SDK errors often have an empty message, so the
// name and HTTP status are included. Remote error text never includes transcript content.
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const status = (error as { statusCode?: unknown }).statusCode;
  return [error.name, typeof status === "number" ? String(status) : undefined, error.message]
    .filter(Boolean)
    .join(" ");
}

function snapshotsOf(repoRoot: string, rev: string): string[] {
  return snapshotsForCommit(repoRoot, rev)
    .map((pair) => pair.snapshot)
    .filter((snapshot): snapshot is string => Boolean(snapshot));
}

// Pushes the snapshots a commit links to, with their derived records. Returns undefined
// when remote storage is not enabled.
export async function pushCommit(repoRoot: string, rev: string, allowRedacted = false): Promise<PushReport | undefined> {
  const store = openRemote(repoRoot);
  if (!store) return undefined;
  return pushSnapshots(repoRoot, store, { snapshots: snapshotsOf(repoRoot, rev), allowRedacted });
}

export async function fetchCommit(repoRoot: string, rev: string): Promise<string[]> {
  const store = openRemote(repoRoot);
  if (!store) throw new Error("remote storage is not enabled in .session-logs/config.json");
  const snapshots = snapshotsOf(repoRoot, rev);
  for (const snapshot of snapshots) {
    await fetchSnapshot(repoRoot, store, snapshot);
  }
  return snapshots;
}

// Pushes a snapshot only when some commit links it, so sessions without commits never
// leave the machine. Used when a summary is written after its commit was made.
export async function pushIfLinked(repoRoot: string, snapshot: string): Promise<PushReport | undefined> {
  if (!/^[0-9a-f]{64}$/.test(snapshot)) throw new Error(`not a snapshot id: ${snapshot}`);
  const store = openRemote(repoRoot);
  if (!store) return undefined;
  const linked = execFileSync(
    "git",
    ["-C", repoRoot, "log", "--all", "-1", "--format=%H", `--grep=Transcript: ${snapshot}`],
    { encoding: "utf8" },
  ).trim();
  if (!linked) return undefined;
  return pushSnapshots(repoRoot, store, { snapshots: [snapshot] });
}

// Brings a snapshot into the local store when its manifest is missing and remote storage
// is enabled. Local snapshots are never re-fetched, so this is free when they exist.
export async function ensureLocalSnapshot(repoRoot: string, snapshot: string, store?: ObjectStore): Promise<void> {
  if (existsSync(join(sessionLogsRoot(repoRoot), "snapshots", `${snapshot}.json`))) return;
  const remote = store ?? openRemote(repoRoot);
  if (!remote) return;
  await fetchSnapshot(repoRoot, remote, snapshot);
}
