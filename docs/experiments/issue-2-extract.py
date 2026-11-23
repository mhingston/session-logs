"""One-off extractor for issue #2: summarise Claude Code transcripts for review.

Reads raw Claude Code JSONL transcripts (no session-logs store required) and
prints, per session: title, time span, user prompts, and each `git commit`
Bash call with whether it succeeded. Read-only; prints to stdout only.

Usage:
  python3 issue-2-extract.py <transcript-dir> <session-id> [<session-id> ...]
"""

import json
import sys
from pathlib import Path

PROMPT_LIMIT = 120


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(b.get("text", "") for b in content if b.get("type") == "text")
    return ""


def summarise(path: Path):
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    timestamps = [r["timestamp"] for r in rows if r.get("timestamp")]
    titles = [r["aiTitle"] for r in rows if r.get("type") == "ai-title" and r.get("aiTitle")]
    print(f"== {path.stem}")
    print(f"title: {titles[-1] if titles else '-'}")
    if timestamps:
        print(f"span:  {timestamps[0]} -> {timestamps[-1]}")

    tool_calls = {}
    for r in rows:
        for b in (r.get("message") or {}).get("content") or []:
            if isinstance(b, dict) and b.get("type") == "tool_use":
                tool_calls[b["id"]] = (r.get("timestamp"), b.get("name"), b.get("input") or {})

    print("commit calls:")
    for r in rows:
        for b in (r.get("message") or {}).get("content") or []:
            if not isinstance(b, dict) or b.get("type") != "tool_result":
                continue
            ts, name, inp = tool_calls.get(b.get("tool_use_id"), (None, None, {}))
            command = inp.get("command", "")
            if name != "Bash" or "git commit" not in command:
                continue
            result = json.dumps(b.get("content"))
            outcome = "FAILED" if ("Exit code" in result or "error" in result[:200].lower()) else "ok?"
            print(f"  {ts} {outcome}: {command[-110:]!r}")

    print("user prompts:")
    for r in rows:
        if r.get("type") != "user":
            continue
        content = (r.get("message") or {}).get("content")
        if isinstance(content, list):
            continue
        message = text_of(content).strip()
        if not message or message.startswith("<") or "Another Claude session" in message:
            continue
        print(f"  {r.get('timestamp')} {message[:PROMPT_LIMIT]!r}")
    print()


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    directory = Path(sys.argv[1])
    for session_id in sys.argv[2:]:
        summarise(directory / f"{session_id}.jsonl")


if __name__ == "__main__":
    main()
