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

// Builds the container URL. A SAS token is appended as a query string and used instead of
// Entra ID. The token must come from the environment, never from config.json or the repo.
export function azureContainerUrl(accountUrl: string, containerName: string, sasToken?: string): string {
  const url = new URL(accountUrl);
  if (url.protocol !== "https:") {
    throw new Error("Azure account URL must use https");
  }
  const base = `${url.origin}/${containerName}`;
  if (sasToken === undefined) return base;
  const query = sasToken.replace(/^\?/, "");
  if (!query.includes("sig=")) {
    throw new Error("SAS token must be a query string containing sig=");
  }
  return `${base}?${query}`;
}

// Opens a container. With a SAS token the SAS authorises requests; otherwise Entra ID
// (DefaultAzureCredential) is used, not account keys. Construction does not contact Azure.
export function openAzureContainer(accountUrl: string, containerName: string, sasToken?: string): BlobContainerLike {
  const url = azureContainerUrl(accountUrl, containerName, sasToken);
  const client = sasToken === undefined
    ? new ContainerClient(url, new DefaultAzureCredential())
    : new ContainerClient(url);
  return containerFromSdk(client);
}
