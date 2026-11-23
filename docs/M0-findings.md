# M0 findings

Status: spike partly complete. Claude Code hook contract checked against the live docs (code.claude.com/docs/en/hooks.md, via a web-fetch agent; Stop section partly summarised, so re-check before M1). Git plumbing checked locally on git 2.56.1.

## Claude Code hooks

| Item | Finding | Status |
|---|---|---|
| Common stdin fields | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`, `prompt_id` | Verified (quoted) |
| Stop fires | When the main agent finishes responding. Not on user interrupt. API errors fire `StopFailure` instead. | Verified (summary) |
| Stop input | `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons` | Verified (summary) |
| Stop exit 2 | Prevents Claude stopping and continues the conversation. | Verified |
| Stop stderr shown to user | Not documented. | Unverified |
| Command hook timeout | 600 s default | Verified |
| SessionEnd | Exists. Input includes `reason` (`clear`, `resume`, `logout`, `prompt_input_exit`, `other`). Stderr shown to user only. | Verified (table); section not read verbatim |
| PostToolUse input | `tool_name`, `tool_input`, `tool_use_id`, `tool_response` | Reported, not re-checked |
| Subagent transcripts | Stored under `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`, sharing the main `sessionId`. Checked on 451 local main transcripts and 362 subagent files: **no main transcript contains subagent turns** (`isSidechain: true`). Capturing `transcript_path` alone misses subagent work. | Verified locally |
| Resume and fork | SessionStart `source` includes `fork` (verified). Whether a fork emits `resume` too: not documented. | Partly verified |

### Design consequences

1. **The capture hook must always exit 0.** Exit 2 on Stop keeps the agent running, so a snapshot error must never surface as exit 2. This is the single most important hook rule.
2. **Hook input is the adapter boundary (D19).** Only the Claude Code adapter reads `session_id`, `transcript_path` and `hook_event_name`. The core takes a normalised `{session_id, transcript_path, agent, event}`.
3. **Subagents stay out of MVP (D23).** Manifest keeps `includes_subagents: false`. Confirmed: `transcript_path` does not contain subagent turns, so enabling them needs a separate capture path.
4. **Hook timeout is 600 s, so the snapshot can run inline on Stop.** Synthetic 50 MB run took about 49 ms of CPU (see Measured), so inline is viable pending real git writes.

## Git plumbing (local, git 2.56.1)

| Item | Finding |
|---|---|
| `commit-tree` + `update-ref <ref> <new> <old>` | Works. Stale CAS write rejected. |
| `interpret-trailers --if-exists replaceIfDifferent` | **Invalid value; exit 129.** Handoff §5 is wrong. |
| Valid `--if-exists` values | `addIfDifferentNeighbor` (default), `addIfDifferent`, `add`, `replace`, `doNothing` |
| Amend with `replace` | Replaces `Transcript:` with the new value. One line remains (verified). |
| `post-rewrite` input | `<old> SP <new> [SP extra] LF` on stdin, first arg `amend` or `rebase` (per `githooks(5)`). |

### Required spec changes

- Amend and commit: use `--if-exists replace`.
- Squash (M3): use `addIfDifferent` so duplicate `Session:` and `Transcript:` lines collapse.
- Cherry-pick: keep existing trailers, add nothing new.

## Git hooks on this machine

- Global `core.hooksPath` is `~/.config/git/hooks`. Repo-local `.git/hooks/prepare-commit-msg` is **ignored** while it is set. There is no global `prepare-commit-msg`, so installation needs a decision (D32).
- Existing global `pre-commit` (chains to Husky) and `post-commit` (Repowise) hooks would be shadowed by a repo-local `core.hooksPath`.

## Smoke test (M1 hooks, simulated Stop payload)

Run in fake repositories under the temp directory, with the Stop hook driven by a hand-written JSON payload. Claude Code itself was not run.

- Two commits, each after a Stop: each links to its own snapshot; `Session:` and `Transcript:` each appear once.
- Amend with an unchanged transcript: one of each trailer, and no new snapshot.
- Snapshot store made read-only: the commit succeeds, a warning is printed, the error is logged without content, and the earlier snapshot is intact.

## Live Claude Code run (verified 2026-11-23)

Run by the owner from an ordinary terminal: `claude -p "Reply OK."` in a fresh repo (`~/Downloads/foo`) after `init`.

- The Stop hook fired on a completed turn. `current.json` held the real `session_id` and `transcript_path` (`~/.claude/projects/<project>/<session_id>.jsonl`).
- The snapshot was written: session index, manifest and objects all exist. The `cwd` field was present, since the snapshot landed in the repo.
- No `errors.log` was written.

- A commit in the same repo got `Session:` and `Transcript:` trailers with the real global hook chain. The `Transcript:` value points at a snapshot that exists.

Still not verified: whether the Stop hook's stderr reaches the user, and whether a fork emits `SessionStart` with `resume`.

## Transcript contents (found while rendering a live transcript)

A live transcript contains more than the conversation: session metadata, attachments, cost state, and `api-request-blob` entries. The `api-request-blob` entries carry the injected system context, which includes managed policy text, the user's CLAUDE.md and memory. Raw capture stores them (D7). Whether to keep them is an open owner decision (D38).

## Measured

- Segmenting, hashing and manifest build for a 50 MB synthetic transcript (45,155 messages, 91 segments): about 49 ms of CPU. Excludes git object writes and Blob uploads, so it is a lower bound. Re-measure with real git writes in M1.

## Still open for M0

- Stop stderr visibility to the user (affects how the warn-only policy, D26, is surfaced).
- Whether a fork emits a `SessionStart` with `resume`.
- Azure Blob: container owner not yet named (owner decision).
