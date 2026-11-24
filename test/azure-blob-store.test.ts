import { test } from "node:test";
import assert from "node:assert/strict";
import { AzureBlobStore, type BlobContainerLike, type BlobLike } from "../src/storage/azure-blob-store.ts";
import { sha256Hex } from "../src/storage/object-store.ts";

class FakeBlob implements BlobLike {
  uploads = 0;
  private readonly store: Map<string, Uint8Array>;
  private readonly name: string;
  constructor(store: Map<string, Uint8Array>, name: string) {
    this.store = store;
    this.name = name;
  }
  async exists(): Promise<boolean> {
    return this.store.has(this.name);
  }
  async upload(body: Uint8Array): Promise<void> {
    this.uploads += 1;
    this.store.set(this.name, body);
  }
  async download(): Promise<Uint8Array | undefined> {
    return this.store.get(this.name);
  }
}

function fakeContainer() {
  const blobs = new Map<string, Uint8Array>();
  const handles = new Map<string, FakeBlob>();
  const container: BlobContainerLike = {
    blob(name) {
      let handle = handles.get(name);
      if (!handle) {
        handle = new FakeBlob(blobs, name);
        handles.set(name, handle);
      }
      return handle;
    },
  };
  return { container, blobs, handles };
}

const payload = new TextEncoder().encode('{"schema_version":1}');
const hash = sha256Hex(payload);

test("put then get round-trips bytes under the content hash", async () => {
  const { container, blobs } = fakeContainer();
  const store = new AzureBlobStore({ container, prefix: "objects/" });
  await store.put(hash, payload);
  assert.ok(blobs.has(`objects/${hash}`));
  assert.deepEqual(await store.get(hash), payload);
});

test("get returns undefined for a missing object", async () => {
  const store = new AzureBlobStore({ container: fakeContainer().container });
  assert.equal(await store.get(hash), undefined);
  assert.equal(await store.has(hash), false);
});

test("put is idempotent: a second put does not re-upload", async () => {
  const { container, handles } = fakeContainer();
  const store = new AzureBlobStore({ container });
  await store.put(hash, payload);
  await store.put(hash, payload);
  assert.equal(handles.get(`objects/${hash}`)?.uploads, 1);
});

test("put rejects bytes that do not match the hash", async () => {
  const store = new AzureBlobStore({ container: fakeContainer().container });
  await assert.rejects(store.put(hash, new TextEncoder().encode("tampered")), /do not match/);
});

test("get rejects a stored object whose bytes were altered", async () => {
  const { container, blobs } = fakeContainer();
  const store = new AzureBlobStore({ container });
  await store.put(hash, payload);
  blobs.set(`objects/${hash}`, new TextEncoder().encode("altered"));
  await assert.rejects(store.get(hash), /integrity check/);
});

test("rejects malformed hashes before touching the container", async () => {
  let touched = false;
  const container: BlobContainerLike = {
    blob() {
      touched = true;
      throw new Error("should not be reached");
    },
  };
  const store = new AzureBlobStore({ container });
  await assert.rejects(store.get("../../etc/passwd"), /64 lowercase hex/);
  assert.equal(touched, false);
});

test("named summary and decision objects are immutable and reject other names", async () => {
  const { container, blobs, handles } = fakeContainer();
  const store = new AzureBlobStore({ container, prefix: "objects/" });
  const name = `summaries/${hash}.json`;
  await store.putNamed(name, payload);
  await store.putNamed(name, new TextEncoder().encode("replaced"));
  assert.equal(handles.get(`objects/${name}`)?.uploads, 1);
  assert.deepEqual(blobs.get(`objects/${name}`), payload);
  assert.deepEqual(await store.getNamed(name), payload);
  await assert.rejects(store.putNamed("../escape.json", payload), /named object must be/);
});
