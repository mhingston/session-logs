import { ContainerClient, isRestError, type BlockBlobClient } from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import type { BlobContainerLike, BlobLike } from "./azure-blob-store.ts";

// Edge adapter: connects the Azure SDK to the narrow interfaces in
// azure-blob-store.ts. Keeping the SDK here means the core and its tests do
// not depend on it.

// Maps one SDK block blob client onto BlobLike. A 404 on download means the
// object is absent, which the store reports as undefined.
export function blobFromSdk(client: BlockBlobClient): BlobLike {
  return {
    exists: () => client.exists(),
    upload: async (body) => {
      await client.uploadData(body);
    },
    download: async () => {
      try {
        return new Uint8Array(await client.downloadToBuffer());
      } catch (error) {
        if (isRestError(error) && error.statusCode === 404) {
          return undefined;
        }
        throw error;
      }
    },
  };
}

export function containerFromSdk(container: ContainerClient): BlobContainerLike {
  return {
    blob: (name) => blobFromSdk(container.getBlockBlobClient(name)),
  };
}

// Opens a container using Entra ID (DefaultAzureCredential), not account keys.
// Construction does not contact Azure; the first request does.
export function openAzureContainer(accountUrl: string, containerName: string): BlobContainerLike {
  const url = new URL(accountUrl);
  if (url.protocol !== "https:") {
    throw new Error("Azure account URL must use https");
  }
  const credential = new DefaultAzureCredential();
  return containerFromSdk(new ContainerClient(`${url.origin}/${containerName}`, credential));
}
