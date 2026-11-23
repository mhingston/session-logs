// Best-effort pattern redaction (handoff §9, D24). Runs on every line before
// it is written to a segment. It is NOT a guarantee: it catches common key
// formats only, and the docs must say so.
//
// Redaction replaces the matched secret with [REDACTED:<kind>] and reports
// counts per kind. The secret itself is never returned or logged.

export interface RedactionRule {
  kind: string;
  pattern: RegExp;
}

export const RULES: readonly RedactionRule[] = [
  { kind: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "aws-access-key", pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "github-token", pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g },
  { kind: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "openai-key", pattern: /\bsk-[A-Za-z0-9]{32,}\b/g },
  { kind: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  {
    kind: "connection-string-secret",
    pattern: /\b(AccountKey|SharedAccessKey|Password|Pwd)=[^;\s"']{8,}/gi,
  },
  {
    kind: "assigned-secret",
    pattern: /\b(api[_-]?key|secret|token|password|passwd)\b(["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi,
  },
];

export interface RedactionResult {
  text: string;
  counts: Record<string, number>;
}

export function redact(text: string): RedactionResult {
  const counts: Record<string, number> = {};
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (match, ...groups: unknown[]) => {
      counts[rule.kind] = (counts[rule.kind] ?? 0) + 1;
      // For assigned-secret, keep the key name and separator so the line stays readable.
      if (rule.kind === "assigned-secret") {
        const [name, separator] = groups as [string, string];
        return `${name}${separator}[REDACTED:${rule.kind}]`;
      }
      return `[REDACTED:${rule.kind}]`;
    });
  }
  return { text: out, counts };
}

export function mergeCounts(into: Record<string, number>, from: Record<string, number>): void {
  for (const [kind, n] of Object.entries(from)) {
    into[kind] = (into[kind] ?? 0) + n;
  }
}
