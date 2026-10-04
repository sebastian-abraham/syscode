#!/usr/bin/env bash
# Run the SysCode desktop shell in FPS-probe mode and print what it measured.
#
# Usage: scripts/fps-probe.sh [label] [idle|interact|both]
#   idle      (default) measure the page at rest
#   interact  also drive synthetic node selections while measuring — this is the case
#             that feels stuttery, and it is invisible to an idle measurement
#   both      run one after the other and print both, for a like-for-like comparison
#
# Environment:
#   SYSCODE_FPS_FIX=0     disables the 120Hz unlock so the capped baseline can be measured
#   SYSCODE_FPS_INTERACT=1  same as passing `interact`
#
# The harness (see src/main.rs) makes the window visible/focused/always-on-top, opens a
# project (the interface starts on its picker, which has no canvas to measure), samples
# requestAnimationFrame deltas for ~4s, and writes /tmp/syscode-fps.json before exiting.
#
# The report carries the spread, not just an average: median / p95 / worst frame in ms,
# how many frames missed the 120Hz interval (missed120) and 60Hz (missed60), and how many
# exceeded 33ms (long). A page can average 120fps and still drop a 40ms frame per click.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$HERE/target/release/syscode-desktop"
LABEL="${1:-run}"
MODE="${2:-idle}"
OUT="/tmp/syscode-fps.json"

run_one() {
  local mode="$1"
  local tag="$LABEL-$mode"
  local log="/tmp/syscode-fps-${tag}.log"
  rm -f "$OUT"
  echo "=== probe: $tag ==="
  if [ "$mode" = "interact" ]; then
    SYSCODE_FPS_INTERACT=1 \
    SYSCODE_PROJECT="${SYSCODE_PROJECT:-/home/haze/projects/syscode/fixtures/demo-app}" \
    SYSCODE_FPS_PROBE=1 \
    "$BIN" >"$log" 2>&1 &
  else
    SYSCODE_PROJECT="${SYSCODE_PROJECT:-/home/haze/projects/syscode/fixtures/demo-app}" \
    SYSCODE_FPS_PROBE=1 \
    "$BIN" >"$log" 2>&1 &
  fi
  local pid=$!
  for _ in $(seq 1 90); do
    [ -f "$OUT" ] && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  if [ -f "$OUT" ]; then
    echo "RESULT($tag): $(cat "$OUT")"
  else
    echo "RESULT($tag): NO RESULT — see $log"
    tail -20 "$log"
  fi
}

case "$MODE" in
  both) run_one idle; run_one interact ;;
  *) run_one "$MODE" ;;
esac
