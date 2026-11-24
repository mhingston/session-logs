# session-logs

Record Claude Code session transcripts and link every git commit to the session that produced it.

## Quick start

**Prerequisites:** Node.js 23.6 or later (`node -v`), `git`, and Claude Code.

### 1. Clone and verify (once)

```sh
git clone https://github.com/mhingston/session-logs
cd session-logs
npm install
npm run check          # type-check and test suite
```

Optional — add shell aliases (e.g. in `~/.zshrc` or `~/.bashrc`) so you don't have to type the full path:

```sh
alias sessions-init='node /path/to/session-logs/src/cli/init.ts'
alias sessions='node /path/to/session-logs/src/cli/sessions.ts'
```

### 2. Enable in a repository (once per clone)

```sh
cd /path/to/your-repo
node /path/to/session-logs/src/cli/init.ts
node /path/to/session-logs/src/cli/sessions.ts doctor
```

`doctor` should report no warnings (`info  no unlinked commits found during recorded sessions`).

### 3. Work as normal

```sh
claude                 # work in a session (from the repo root or any subdirectory)
git commit -am "Your change"
```

Every commit made during or after a session gets two trailers automatically:

```
Session: 2c087fae-f67a-4647-8eb6-e790c1e31844
Transcript: a53e7356f3e25c3e299a87cf142a603eff5d3c99c3fa3b619ed0aadf1fcb3713
```

`Transcript:` is the snapshot ID — it points to the transcript as it was at commit time, even if the session continues later.

### 4. Read it back

```sh
node /path/to/session-logs/src/cli/sessions.ts list
node /path/to/session-logs/src/cli/sessions.ts show HEAD
```

If `show` finds nothing, run `doctor` first.

## What it does

