import { createHash } from "node:crypto";

// Provider-agnostic content-addressed store (decision D9, D19).
// Keys are sha256 hex digests of the bytes stored under them.
export interface ObjectStore {
  has(hash: string): Promise<boolean>;
  put(hash: string, bytes: Uint8Array): Promise<void>;
  get(hash: string): Promise<Uint8Array | undefined>;
  // Immutable records that are not content-addressed (summaries, decision extracts).
  // A put to a name that already exists is a no-op.
  putNamed(name: string, bytes: Uint8Array): Promise<void>;
  getNamed(name: string): Promise<Uint8Array | undefined>;
}

export const NAMED_OBJECT_PATTERN = /^(summaries|decisions)\/[0-9a-f]{64}\.json$/;

export function assertName(name: string): void {
  if (!NAMED_OBJECT_PATTERN.test(name)) {
    throw new Error(`named object must be summaries/<snapshot>.json or decisions/<snapshot>.json: ${name}`);
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export function assertHash(hash: string): void {
  if (!HASH_PATTERN.test(hash)) {
    throw new Error("object hash must be 64 lowercase hex characters");
  }
}
