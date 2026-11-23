#!/usr/bin/env bash
# Live check for two open M0 items. Run this in YOUR terminal: it needs api.anthropic.com.
#   1. Does a Stop hook's stderr reach the user? (marker printed to stderr by the probe)
#   2. Does a forked session emit SessionStart with source "resume" or "fork"?
# Output: a fresh repo with probe hooks, the captured payloads (field names and
# source values only), and a summary. Nothing is sent anywhere except to Claude.
set -euo pipefail

TOOL="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$HOME/Downloads/live-check-$(date +%Y%m%d-%H%M%S)}"
PROBE="$OUT/probe"
mkdir -p "$OUT/repo" "$PROBE"
cd "$OUT/repo"

git init -q -b main .
git config user.name live-check
git config user.email live-check@example.invalid
node "$TOOL/src/cli/init.ts" >/dev/null

# Add probe hooks next to the session-logs Stop hook, without removing it.
python3 - "$PROBE" <<'PY'
import json, sys
probe = sys.argv[1]
path = ".claude/settings.local.json"
settings = json.load(open(path))
def probe_cmd(name, extra=""):
    return f"sh -c 'cat > {probe}/$(date +%s%N)-{name}.json; {extra} exit 0'"
hooks = settings.setdefault("hooks", {})
hooks.setdefault("SessionStart", []).append({"hooks": [{"type": "command", "command": probe_cmd("sessionstart")}]})
hooks.setdefault("Stop", []).append({"hooks": [{"type": "command", "command": probe_cmd("stop", "echo PROBE_STOP_STDERR_MARKER >&2;")}]})
hooks.setdefault("UserPromptSubmit", []).append({"hooks": [{"type": "command", "command": probe_cmd("prompt")}]})
json.dump(settings, open(path, "w"), indent=2)
PY

echo "== run 1: new session"
claude -p "Reply OK." >"$OUT/run1.stdout" 2>"$OUT/run1.stderr" || true

SID="$(python3 - "$PROBE" <<'PY'
import glob, json, sys, os
files = sorted(glob.glob(os.path.join(sys.argv[1], "*-sessionstart.json")))
print(json.load(open(files[0]))["session_id"] if files else "")
PY
)"
if [ -z "$SID" ]; then
  echo "No SessionStart payload captured. Check $OUT/run1.stderr"; exit 1
fi

echo "== run 2: fork of session $SID"
claude -p --resume "$SID" --fork-session "Reply OK." >"$OUT/fork.stdout" 2>"$OUT/fork.stderr" || true

python3 - "$PROBE" "$OUT" <<'PY'
import glob, json, os, sys
probe, out = sys.argv[1], sys.argv[2]
print("\n== SessionStart payloads (field names and source only)")
for f in sorted(glob.glob(os.path.join(probe, "*-sessionstart.json"))):
    d = json.load(open(f))
    print(f"  source={d.get('source')!r} session_id={d.get('session_id')!r} keys={sorted(d.keys())}")
print("\n== UserPromptSubmit payloads (field names only)")
for f in sorted(glob.glob(os.path.join(probe, "*-prompt.json"))):
    d = json.load(open(f))
    print(f"  keys={sorted(d.keys())}")
print("\n== Stop payloads (field names only)")
for f in sorted(glob.glob(os.path.join(probe, "*-stop.json"))):
    d = json.load(open(f))
    print(f"  keys={sorted(d.keys())}")
print("\n== Stop stderr visibility")
for name in ("run1", "fork"):
    err = open(os.path.join(out, f"{name}.stderr")).read()
    out_text = open(os.path.join(out, f"{name}.stdout")).read()
    print(f"  {name}: marker in claude stderr={'PROBE_STOP_STDERR_MARKER' in err}, in stdout={'PROBE_STOP_STDERR_MARKER' in out_text}")
print("\nFor the user-visible check, run an interactive `claude` in the repo and watch for the marker in the UI.")
PY
echo "Output in: $OUT"
