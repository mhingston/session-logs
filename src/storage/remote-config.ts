import type { ObjectStore } from "./object-store.ts";
import { AzureBlobStore, type BlobContainerLike } from "./azure-blob-store.ts";
import { openAzureContainer } from "./azure-sdk.ts";

// Per-repository remote configuration (decisions D18, D29).
// Remote storage is off unless explicitly enabled. A disabled config never
// touches a container, even if one is supplied.
export type RemoteConfig =
  | { enabled: false }
  | {
      enabled: true;
      provider: "azure-blob";
      accountUrl: string;
      container: string;
      prefix?: string;
    };

export interface RemoteDeps {
  // Test seam: supplies a container instead of opening the real Azure one.
  azureContainer?: () => BlobContainerLike;
}

export function createRemoteStore(
  config: RemoteConfig,
  deps: RemoteDeps = {},
): ObjectStore | undefined {
  if (!config.enabled) {
    return undefined;
  }
  if (config.provider === "azure-blob") {
    const container = deps.azureContainer
      ? deps.azureContainer()
      : openAzureContainer(config.accountUrl, config.container);
    return new AzureBlobStore({ container, prefix: config.prefix });
  }
  throw new Error("unsupported remote provider");
}
