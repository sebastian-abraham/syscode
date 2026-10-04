#!/usr/bin/env bash
# Proves the stability rules from the brief:
#   1. editing code marks the affected node stale instead of silently lying
#   2. the refresh produces a proposal, not a regeneration
#   3. node identity, user positions and pinned constraints survive it all
#   4. approving the proposal clears the stale flag and re-anchors the node
#
# usage: scripts/stability.sh [port] [project-dir]
set -uo pipefail
PORT="${1:-4317}"
PROJECT="${2:-fixtures/demo-app}"
BASE="http://127.0.0.1:$PORT"
pass=0; fail=0
ok()   { echo "  ok   $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL $1"; fail=$((fail+1)); }
check(){ if [ "$2" -eq 0 ]; then ok "$1"; else bad "$1"; fi; }
j()    { jq -r "$1" 2>/dev/null; }

TARGET="$PROJECT/src/orders/create-order.ts"
[ -f "$TARGET" ] || { echo "  cannot find $TARGET"; exit 2; }
BACKUP="$(mktemp)"
cp "$TARGET" "$BACKUP"
restore() { cp "$BACKUP" "$TARGET"; rm -f "$BACKUP"; }
trap restore EXIT

# a developer renames a node and pins it in place — this must survive everything below
MAP=$(curl -s "$BASE/api/map")
NODE_ID=$(printf '%s' "$MAP" | jq -r '.nodes[] | select(.label=="Orders" or .label=="Order lifecycle") | .id' | head -1)
[ -n "$NODE_ID" ] || NODE_ID=$(printf '%s' "$MAP" | j '.nodes[0].id')
LABEL_BEFORE=$(printf '%s' "$(curl -s "$BASE/api/node/$NODE_ID")" | j '.label')
curl -s -X PATCH "$BASE/api/node/$NODE_ID" -H 'content-type: application/json' \
  -d '{"label":"Order lifecycle","position":{"x":42,"y":-17},"positionLocked":true}' > /dev/null
curl -s -X POST "$BASE/api/node/$NODE_ID/note" -H 'content-type: application/json' \
  -d '{"body":"order ids must never be reused","kind":"constraint"}' > /dev/null

STALE_BEFORE=$(curl -s "$BASE/api/project" | j '.stats.staleCount')
NODES_BEFORE=$(curl -s "$BASE/api/project" | j '.stats.nodeCount')
echo "  target node: $LABEL_BEFORE ($NODE_ID), $NODES_BEFORE nodes, $STALE_BEFORE stale"

# --- the developer edits code by hand -----------------------------------------
printf '\n// hand-edited by the developer during the stability check\nexport function orderAgeDays(createdAt: Date): number {\n  return Math.floor((Date.now() - createdAt.getTime()) / 86400000);\n}\n' >> "$TARGET"
echo "  appended a function to $TARGET"

REPORT=$(curl -s -X POST "$BASE/api/refresh")
CHANGES=$(printf '%s' "$REPORT" | j '.changes | length')
STALE_MARKED=$(printf '%s' "$REPORT" | j '.staleMarked')
PROPOSALS=$(printf '%s' "$REPORT" | j '.proposalsCreated')
echo "  refresh: $CHANGES change(s), $STALE_MARKED node(s) marked stale, $PROPOSALS proposal(s) created"

[ "${STALE_MARKED:-0}" -ge 1 ]; check "changed code marks the node stale" $?
[ "${PROPOSALS:-0}" -ge 1 ]; check "refresh proposes instead of regenerating" $?

# assert on whatever node the engine itself flagged, not on a guess
FLAGGED=$(printf '%s' "$REPORT" | jq -r '[.changes[] | select(.nodeId != null) | .nodeId][0] // empty')
[ -n "${FLAGGED:-}" ] || FLAGGED="$NODE_ID"
AFTER=$(curl -s "$BASE/api/node/$FLAGGED")
[ "$(printf '%s' "$AFTER" | j '.stale')" = "true" ]; check "the flagged node reports stale" $?
AFTER=$(curl -s "$BASE/api/node/$NODE_ID")
[ "$(printf '%s' "$AFTER" | j '.label')" = "Order lifecycle" ]; check "the developer's rename survived" $?
[ "$(printf '%s' "$AFTER" | j '.position.x')" = "42" ]; check "the pinned position survived" $?
[ "$(printf '%s' "$AFTER" | j '.notes | length')" -ge 1 ]; check "the pinned constraint survived" $?

NODES_AFTER=$(curl -s "$BASE/api/project" | j '.stats.nodeCount')
[ "$NODES_AFTER" -ge "$NODES_BEFORE" ]; check "node count did not collapse (no regeneration): $NODES_BEFORE → $NODES_AFTER" $?
[ "$(curl -s "$BASE/api/map" | j '.staleCount')" -ge 1 ]; check "the map view surfaces the stale count" $?

PID=$(curl -s "$BASE/api/proposals" | j '[.[] | select(.status=="pending")][0].id')
[ -n "${PID:-}" ]; check "a pending proposal exists" $?
printf '%s' "$(curl -s "$BASE/api/proposals")" | j '[.[] | select(.status=="pending")][0].rationale' | head -3

# accept every proposal the refresh raised, the way the interface does
PENDING=$(curl -s "$BASE/api/proposals" | j '[.[] | select(.status=="pending")] | length')
APPROVED=0
for id in $(curl -s "$BASE/api/proposals" | jq -r '.[] | select(.status=="pending") | .id'); do
  curl -s -X POST "$BASE/api/proposals/$id/approve" > /tmp/syscode-approve2.json
  [ "$(jq -r '.proposal.status' /tmp/syscode-approve2.json)" = "approved" ] && APPROVED=$((APPROVED+1))
done
[ "$APPROVED" -eq "$PENDING" ]; check "approve every map update ($APPROVED/$PENDING)" $?
FINAL=$(curl -s "$BASE/api/node/$NODE_ID")
[ "$(printf '%s' "$FINAL" | j '.stale')" = "false" ]; check "approving clears the stale flag" $?
[ "$(printf '%s' "$FINAL" | j '.label')" = "Order lifecycle" ]; check "rename still intact after approval" $?
[ "$(printf '%s' "$FINAL" | j '.anchors | length')" -ge 1 ]; check "node is re-anchored to the new code" $?

# --- revert the hand edit and settle ------------------------------------------
restore
trap - EXIT
curl -s -X POST "$BASE/api/refresh" > /dev/null
echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ]
