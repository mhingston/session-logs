# session-logs

Record Claude Code session transcripts and link them to the git commits they produced.

> **Status: early development.** Local capture works: a Claude Code `Stop` hook snapshots the transcript, and a git hook adds `Session:` and `Transcript:` trailers. Secrets are redacted before anything is written. Read commands exist (`sessions show`, `commits`, `list`). Commit trailers are handled for amend, squash, cherry-pick, rebase and revert. `fork`, `doctor` and `prune` exist. Remote push and fetch exist as library code, not yet wired to any command. The notes index is not built. The live Claude Code run has not been verified.

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

## Installing into a repository

From inside the target repository:

```sh
node /path/to/session-logs/src/cli/init.ts
```

This points `core.hooksPath` at managed hooks under `.session-logs/git-hooks`, which chain your global hooks first. It registers the Stop hook in `.claude/settings.local.json` and adds `.session-logs/` and that file to `.gitignore`. It refuses to replace a `core.hooksPath` it did not set, such as Husky's. Re-running it is safe.

If you move this checkout, re-run `init` in each repository: the hooks and settings record its absolute path.

## Reading sessions

```sh
node /path/to/session-logs/src/cli/sessions.ts list               # sessions in this repo
node /path/to/session-logs/src/cli/sessions.ts commits <session>  # commits linked to a session
node /path/to/session-logs/src/cli/sessions.ts show <rev>         # transcript as at that commit
node /path/to/session-logs/src/cli/sessions.ts show <rev> --raw   # redacted JSONL
```

`show` renders only conversation turns. The raw output includes every stored entry.

Maintenance:

```sh
node /path/to/session-logs/src/cli/sessions.ts fork <session> --at <snapshot>
node /path/to/session-logs/src/cli/sessions.ts doctor
node /path/to/session-logs/src/cli/sessions.ts prune --older-than 30            # dry run
node /path/to/session-logs/src/cli/sessions.ts prune --older-than 30 --apply    # delete
```

`prune` is off unless you pass `--older-than` or set `prune.olderThanDays` in `.session-logs/config.json`. It keeps sessions that commits link to, unless you pass `--include-linked`. Pruning a linked session makes `show` fail for those commits.

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

## What is stored

Only `user` and `assistant` conversation entries are stored (D44). Session metadata, cost state, and injected system context (CLAUDE.md, managed policy, memory) are not stored. The manifest counts what was excluded, by type.

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
src/capture/capture.ts           segmenting, manifest and snapshot writer (local .session-logs/)
src/hooks/stop.ts                Claude Code Stop hook; always exits 0
src/hooks/prepare-commit-msg.ts  git hook that adds trailers; always exits 0
test/                            node:test suites
docs/                            decision log and spike findings
```

Claude Code is the only agent this design targets. Agent-specific code will sit behind an adapter so other agents can be added later.

## Licence

MIT. See [`LICENSE`](LICENSE).
