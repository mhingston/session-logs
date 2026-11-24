// Per-repository settings in .session-logs/config.json. Each opt-in feature has its
// own key and defaults to off (D21): decisions.enabled, summaries.enabled.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sessionLogsRoot } from "./capture.ts";

interface ConfigFile {
  decisions?: { enabled?: unknown };
  summaries?: { enabled?: unknown };
}

export function readConfig(repoRoot: string): ConfigFile {
  const file = join(sessionLogsRoot(repoRoot), "config.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ConfigFile;
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
}
