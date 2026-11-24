import { assertHash, assertName, sha256Hex, type ObjectStore } from "./object-store.ts";

// Minimal surface of an Azure Blob container client. The real
// @azure/storage-blob client satisfies this; tests use an in-memory fake.
// Kept narrow so the SDK is wired in at the edge, not in the core.
export interface BlobLike {
  exists(): Promise<boolean>;
  upload(body: Uint8Array): Promise<void>;
  download(): Promise<Uint8Array | undefined>;
}

export interface BlobContainerLike {
  blob(name: string): BlobLike;
}

export interface AzureBlobStoreOptions {
  container: BlobContainerLike;
  // Prefix inside the container, e.g. "session-logs/<repo-id>/objects/".
  prefix?: string;
}

// Content-addressed object store on Azure Blob Storage (decision D18).
// Objects are immutable: put is a no-op when the blob already exists, and
// put verifies that the bytes match the hash they are stored under.
export class AzureBlobStore implements ObjectStore {
  private readonly container: BlobContainerLike;
  private readonly prefix: string;

  constructor(options: AzureBlobStoreOptions) {
    this.container = options.container;
    this.prefix = options.prefix ?? "objects/";
  }

  private blobFor(hash: string): BlobLike {
    assertHash(hash);
    return this.container.blob(`${this.prefix}${hash}`);
  }

  async has(hash: string): Promise<boolean> {
    return this.blobFor(hash).exists();
  }

  async put(hash: string, bytes: Uint8Array): Promise<void> {
    const actual = sha256Hex(bytes);
    if (actual !== hash) {
      throw new Error(`object bytes do not match hash ${hash}`);
    }
    const blob = this.blobFor(hash);
    if (await blob.exists()) {
      return;
    }
    await blob.upload(bytes);
  }

  async get(hash: string): Promise<Uint8Array | undefined> {
    const bytes = await this.blobFor(hash).download();
    if (bytes === undefined) {
      return undefined;
    }
    if (sha256Hex(bytes) !== hash) {
      throw new Error(`stored object ${hash} failed integrity check`);
    }
    return bytes;
  }

  private blobForName(name: string): BlobLike {
    assertName(name);
    return this.container.blob(`${this.prefix}${name}`);
  }

  async putNamed(name: string, bytes: Uint8Array): Promise<void> {
    const blob = this.blobForName(name);
    if (await blob.exists()) {
      return;
    }
    await blob.upload(bytes);
  }

  async getNamed(name: string): Promise<Uint8Array | undefined> {
    return this.blobForName(name).download();
  }
}
