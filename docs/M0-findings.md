# M0 findings

Status: spike findings recorded. Claude Code hook contract checked against the live docs (code.claude.com/docs/en/hooks.md; the Stop section was partly summarised, and Stop stderr behavior was later checked live in D49). Git plumbing checked locally on git 2.56.1.

## Claude Code hooks

| Item | Finding | Status |
|---|---|---|
| Common stdin fields | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`, `prompt_id` | Verified (quoted) |
| Stop fires | When the main agent finishes responding. Not on user interrupt. API errors fire `StopFailure` instead. | Verified (summary) |
| Stop input | `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons` | Verified (summary) |
| Stop exit 2 | Prevents Claude stopping and continues the conversation. | Verified |
| Stop stderr shown to user | Not documented. | Verified by interactive check (D49) |
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

- Global `core.hooksPath` is `~/.config/git/hooks`. Repo-local `.git/hooks/prepare-commit-msg` is **ignored** while it is set. There is no global `prepare-commit-msg`; this prompted D32, resolved by D34.
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

## Live check results (`scripts/live-check.sh`, owner's terminal, 2026-11-23)

- **Fork emits `SessionStart` with `source: "fork"`, not `"resume"`.** It carries a new `session_id`. The payload has no parent session field. Extra fields on the fork payload: `context_tokens`, `estimated_cache_write_usd`, `prompt_cache_likely_expired`, `seconds_since_last_response`. The design must not assume a parent id is passed; the parent is found through the transcript or our own records.
- **Stop payload fields confirmed:** `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `last_assistant_message`, `permission_mode`, `prompt_id`, `effort`, `background_tasks`, `session_crons`, `stop_hook_active`. Both the original run and the fork fired Stop.
- **Stop hook stderr is not visible in `claude -p`.** The marker appeared in neither stdout nor stderr. That was not conclusive for interactive mode; the interactive check later resolved this by confirming stderr is not shown (D49).

Interactive check (owner, 2026-11-23): the Stop hook fired in an interactive session, and its stderr marker did not appear in the UI. Stop hook stderr is not shown to the user (D49).

Fork linkage (D48): the live fork's transcript keeps the parent's messages with their uuids. 20 of its 26 `parentUuid` references point into the parent. The writer uses that overlap to set the parent link, and it resolves to the correct parent on the live data.

## Transcript contents (found while rendering a live transcript)

A live transcript contains more than the conversation: session metadata, attachments, cost state, and `api-request-blob` entries. The `api-request-blob` entries carry the injected system context, which includes managed policy text, the user's CLAUDE.md and memory. Raw capture stored them at this stage (D7); D44 later resolved the question by retaining only `user` and `assistant` entries and counting other types without storing their content.

## Handoff test plan checks (run 2026-11-23, scratch repo, real hooks)

- **Test 12 (`--no-verify`): historical finding, resolved by D45.** A `--no-verify` commit still gets `Session:` and `Transcript:` trailers because `prepare-commit-msg` runs; D45 keeps the link and updates test 12 to match.
- **Test 14 (`reset --hard`): passes.** The session index is unchanged, the linked commit stays in the reflog, and `doctor` reports no problems.
- **Test 17 (50 MB snapshot): passes.** 45,885 messages took 178 ms through the real snapshot writer. An unchanged re-snapshot took 97 ms. The 5 s threshold was later confirmed by D46.

## Live check 2 (`scripts/live-check.sh`, owner's terminal, 2026-11-23, after D50)

- **UserPromptSubmit payload confirmed.** Fields: `session_id`, `transcript_path`, `cwd`, `prompt`, `prompt_id`, `permission_mode`, `hook_event_name`. The `prompt` field holds the user's text. Our hook does not store it; it only records the turn start (D50).
- **Fork confirmed again:** `SessionStart` `source: "fork"` with a new `session_id`.
- **Hooks recorded both sessions.** Each has an active record with `turn_open_at` and `last_stop_at`, plus a session index.
- **Fork parent link (D48) verified on live data.** The fork's first snapshot points at the original session.
- **No hook errors** (no `errors.log`).
- Stop stderr marker still absent from `claude -p` output (consistent with D49).

## Measured

- Segmenting, hashing and manifest build for a 50 MB synthetic transcript (45,155 messages, 91 segments): about 49 ms of CPU. Excludes git object writes and Blob uploads, so it is a lower bound. Re-measure with real git writes in M1.

## Still open for M0

- None of the M0 questions are open. Stop stderr is not shown to the user (D49, which means warn-only (D26) is surfaced through `doctor` and `errors.log`, not the UI). A fork emits `SessionStart` with `source: "fork"` (not `resume`).
- Remote push/fetch are implemented as library functions (D47), but CLI/container integration remains deferred. No container owner decision is needed unless that integration is selected.
