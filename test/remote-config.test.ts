import { test } from "node:test";
import assert from "node:assert/strict";
import { createRemoteStore } from "../src/storage/remote-config.ts";
import type { BlobContainerLike } from "../src/storage/azure-blob-store.ts";

const azure = {
  enabled: true as const,
  provider: "azure-blob" as const,
  accountUrl: "https://acct.blob.core.windows.net",
  container: "session-logs",
};

test("remote storage is off by default: no store and no container access", () => {
  let accessed = false;
  const store = createRemoteStore(
    { enabled: false },
    {
      azureContainer: () => {
        accessed = true;
        throw new Error("must not be called");
      },
    },
  );
  assert.equal(store, undefined);
  assert.equal(accessed, false);
});

test("enabled azure-blob config uses the supplied container in tests", () => {
  const container: BlobContainerLike = { blob: () => { throw new Error("unused"); } };
  const store = createRemoteStore(azure, { azureContainer: () => container });
  assert.ok(store);
});

test("enabled azure-blob config without a test seam opens a real container handle without network", () => {
  // Constructing the handle makes no request; it only needs a valid https URL.
  const store = createRemoteStore(azure);
  assert.ok(store);
});

test("azure-blob config rejects a non-https account URL", () => {
  assert.throws(
    () => createRemoteStore({ ...azure, accountUrl: "http://acct.blob.core.windows.net" }),
    /must use https/,
  );
});
