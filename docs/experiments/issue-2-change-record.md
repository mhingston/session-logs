# Issue #2: session-to-PR intent reconstruction (example change record)

Status: experiment result. Source data is a private consumer-API repository and has been **redacted** for this public repo: no ticket keys, repository or table names, data values, URLs, or prompt text beyond short paraphrase. Session IDs are short prefixes so the owner can find the unredacted transcripts locally.

## 1. Chosen PR and workflow

**PR:** a single-repo, squash-merged feature PR with four commits on its feature branch (`a5f9816`, `35e7940`, `101771b`, `3ab0156`). `main` received one squash commit, so commit boundaries are lost on `main`.

**Workflow used (manual, one script):**

1. Read the squash commit body on `main` for the PR description (`git show -s <squash-sha>`).
2. Listed the feature-branch commits: `git log --format='%h %ai %an %cn | %s' origin/main..origin/<branch>`, plus `git show --stat` for each.
3. Searched local Claude Code transcripts for the ticket key to find candidate sessions: `grep -l "<KEY>" ~/.claude/projects/<project>/*.jsonl`.
4. Ran `docs/experiments/issue-2-extract.py <project-dir> <session-id>...` to get each session's title, time span, user prompts, and `git commit` Bash calls with success or failure.
5. Read the session's continuation summary for design decisions.
6. Checked "Verified" claims against Bash tool results in the transcripts.

No session-logs store exists for this repository (no `.session-logs/`, no `Session:` or `Transcript:` trailers), so linkage was reconstructed from transcripts and timestamps only.

## 2. Sessions considered

| Session (prefix) | Span (UTC) | Role | Commits made by this session? |
|---|---|---|---|
| `d17e83a6` | 2026-11-18 13:45 to 11-19 14:53 | Main implementation session | **No.** All four `git commit` calls failed (sandbox `index.lock` "Operation not permitted"). |
| `2935523b` | 2026-10-14 to 11-18 | Pre-work readiness review of the ticket and its dependencies | No. Planning only. |
| `8f3d5ba4` | 2026-11-18, 4 min | Test coverage for the upstream proxy PR, a separate repo | No, in this repo. |

`d17e83a6` also mentions a different ticket, so keyword search alone would have linked it to the wrong PR. Matching by ticket key needs a manual check.

## 3. Example change record

**Objective.** Show a fair-pricing alert only when the pricing service flags a policy as paid under 100% last year. The alert is a generic message, and the flag must be fetched through the upstream proxy.

**Decisions (from the continuation summary and user prompts):**
- The user chose "option A": expose the flag through the proxy, then map it into the pricing response. The alternative was not recorded in the extracted text, so its details are unknown.
- Missing or null flag hides the message (fail-closed). The proxy parameter is default-off, so existing callers are unchanged.
- A reviewer asked what "Ly" meant, so the flag was renamed to last-year wording in `101771b`. The data column name stayed unchanged.
- The duplicate-row lookup uses `LIMIT 1` with no ordering. This was accepted after a data check found one duplicate, with both flags false.
- Deployment order: the proxy is deployed first. This is written in the PR body but not verified.

**Verification, as claimed vs evidenced:**

| Claim in PR description | Evidence in transcripts | Assessment |
|---|---|---|
| Release build clean, "no error lines" | Release builds at 11:18 failed with sandbox permission errors. A later run, executed through a different shell tool, returned empty filtered output. No "Build succeeded" line was captured. The PR itself says "Summary line not captured". | **Weak.** An empty grep is not a build result. |
| Tests not run locally | No "Passed!" or "Failed!" output in any session. The test project failed to build with an environment error. | **Accurate.** |
| Data check on the flag | Queries were attempted in a session. Counts and results were not re-run. | **Not independently verified.** |
| Rebased onto `origin/main` | No rebase command in the transcript. | **Unverified.** |

**Commit-to-session evidence:**

| Commit | Time (UTC) | Trailer | Nearest preceding user prompt | Link strength |
|---|---|---|---|---|
| `a5f9816` | 11-19 11:26 | `Co-Authored-By` only | "open a pr" at 11:24 | Heuristic |
| `35e7940` | 11-19 11:43:59 | `Co-Authored-By` only | Failed commit attempt at 11:43:13 | Heuristic. The session did not produce it. |
| `101771b` | 11-19 13:20 | `Co-Authored-By` only | "address comments" at 13:16 | Heuristic |
| `3ab0156` | 11-19 13:29 | `Co-Authored-By` only | "another review" at 13:28 | Heuristic |

No commit carries a `Session:` or `Transcript:` trailer, so none is linked by an authoritative record.

## 4. Gaps, misleading attribution, and effort

