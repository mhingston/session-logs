// Commit-message trailer handling (handoff §5, §6; D4, D36).
//
// Session and Transcript are kept as ordered pairs: the i-th Transcript belongs to
// the i-th Session. A squash can carry several pairs, so pairs are never collapsed
// to one. Also-Active and Reverts are sets.

export interface Pair {
  session: string;
  snapshot?: string;
}

export interface ExtractedTrailers {
  body: string[];
  pairs: Pair[];
  alsoActive: string[];
  reverts: string[];
}

const SESSION = /^Session: (.+)$/;
const TRANSCRIPT = /^Transcript: (.+)$/;
const ALSO_ACTIVE = /^Also-Active: (.+)$/;
const REVERTS = /^Reverts: (.+)$/;

// Removes the session-logs trailers from the message and returns them in order.
// Other lines, including git's comment lines, are returned as body unchanged.
export function extractTrailers(lines: string[]): ExtractedTrailers {
  const sessions: string[] = [];
  const transcripts: string[] = [];
  const alsoActive: string[] = [];
  const reverts: string[] = [];
  const body: string[] = [];
  for (const line of lines) {
    let match: RegExpMatchArray | null;
    if ((match = line.match(SESSION))) {
      sessions.push(match[1]!.trim());
    } else if ((match = line.match(TRANSCRIPT))) {
      transcripts.push(match[1]!.trim());
    } else if ((match = line.match(ALSO_ACTIVE))) {
      alsoActive.push(match[1]!.trim());
    } else if ((match = line.match(REVERTS))) {
      reverts.push(match[1]!.trim());
    } else {
      body.push(line);
    }
  }
  const count = Math.max(sessions.length, transcripts.length);
  const pairs: Pair[] = [];
  for (let i = 0; i < count; i++) {
    pairs.push({ session: sessions[i] ?? "unknown-session", snapshot: transcripts[i] });
  }
  return { body, pairs, alsoActive, reverts };
}

// Adds or updates the primary session's pair. If the session is already linked,
// its snapshot is replaced (amend); otherwise the pair is appended (new session).
export function linkPrimary(pairs: Pair[], primary: Pair | undefined): Pair[] {
  if (!primary) {
    return pairs;
  }
  const index = pairs.findIndex((pair) => pair.session === primary.session);
  if (index === -1) {
    return [...pairs, primary];
  }
  return pairs.map((pair, i) => (i === index ? { ...pair, snapshot: primary.snapshot } : pair));
}

export function union(existing: string[], added: string[]): string[] {
  const out = [...existing];
  for (const value of added) {
    if (!out.includes(value)) {
      out.push(value);
    }
  }
  return out;
}
