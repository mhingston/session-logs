# session-logs

Record Claude Code session transcripts and link them to the git commits they produced.

> **Status: early development.** Only the storage layer exists so far. There is no capture hook, no commit trailers and no command-line tool yet. Nothing here captures transcripts from your sessions.

## What it will do

- Store each Claude Code session's transcript in `.session-logs/` inside the repository.
- Link every commit made during a session to that session and to the transcript snapshot it used.
- Let you read a commit's transcript as it was at commit time.
- Optionally sync transcripts to Azure Blob Storage, for teammates and auditors.

Design decisions are recorded in [`docs/DECISIONS.md`](docs/DECISIONS.md). Findings from the first spike are in [`docs/M0-findings.md`](docs/M0-findings.md).

## Where transcripts live

| Location | Default | Notes |
|---|---|---|
| `.session-logs/` in each repository | On (once capture exists) | Gitignored. Transcripts never enter git history. |
| Azure Blob Storage | **Off** | Opt-in per repository. Sync is not wired into any command yet. |

Transcripts can contain secrets and personal data. Read the privacy notes before you enable anything.

## Remote storage (Azure Blob)

Remote storage is disabled unless a repository explicitly enables it:

```ts
import { createRemoteStore } from "./src/storage/remote-config.ts";

const store = createRemoteStore({
  enabled: true,
  provider: "azure-blob",
  accountUrl: "https://<account>.blob.core.windows.net", // https only
  container: "session-logs",
  prefix: "objects/",            // optional
});
// `store` is undefined when enabled is false.
```

- **Authentication** uses Entra ID through `DefaultAzureCredential` (for example, `az login` or a managed identity). Account keys are not used.
- **Access** needs data-plane permission on the container, such as Storage Blob Data Contributor.
- **Who can read:** anyone with read access to the container can read every transcript in it. Access tiers are not part of the MVP.
- **Deletion:** not implemented. Removing a blob does not remove copies held by clones or teammates.
- **Redaction:** not implemented yet. Do not enable remote storage until the redaction pass exists (see decision D24).

Objects are content-addressed by SHA-256. Writes are idempotent, and both reads and writes verify the bytes against their hash.

## Development

Requires Node.js 23.6 or later. Node runs the TypeScript sources directly.

```sh
npm install
npm test          # unit tests; no network access needed
npm run typecheck # requires TypeScript (see below)
npm run check     # both
```

`npm run typecheck` needs the TypeScript compiler and Node type definitions, which are not yet in `package.json`. Add them with:

```sh
npm install --save-dev --save-exact typescript@5.9.3 @types/node@26.6.6
```

## Layout

```
src/storage/object-store.ts      provider-agnostic interface and hashing
src/storage/azure-blob-store.ts  content-addressed store over a narrow container interface
src/storage/azure-sdk.ts         Azure SDK adapter (the only file that imports the SDK)
src/storage/remote-config.ts     opt-in factory; remote is off by default
test/                            node:test suites
docs/                            decision log and spike findings
```

Claude Code is the only agent this design targets. Agent-specific code will sit behind an adapter so other agents can be added later.

## Licence

Not yet decided.
