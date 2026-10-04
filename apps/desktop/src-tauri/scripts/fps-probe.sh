#!/usr/bin/env bash
# Run the SysCode desktop shell in FPS-probe mode and print the measured rate.
#
# Usage: scripts/fps-probe.sh [label] [extra env...]
#   SYSCODE_FPS_FIX=0  disables the 120Hz unlock so the baseline can be measured.
#
# The harness (see src/main.rs) makes the window visible/focused/always-on-top,
# runs a 3s requestAnimationFrame loop inside the page, and writes
# /tmp/syscode-fps.json before exiting on its own.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$HERE/target/release/syscode-desktop"
LABEL="${1:-run}"
OUT="/tmp/syscode-fps.json"
LOG="/tmp/syscode-fps-${LABEL}.log"

rm -f "$OUT"
echo "=== probe: $LABEL ==="
SYSCODE_PROJECT="${SYSCODE_PROJECT:-/home/haze/projects/syscode/fixtures/demo-app}" \
SYSCODE_FPS_PROBE=1 \
"$BIN" >"$LOG" 2>&1 &
PID=$!

for _ in $(seq 1 90); do
  [ -f "$OUT" ] && break
  kill -0 "$PID" 2>/dev/null || break
  sleep 1
done

kill "$PID" 2>/dev/null
wait "$PID" 2>/dev/null

if [ -f "$OUT" ]; then
  echo "RESULT($LABEL): $(cat "$OUT")"
else
  echo "RESULT($LABEL): NO RESULT — see $LOG"
  tail -20 "$LOG"
fi
