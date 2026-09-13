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

# Write the sentinel FIRST, unconditionally, before anything that can bail out.
#
# This file is the only completion signal the parent has for an interactive
# `claude` child (see pollForExit in herdr.ts), and Stop only fires at a turn
# boundary. The old version wrote it only when the transcript held exactly one
# user message — meant as "no human interjected", but a Skill invocation, a
# task notification or a single steer all add one, so completion detection
# broke permanently for that session and the parent watched it until timeout.
# It also sat behind the transcript guard below, so a transcript rotated away
# meant no sentinel at all.
#
# last_assistant_message comes from the stdin payload, not the transcript, so
# this write has no dependency on either.
#
# Temp + rename because the parent treats the file's EXISTENCE as completion:
# a plain `>` truncates first, so a poll landing mid-write would see a complete
# signal carrying an empty result.
tmp="${PI_CLAUDE_SENTINEL}.$$"
if echo "$input" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('last_assistant_message', ''))" > "$tmp" 2>/dev/null; then
  mv -f "$tmp" "$PI_CLAUDE_SENTINEL" || true
else
  rm -f "$tmp"
  # Still signal completion — the parent falls back to scraping the pane.
  : > "$PI_CLAUDE_SENTINEL"
fi

# Best-effort pointer so the watcher can copy the session transcript.
transcript_path=$(echo "$input" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('transcript_path', ''))" 2>/dev/null || echo "")
if [ -n "$transcript_path" ]; then
  echo "$transcript_path" > "${PI_CLAUDE_SENTINEL}.transcript" 2>/dev/null || true
fi

exit 0