- **Captures** each session's conversation at every turn end (Claude Code `Stop` hook) and stores it in `.session-logs/` at the repository root (even if Claude Code was launched from a subdirectory). The folder is gitignored, so transcripts never enter git history.
- **Links** each commit to the session that produced it, with `Session:` and `Transcript:` trailers, through a git hook. The link survives amend, squash, cherry-pick, revert and rebase.
- **Reads** a commit's transcript as it was when the commit was made, even after the session continued. On squashed commits that combine multiple sessions, `show` renders every linked transcript (or pass `--session <id>` to filter to one).
- **Extracts decisions** (opt-in) with a deterministic rule set: sentences with explicit decision language, tied to the snapshot they came from. No model or network call. See [Decision extracts](#decision-extracts).
- **Redacts** common secret formats (private keys, cloud and API keys, bearer tokens, connection strings) before anything is written. This is best effort. Do not rely on it as the only control.
- **Keeps your git hooks working.** Your global hooks (for example Husky or Repowise) still run first.
- **Links commits made mid-turn.** A commit made while Claude is working links to that session, however many commits it makes in that turn. A turn left open for more than 2 hours (for example after an interrupt) no longer claims commits.

## Commands

Run these from anywhere inside the repository. Replace the path with wherever you cloned this tool (or use the `sessions` alias from Quick start). Run `sessions --help` at any time for a summary.

```sh
S=/path/to/session-logs/src/cli/sessions.ts

node $S list                             # sessions recorded in this repository (12-char snapshot IDs)
node $S list --full                      # sessions with full 64-char snapshot IDs
node $S commits <session-id>             # commits linked to a session
node $S show <rev>                       # transcript(s) as of that commit (conversation turns only)
node $S show <rev> --session <id>        # one session's transcript from a squashed commit
node $S show <rev> --raw                 # stored JSONL, one entry per line
node $S doctor                           # health check: hooks, store integrity, unlinked commits, missing notes
node $S notes show <rev>                 # the git note for a commit (its session trailers)
node $S notes rebuild                    # rebuild every note from trailers
node $S decisions <rev>                  # deterministic decision extract for a commit's transcript (needs opt-in)
node $S decisions <rev> --json           # same, as JSON with snapshot and content hash
node $S summary <rev>                    # LLM summary of a commit's transcript (needs opt-in; generates if missing)
node $S fork <session> --at <snapshot>   # new session record from a snapshot (full ID or unique prefix from list)
node $S prune --older-than 30            # dry run: which old, unlinked sessions would be removed
node $S prune --older-than 30 --apply    # delete them
node $S remote push <rev>                # push a commit's linked snapshots and summaries (needs remote config)
node $S remote fetch <rev>               # fetch a commit's linked snapshots from the remote
```

Pruning is **off** unless you pass `--older-than` or set `prune.olderThanDays` in `.session-logs/config.json`. It removes whole sessions only, and never linked ones unless you pass `--include-linked`. Pruning a linked session makes `show` fail for those commits.

Git notes: each linked commit also has a git note, `sessions notes show <rev>`, derived from its trailers. Notes are updated on commit and rewrite. They live under `.session-logs/notes.git`, not in the main repository's refs.

Forks link to their parent automatically when Claude Code forks a session (`claude --resume <id> --fork-session`). The parent is found from message IDs that the fork shares with stored transcripts.

## Decision extracts

Three separate layers. Each is controlled on its own:

| Layer | Status | Enabled by | Makes an LLM call |
|---|---|---|---|
| Transcript capture and commit links | `init` | No |
| Deterministic decision extract | `decisions.enabled` in `.session-logs/config.json` | No |
| LLM-generated summary (opt-in) | `summaries.enabled` in `.session-logs/config.json` | Yes: `claude -p`, in a background worker |

Git notes are commit-link metadata (the session trailers). They are not decision summaries.

Enabling capture never enables extraction. To opt in, create `.session-logs/config.json` in the repository:

```json
{ "decisions": { "enabled": true } }
```

With that set, every snapshot captured by the Stop hook also gets an extract. You can also generate one on demand with `sessions decisions <rev>`, which is refused while the setting is off.

What the extract does:

- Scans each stored `user` and `assistant` message, sentence by sentence, and keeps sentences that contain an explicit signal: `Decision:`, `decided`, `chose`, `opted`, `settled on`, `going with`, `instead of`, or `trade-off`. This is a heuristic. It finds stated decisions, not every choice the agent made.
- Repeated sentences are reported once, at their first occurrence.
- Runs on the redacted snapshot only, so it cannot contain anything the transcript store does not.
- Is written to `.session-logs/decisions/<snapshot>.json`, keyed by the snapshot ID. It records the snapshot ID, the session ID, the hash of the snapshot's content, and each decision's message index and UUID. An extract is never rewritten; a changed transcript gets its own snapshot and extract.
- Is deterministic: the same transcript always gives the same decisions.

## Summaries

LLM summaries are a separate opt-in layer. They are off by default and are not turned on by capture or by decision extraction. Enable them with `"summaries": { "enabled": true }` in `.session-logs/config.json`. Other keys in that file are unaffected.

- **Model:** Claude Code itself, run headless (`claude -p`). It uses the login you already have for Claude Code. session-logs makes no other network call for summaries.
- **Input:** only the stored, redacted `user` and `assistant` text of the snapshot (D24, D44). Redaction is best effort, and a summary can still repeat anything that survived it. Transcripts over 200,000 characters keep their most recent messages, and the record says so.
- **Trigger:** the Stop hook starts a detached worker, so the hook returns at once. The worker writes `.session-logs/summaries/<snapshot>.json`. Failures go to `errors.log` as error text only, with the exit status or signal and never the model's stderr or output. A snapshot that already has a summary is not summarized again.
- **Locking:** a per-snapshot lock file is held while the model runs. Workers, `sessions summary` and `prune` all use it. Two callers never call the model for the same snapshot, and `prune` skips a session whose summary is in progress. A lock older than 15 minutes is treated as left behind by a dead process.
- **Size limit:** if even the newest message is over 200,000 characters, no summary is made and the error is logged.
- **Recursion guard:** the summarizer's own run sets `SESSION_LOGS_SUMMARIZING=1`, and the Stop hook ignores any run that has it. The run uses no tools, saves no session, and starts in a temporary directory.
- **Not deterministic:** the output is model text. Each record names its snapshot and the source content hash, so you can trace it to the transcript version it describes. Treat it as a draft and check it against the transcript.

`sessions summary <rev>` prints the stored summary. If none exists yet and summaries are enabled, it generates one in the foreground.

## Agent skill

`skills/session-logs/SKILL.md` teaches Claude Code to answer "why was this commit made?" from a session's transcript, and to run `doctor`. Claude Code only loads skills from `~/.claude/skills` or `.claude/skills`, so link it once:

```sh
mkdir -p ~/.claude/skills && ln -s /path/to/session-logs/skills/session-logs ~/.claude/skills/session-logs
```

## What is stored

- Only `user` and `assistant` conversation entries are stored. Session metadata, cost data, and injected system context (your CLAUDE.md, managed policy text, memory) are not stored. Each snapshot's manifest counts what was left out, by type.
- Transcripts are split into segments of up to 500 messages or 1 MB. Closed segments never change, so later snapshots reuse them.
- A snapshot's ID is the SHA-256 of its manifest. A segment is stored under the SHA-256 of its bytes.

## Where things live

| What | Where | Notes |
|---|---|---|
| Transcripts, snapshots, session records | `.session-logs/` in the repository | Gitignored. Local only. |
| Commit hooks | `.session-logs/git-hooks/` | Set as the repository's `core.hooksPath`. |
| Claude Code hook registration (Stop, UserPromptSubmit) | `.claude/settings.local.json` | Per developer. Gitignored. |
| Git notes (session links per commit) | `.session-logs/notes.git` | A bare repository, read through git alternates. Rebuildable from trailers. Nothing is written to the main repository's refs. |
| Decision extracts (opt-in) | `.session-logs/decisions/<snapshot>.json` | Gitignored. Local only. Created only when `decisions.enabled` is true. |
| Summaries (opt-in) | `.session-logs/summaries/<snapshot>.json` | Gitignored. Local only. Created only when `summaries.enabled` is true. |
| Opt-in settings | `.session-logs/config.json` | `{ "decisions": { "enabled": true }, "summaries": { "enabled": true }, "remote": { ... } }`. Also holds `prune.olderThanDays`. The `remote` block is described in [Remote storage](#remote-storage). |
| Hook errors | `.session-logs/errors.log` | Error text only; never transcript content. |
| Decisions | `docs/DECISIONS.md` | |

## Installation details

`init` does three things in the repository:

1. Points `core.hooksPath` at `.session-logs/git-hooks`. Each git hook shim runs your global hook of the same name first, then session-logs:
   - `prepare-commit-msg` adds the session trailers, and also runs the repository's own `.git/hooks` script.
   - `post-commit` and `post-rewrite` refresh the git notes. `post-commit` also pushes the linked snapshots when remote storage is enabled.
   - `pre-commit` and `commit-msg` only chain to your existing hooks.
2. Registers two Claude Code hooks in `.claude/settings.local.json`: `UserPromptSubmit` (marks a turn open, so commits made mid-turn link to it) and `Stop` (snapshots the transcript).
3. Adds `.session-logs/` and `.claude/settings.local.json` to `.gitignore`.

It refuses to replace a `core.hooksPath` it did not set (for example Husky's), so it cannot silently disable other tools. It is safe to re-run.

**If you move this checkout, re-run `init` in each repository.** The hooks and settings contain its absolute path; re-running `init` replaces stale paths cleanly, and `doctor` warns if any registered hook points to a missing script.

## Troubleshooting

- **`show` says "has no Transcript trailer".** The commit was made outside a session, or the hook did not run. Run `doctor`.
- **`doctor` warns "commit hooks are not installed".** Run `init` in this repository.
- **`doctor` reports an unlinked commit during a session.** This is a heuristic: it thinks a session was active when the commit was made. Check it. Commits made with `--no-verify` are still linked, by design (D45).
- **A commit has no trailers.** Read `.session-logs/errors.log`. The commit still succeeds when a hook fails, by design.
- **`prune` says it is off.** Pass `--older-than <days>`.
- **`doctor` warns that linked commits have no note.** Run `sessions notes rebuild`.
- **Commits made mid-turn have no link.** Re-run `init`. It registers the `UserPromptSubmit` hook, which older installs lack.
- **Hooks stopped working after moving the checkout.** Re-run `init`.

## Remote storage

Remote storage is off by default. When enabled, the post-commit hook pushes the snapshots that commit links to Azure Blob Storage, with each snapshot's summary and decision extract when they exist. A summary written after its commit is pushed when it is written. Enable it in `.session-logs/config.json` in the repository:

```json
{
  "remote": {
    "enabled": true,
    "provider": "azure-blob",
    "accountUrl": "https://<account>.blob.core.windows.net",
    "container": "<container>"
  }
}
```

- **Auth:** by default, Entra ID through `DefaultAzureCredential` (for example `az login`). Your identity then needs Storage Blob Data Contributor on the container to push and Storage Blob Data Reader to fetch. Alternatively, set `SESSION_LOGS_AZURE_SAS` in your shell to a SAS token (the query string, starting `sp=` or `?sp=`); it is used instead of Entra ID. The token is read from the environment only and is never written to `config.json` or the repository. Set it per session, for example `export SESSION_LOGS_AZURE_SAS='sv=...&sig=...'`. Account keys are not supported. `accountUrl` must be the bare account URL; a path, query string or credentials there are rejected.
- **Push:** runs in the post-commit hook. Failures are logged to `.session-logs/errors.log` (error text only) and never block the commit. The hook waits for the upload, so a slow connection delays it.
- **Redaction gate (D24):** a snapshot with redactions is not pushed and is logged. `sessions remote push <rev> --allow-redacted` overrides this; the override is logged by count only.
- **Fetch:** `sessions show` and `sessions summary` fetch a missing snapshot from the remote on demand, along with its summary and decision extract. A snapshot already in the local store is never re-fetched. `sessions remote fetch <rev>` brings in a commit's snapshots explicitly. A clone needs the same `remote` block in its own `.session-logs/config.json`. Every object's hash is verified.
- **Who can read:** anyone with read access to the container can read every transcript in it. Access tiers are not part of the MVP.
- **Deletion:** removing blobs does not remove copies held by clones or teammates.

## What is not done

- **Automatic fetch:** fetch is manual (`sessions remote fetch <rev>`).
- **Subagent transcripts:** not captured (D23).
- **Redaction:** best effort and pattern-based. It misses secrets that do not match a known format.
- **Decision summaries:** the deterministic extract is built (opt-in). LLM summaries are built (opt-in, P1) and are model output, so they can be wrong. The extract finds explicit decision wording only.
- **Concurrent sessions in one repository:** a commit links the most recent session that stopped since the previous commit, and lists others as `Also-Active:`. The link is a heuristic, not proof of which session wrote the change.

## Design

The decision log is [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Verifying against real Claude Code

Unit tests do not call Claude Code. To check the hooks against a live session, run this in your own terminal (it needs API access):

```sh
cd /path/to/session-logs
scripts/live-check.sh
```

It creates a throwaway repository, runs a session and a fork, and prints the hook payload fields and the fork's `SessionStart` source.

## Development

```sh
npm install
npm test          # unit and integration tests; no network access
npm run typecheck # TypeScript, strict
npm run check     # both
```

Layout:

```
src/cli/               sessions (read and maintenance) and init entry points
src/capture/           capture core, redaction, commit-trailer rules
src/hooks/             Claude Code Stop and UserPromptSubmit hooks; git commit, post-commit and post-rewrite hooks
src/install/           init: hook shims and settings registration
src/notes/             git notes under .session-logs/notes.git
src/read/              show, commits, list
src/maintain/          fork, doctor, prune
src/decisions/         deterministic decision extracts (opt-in)
src/summaries/         LLM summaries via claude -p (opt-in, background worker)
src/remote/            push and fetch (opt-in, Azure Blob)
src/storage/           object store interface and Azure Blob adapter (opt-in)
scripts/live-check.sh  live Claude Code checks (run in your terminal; needs API access)
test/                  node:test suites
docs/                  decision log
```

Claude Code is the only supported agent. Agent-specific code lives in `src/hooks/` and `src/install/`, so another agent would need its own hook adapter.

## Licence

MIT. See [`LICENSE`](LICENSE).
