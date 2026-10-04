#!/usr/bin/env bash
# End-to-end check of the SysCode engine API against a running server.
# usage: scripts/smoke.sh [port]   (start the engine first: npm run serve)
set -uo pipefail
PORT="${1:-4317}"
BASE="http://127.0.0.1:$PORT"
pass=0; fail=0

ok()   { echo "  ok   $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL $1"; fail=$((fail+1)); }
check(){ if [ "$2" -eq 0 ]; then ok "$1"; else bad "$1"; fi; }
j()    { jq -r "$1" 2>/dev/null; }

echo "syscode smoke test against $BASE"

# ---------------------------------------------------------------- read side
HEALTH=$(curl -s "$BASE/api/health")
[ "$(printf '%s' "$HEALTH" | j '.ok')" = "true" ]; check "health" $?

PROJECT=$(curl -s "$BASE/api/project")
[ -n "$(printf '%s' "$PROJECT" | j '.stats.nodeCount')" ]; check "project info" $?
NAME=$(printf '%s' "$PROJECT" | j '.name')

MAP=$(curl -s "$BASE/api/map")
NODE_COUNT=$(printf '%s' "$MAP" | j '.nodes | length')
[ "${NODE_COUNT:-0}" -gt 0 ]; check "root map view ($NODE_COUNT nodes)" $?
NODE_ID=$(printf '%s' "$MAP" | j '.nodes[0].id')
NODE_LABEL=$(printf '%s' "$MAP" | j '.nodes[0].label')
SUMMARY_LEN=$(printf '%s' "$MAP" | j '.nodes[0].summary | length')
[ "${SUMMARY_LEN:-0}" -gt 20 ]; check "nodes carry plain-language summaries" $?
printf '%s' "$MAP" | j '.nodes[0].anchors | length' | grep -qv '^0$'; check "nodes are anchored to real code" $?
printf '%s' "$MAP" | j '[.nodes[].childCount] | max' | grep -qv '^0$'; check "map has depth (drill-down available)" $?

FULL=$(curl -s "$BASE/api/node/$NODE_ID")
[ "$(printf '%s' "$FULL" | j '.id')" = "$NODE_ID" ]; check "node detail ($NODE_LABEL)" $?

CTX=$(curl -s "$BASE/api/node/$NODE_ID/context")
CTX_ITEMS=$(printf '%s' "$CTX" | j '.items | length')
[ "${CTX_ITEMS:-0}" -gt 0 ]; check "scoped context ($CTX_ITEMS items, $(printf '%s' "$CTX" | j '.totalTokens') tokens)" $?
printf '%s' "$CTX" | j '.items[].tokens' | grep -qv '^$'; check "context items are token-counted" $?

CODE=$(curl -s "$BASE/api/node/$NODE_ID/code?anchor=0")
[ -n "$(printf '%s' "$CODE" | j '.text')" ]; check "code peek" $?

DESC=$(curl -s "$BASE/api/node/$NODE_ID/descendants")
[ -n "$(printf '%s' "$DESC" | j '.nodes')" ]; check "descendants" $?

# ---------------------------------------------------------------- agent
CHAT=$(curl -s -N -X POST "$BASE/api/chat" -H 'content-type: application/json' \
  -d "{\"message\":\"what does this do?\",\"nodeId\":\"$NODE_ID\"}")
printf '%s' "$CHAT" | grep -q '"type":"context"'; check "chat streams its context first (transparency)" $?
printf '%s' "$CHAT" | grep -q '"type":"token"'; check "chat streams tokens" $?
printf '%s' "$CHAT" | grep -q '"type":"done"'; check "chat finishes cleanly" $?

CHAT2=$(curl -s -N -X POST "$BASE/api/chat" -H 'content-type: application/json' \
  -d '{"message":"add a node for exporting orders to CSV"}')
PROPOSAL_ID=$(printf '%s' "$CHAT2" | grep '"type":"proposal"' | head -1 | sed 's/^data: //' | j '.proposal.id')
[ -n "${PROPOSAL_ID:-}" ]; check "agent proposes a change instead of applying it" $?

# ---------------------------------------------------------------- write side
NEW=$(curl -s -X POST "$BASE/api/node" -H 'content-type: application/json' \
  -d '{"label":"Smoke test node","summary":"Created by the smoke test.","kind":"planned"}')
NEW_ID=$(printf '%s' "$NEW" | j '.id')
[ "$(printf '%s' "$NEW" | j '.origin')" = "user" ]; check "create node (user-authored)" $?

printf '%s' "$(curl -s -X POST "$BASE/api/node/$NEW_ID/note" -H 'content-type: application/json' \
  -d '{"body":"must stay under 100ms","kind":"constraint"}')" | grep -q constraint; check "pin a constraint" $?

EDGE=$(curl -s -X POST "$BASE/api/edge" -H 'content-type: application/json' \
  -d "{\"source\":\"$NEW_ID\",\"target\":\"$NODE_ID\",\"label\":\"relates to\"}")
[ "$(printf '%s' "$EDGE" | j '.origin')" = "user" ]; check "create edge" $?

PATCH=$(curl -s -X PATCH "$BASE/api/node/$NEW_ID" -H 'content-type: application/json' \
  -d '{"label":"Smoke test node (renamed)","position":{"x":120,"y":-40},"positionLocked":true}')
[ "$(printf '%s' "$PATCH" | j '.positionLocked')" = "true" ]; check "rename + pin position" $?

# ---------------------------------------------------------------- stability
curl -s -X POST "$BASE/api/refresh" > /tmp/syscode-refresh.json
AFTER=$(curl -s "$BASE/api/node/$NEW_ID")
[ "$(printf '%s' "$AFTER" | j '.label')" = "Smoke test node (renamed)" ]; check "user node survives a refresh" $?
[ "$(printf '%s' "$AFTER" | j '.positionLocked')" = "true" ]; check "user lock survives a refresh" $?
[ "$(printf '%s' "$AFTER" | j '.notes | length')" = "1" ]; check "pinned constraint survives a refresh" $?
[ "$(printf '%s' "$AFTER" | j '.position.x')" = "120" ]; check "user position survives a refresh" $?

# proposals queue exists and is honest about status
PROPS=$(curl -s "$BASE/api/proposals")
[ -n "$(printf '%s' "$PROPS" | j 'length')" ]; check "proposal queue readable ($(printf '%s' "$PROPS" | j '[.[] | select(.status=="pending")] | length') pending)" $?

if [ -n "${PROPOSAL_ID:-}" ]; then
  curl -s -X POST "$BASE/api/proposals/$PROPOSAL_ID/approve" > /tmp/syscode-approve.json
  [ "$(jq -r '.proposal.status' /tmp/syscode-approve.json 2>/dev/null)" = "approved" ]; check "approve applies a proposal" $?
  printf '%s' "$(curl -s "$BASE/api/map")" | grep -q 'Exporting orders to CSV'; check "approved node is on the map" $?
fi

curl -s -X DELETE "$BASE/api/node/$NEW_ID" > /dev/null
[ "$(curl -s "$BASE/api/node/$NEW_ID" | j '.error')" != "null" ]; check "delete node" $?

# journal records what happened
[ -n "$(curl -s "$BASE/api/journal" | j '.[0].action')" ]; check "journal records the session" $?

echo
echo "  $pass passed, $fail failed   (project: $NAME)"
[ "$fail" -eq 0 ]
