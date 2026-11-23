---
name: session-logs
description: Navigate Claude Code session transcripts recorded by session-logs in a git repository. Use when asked which session or transcript produced a commit, what was discussed or decided for a change, which commits a session made, to list recorded sessions, to check whether session capture is healthy, or to fork or prune sessions.
---

# session-logs

session-logs records each Claude Code session's conversation under `.session-logs/` in the repository (gitignored) and links every commit to its session with `Session:` and `Transcript:` trailers. Use it to go from a commit to the conversation that produced it, or from a session to its commits.

## Find the CLI

Run the tool from its install location. Read the absolute path from the repository's Stop hook, which `init` writes:

```sh
grep -o "[^\"' ]*src/hooks/stop.ts" .claude/settings.local.json | head -1
```

The tool root is that path minus `src/hooks/stop.ts`. Set `S` to `<tool root>/src/cli/sessions.ts` and run commands from inside the repository:

```sh
node "$S" list                    # sessions recorded in this repository
node "$S" commits <session-id>    # commits linked to a session
node "$S" show <rev>              # transcript at that commit (user and assistant turns, markdown)
node "$S" show <rev> --raw        # stored JSONL, one entry per line
node "$S" notes show <rev>        # the session trailers for a commit
node "$S" doctor                  # health check: hooks, store integrity, unlinked commits, missing notes
```

If the grep finds nothing, the repository has no session-logs install. Say so; do not guess a path.

## Common tasks

- **Why was this commit made?** `show <rev>` and read the turns that led to it. Quote only what answers the question.
- **Which session wrote a change?** `show <rev>` for the commit. If it says "has no Transcript trailer", the commit was made outside a session or the hook did not run. Run `doctor`.
- **What did a session produce?** `commits <session-id>` (IDs come from `list`).
- **Capture looks broken.** Run `doctor` and report its warnings. Hook errors are in `.session-logs/errors.log`.

## Rules

- Read-only by default. `fork`, `prune --apply`, and `notes rebuild` change local state: state the exact command and wait for approval.
- `prune` is off unless `--older-than` is given. Its dry run is the default. Pruning a linked session makes `show` fail for its commits.
- Transcripts may contain sensitive content, and redaction is best effort. Do not copy transcript text into commit messages, PR descriptions, or external services without asking.
- Commits made with `--no-verify` are still linked. A commit that is unlinked during a session is a heuristic finding, not proof of a failure.
- Concurrent sessions: a commit's `Session:` line is the most likely session, and `Also-Active:` lists the others. Do not present the link as proof of which session wrote the change.
