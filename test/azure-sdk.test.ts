import { test } from "node:test";
import assert from "node:assert/strict";
import { RestError, type BlockBlobClient } from "@azure/storage-blob";
import { azureContainerUrl, blobFromSdk, openAzureContainer } from "../src/storage/azure-sdk.ts";

// Stub of the SDK block blob client surface used by blobFromSdk.
function sdkClient(options: {
  exists?: boolean;
  download?: () => Promise<Buffer>;
  uploaded?: Uint8Array[];
}): BlockBlobClient {
  return {
    exists: async () => options.exists ?? false,
    uploadData: async (body: Uint8Array) => {
      options.uploaded?.push(body as Uint8Array);
      return {};
    },
    downloadToBuffer: options.download ?? (async () => Buffer.from("")),
  } as unknown as BlockBlobClient;
}

test("download maps a 404 RestError to undefined (object absent)", async () => {
  const blob = blobFromSdk(
    sdkClient({
      download: async () => {
        throw new RestError("BlobNotFound", { statusCode: 404 });
      },
    }),
  );
  assert.equal(await blob.download(), undefined);
});

test("download rethrows other service errors", async () => {
  const blob = blobFromSdk(
    sdkClient({
      download: async () => {
        throw new RestError("Forbidden", { statusCode: 403 });
      },
    }),
  );
  await assert.rejects(blob.download(), /Forbidden/);
});

test("download returns the bytes as a Uint8Array", async () => {
  const blob = blobFromSdk(sdkClient({ download: async () => Buffer.from("hello") }));
  const bytes = await blob.download();
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(bytes), "hello");
});

test("upload and exists delegate to the SDK client", async () => {
  const uploaded: Uint8Array[] = [];
  const blob = blobFromSdk(sdkClient({ exists: true, uploaded }));
  assert.equal(await blob.exists(), true);
  await blob.upload(new Uint8Array([1, 2, 3]));
  assert.equal(uploaded.length, 1);
  const first = uploaded[0];
  assert.ok(first);
  assert.deepEqual([...first], [1, 2, 3]);
});

test("openAzureContainer returns blob handles without contacting Azure", () => {
  const container = openAzureContainer("https://acct.blob.core.windows.net", "session-logs");
  const blob = container.blob("objects/abc");
  assert.equal(typeof blob.exists, "function");
  assert.equal(typeof blob.upload, "function");
  assert.equal(typeof blob.download, "function");
});

test("a SAS token is appended to the container URL; bad tokens and non-https are rejected", () => {
  const account = "https://acct.blob.core.windows.net";
  assert.equal(
    azureContainerUrl(account, "c", "?sp=r&sig=fabricated"),
    "https://acct.blob.core.windows.net/c?sp=r&sig=fabricated",
  );
  assert.equal(azureContainerUrl(account, "c"), "https://acct.blob.core.windows.net/c");
  assert.throws(() => azureContainerUrl(account, "c", "sp=r"), /sig=/);
  assert.throws(() => azureContainerUrl("http://acct.blob.core.windows.net", "c", "sp=r&sig=x"), /https/);
  assert.doesNotThrow(() => openAzureContainer(account, "c", "sp=r&sig=fabricated"));
});
