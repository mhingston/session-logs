import type { ObjectStore } from "./object-store.ts";
import { AzureBlobStore, type BlobContainerLike } from "./azure-blob-store.ts";

// Per-repository remote configuration (decisions D18, D29).
// Remote storage is off unless explicitly enabled. A disabled config never
// touches a container, even if one is supplied.
export type RemoteConfig =
  | { enabled: false }
  | { enabled: true; provider: "azure-blob"; prefix?: string };

export interface RemoteDeps {
  // Resolves the Azure container client for an enabled config.
  azureContainer?: () => BlobContainerLike;
}

export function createRemoteStore(
  config: RemoteConfig,
  deps: RemoteDeps,
): ObjectStore | undefined {
  if (!config.enabled) {
    return undefined;
  }
  if (config.provider === "azure-blob") {
    if (!deps.azureContainer) {
      throw new Error("azure-blob remote enabled but no container client supplied");
    }
    return new AzureBlobStore({
      container: deps.azureContainer(),
      prefix: config.prefix,
    });
  }
  throw new Error(`unsupported remote provider`);
}
