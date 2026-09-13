#!/usr/bin/env bash
# Stop hook for pi-spawned Claude sessions.
# Writes the sentinel file that tells the parent this session finished a turn.

set -euo pipefail

# Read JSON input from stdin
input=$(cat)

# Guard: if stop_hook_active is true, we're in a loop — bail out
stop_hook_active=$(echo "$input" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('stop_hook_active', False))" 2>/dev/null || echo "False")
if [ "$stop_hook_active" = "True" ]; then
  exit 0
fi

# Guard: only act for pi-spawned sessions
if [ -z "${PI_CLAUDE_SENTINEL:-}" ]; then
  exit 0
fi

# Write the transcript pointer BEFORE the sentinel.
#
# The sentinel's mere existence is what tells the parent this run finished
# (pollForExit tests existsSync), and the parent then immediately copies the
# Claude session via the .transcript pointer and deletes both files. So the
# pointer has to be on disk first or a poll landing in between loses the
# session copy permanently — measured at a ~20ms window when written the other
# way round.
transcript_path=$(echo "$input" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('transcript_path', ''))" 2>/dev/null || echo "")
if [ -n "$transcript_path" ]; then
  echo "$transcript_path" > "${PI_CLAUDE_SENTINEL}.transcript" 2>/dev/null || true
fi

# Now signal completion — unconditionally, and with no dependency on the
# transcript existing.
#
# This file is the only completion signal the parent has for an interactive
# `claude` child. The old version wrote it only when the transcript held
# exactly one user message — meant as "no human interjected", but a Skill
# invocation, a task notification or a single steer all add one, so completion
# detection broke permanently for that session and the parent watched it until
# timeout. It also sat behind a `[ -f "$transcript_path" ]` guard, so a
# transcript rotated away meant no sentinel at all — even though
# last_assistant_message rides the stdin payload, not the transcript.
#
# Temp + rename because the parent treats existence as completion: a plain `>`
# truncates first, so a poll landing mid-write would see a complete signal
# carrying an empty result.
tmp="${PI_CLAUDE_SENTINEL}.$$"
if echo "$input" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('last_assistant_message', ''))" > "$tmp" 2>/dev/null; then
  mv -f "$tmp" "$PI_CLAUDE_SENTINEL" || true
else
  rm -f "$tmp"
  # Still signal completion — the parent falls back to scraping the pane.
  : > "$PI_CLAUDE_SENTINEL"
fi

exit 0
