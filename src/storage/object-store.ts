import { createHash } from "node:crypto";

// Provider-agnostic content-addressed store (decision D9, D19).
// Keys are sha256 hex digests of the bytes stored under them.
export interface ObjectStore {
  has(hash: string): Promise<boolean>;
  put(hash: string, bytes: Uint8Array): Promise<void>;
  get(hash: string): Promise<Uint8Array | undefined>;
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