- **Misleading attribution.** The transcript shows the session attempted every commit and failed. A reviewer reading the trailers-free history might assume the session made the commits. Presenting it as the author would be wrong, and the commits were probably made outside the session.
- **Keyword matching.** A second ticket appears in the main session, so text search alone would over-link.
- **Missing context.** Commit boundaries disappear on `main`. The intent is in the transcript, not in the diff or PR body.
- **Noise.** About a dozen prompts concern sandbox and shell-tool configuration. A reviewer does not need these, and they should be filtered out of any generated record.
- **Manual effort.** Roughly two hours of reading across three sessions to produce this record. The extractor reduced reading time but did not remove judgement.
- **Sensitive content.** The transcripts contain internal data values, URLs, and ticket text. The record has to be redacted before it reaches a public repository.

## 5. Comparison with PR description and git history alone

- **Added value:** the transcript gives the decision trail (options, reviewer questions, deployment order) and shows which verification claims rest on evidence. Neither the PR body nor `git log` says either of these.
- **Not added:** the PR body already contains a useful "Verified / Not verified" section. The transcript mostly confirmed it and exposed one overstated claim.
- **Trustworthiness of links:** the links here are timestamp-based. They are plausible but not provable, and the one session that discussed the commits did not make them.

## 6. Recommendation

**Continue, narrowly.** The transcript added decision and verification context that the PR body and git history do not contain, and it exposed an overstated build claim. Most of the value came from reading the text, though, not from the link mechanism this tool exists for. Here the link mechanism was not exercised, because the repository had no trailers.

**Smallest next increment:** enable session-logs in one repository and produce one PR with real commits. Generate the change record from trailers rather than timestamps. Ask a reviewer to rate it against the PR description on the same five criteria from the issue. Do not build PR integration or a new capture format before that result.

## 7. Trailer-linked trial (follow-up)

This is the "smallest next increment" from section 6, run on one private repository where session-logs was installed (`init`) before the work started.

**Setup:** an Orca-launched Claude Code chat was given a bounded brief: one small change on a new local branch, two or three commits, no push, no PR, and no staging of the session-logs setup files. The branch was based on `origin/main`.

**Exact workflow (placeholders in angle brackets):**

```sh
# 1. Install session-logs once per repository (writes hooks and .claude/settings.local.json).
node <session-logs>/src/cli/init.ts                         # run in <repo>
node <session-logs>/src/cli/sessions.ts doctor              # expect no warnings

# 2. Launch the Claude Code chat in the repository's main worktree.
orca agent launch --agent claude --worktree id:<repoId>::<repoPath> --prompt "<bounded brief>" --json

# 3. Wait until the agent reports done (poll agent list; no fixed sleep).
orca agent list --json                                      # state: working -> done

# 4. Read the link back from the repository.
node <session-logs>/src/cli/sessions.ts commits <session-id>
node <session-logs>/src/cli/sessions.ts doctor
node <session-logs>/src/cli/sessions.ts show HEAD
```

Steps 1 to 4 are the whole workflow. Each push and PR was a separate, explicit approval; none was automated.

**Result:**

| Check | Result |
|---|---|
| Commits with trailers | 2 of 2. Both carry `Session:` and `Transcript:` trailers. |
| `sessions commits <session>` | Returns both commits. The link is exact, with no timestamp heuristic. |
| `sessions doctor` | No unlinked commits. |
| `sessions show HEAD` | Renders the brief and the transcript from the commit's snapshot. |
| Commits pushed | Yes, to a new remote branch. A PR was opened by mistake in the work repo and then abandoned. |

**What the trailers prove:** the session recorded these two commits. They do not prove the report's claims are true.

**What the transcript added that the trailers did not:**
- The first `git checkout -b` partly failed on a sandbox error. The agent detected it, checked the working tree, and switched branches. A reviewer would want this noted. The trailers do not show it.
- Local `main` was two commits behind `origin/main`. The agent chose `origin/main` and said so.

**Verification as claimed vs evidenced:**
- Release builds of the Application and its tests: 0 errors. Evidenced in the transcript.
- Full Application test run: 577 passed, 1 skipped, 0 failed. Evidenced, but it ran with `DOTNET_ROLL_FORWARD=Major` on a .NET 11 runtime. The report says so.
- Not built or tested: the WebApi and subscriber targets, and the new test against the old code. The report says so.

**Assessment:** the trailer link is trustworthy here, and it is the strongest link in this experiment. The remaining gaps are in the claims, not in attribution. A reviewer still has to judge whether the report's "verified" items are sufficient.

**Recommendation (updated):** continue. The next increment is a reviewer rating of this trial's record against its PR description on the five criteria in the issue. Do not build PR integration or a new capture format before that rating exists.
