import { test } from "node:test";
import assert from "node:assert/strict";
import { createRemoteStore } from "../src/storage/remote-config.ts";
import type { BlobContainerLike } from "../src/storage/azure-blob-store.ts";

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

test("enabled azure-blob config builds a store from the supplied container", () => {
  const container: BlobContainerLike = { blob: () => { throw new Error("unused"); } };
  const store = createRemoteStore(
    { enabled: true, provider: "azure-blob", prefix: "objects/" },
    { azureContainer: () => container },
  );
  assert.ok(store);
});

test("enabled azure-blob config without a container fails loudly", () => {
  assert.throws(
    () => createRemoteStore({ enabled: true, provider: "azure-blob" }, {}),
    /no container client supplied/,
  );
});
