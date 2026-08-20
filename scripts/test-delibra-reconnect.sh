#!/usr/bin/env bash
# scripts/test-delibra-reconnect.sh
#
# End-to-end smoke test for the reconnection patches applied 2026-08-20.
# Designed to be run from the researcher's Mac AFTER
# `docker compose up -d --build` on the NAS has finished.
#
# Requirements on the Mac:
#   - ssh access to the NAS (alias `nas-ts`)
#   - the public hostname `delibraresearchteam.hengxpersonal.com`
#     is reachable
#
# This script is INTENTIONALLY chatty — every step prints what it is
# checking and what to look for. The researcher is expected to
# open Chrome DevTools on the participant page and watch the console.
#
# Exit codes:
#   0  - all checks passed
#   1  - one or more checks failed
#   2  - environment setup issue (cannot reach container / tunnel)

set -uo pipefail

PUBLIC_URL="${PUBLIC_URL:-https://delibraresearchteam.hengxpersonal.com}"
NAS_SSH="${NAS_SSH:-ssh nas-ts}"

# Tunable
PARTICIPANT_KEY="smoke_$(date +%s)"
OUT_DIR="${TMPDIR:-/tmp}/delibra-smoke-$(date +%H%M%S)"
mkdir -p "$OUT_DIR"

red()    { printf "\033[31m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
blue()   { printf "\033[34m%s\033[0m\n" "$*"; }
bold()   { printf "\033[1m%s\033[0m\n" "$*"; }

failed=0
trap 'echo; yellow "LOGS: $OUT_DIR"; exit 1' ERR

step() { echo; bold "===== $* ====="; }

step "0. Pre-flight"
"$NAS_SSH" 'docker ps --filter name=delibra-empirica --format "{{.Status}}"'
"$NAS_SSH" 'tail -c 500 /var/log/tajriba-watchdog.log; echo'
"$NAS_SSH" 'tail -c 500 /var/log/tajriba-reopen.log; echo'
blue "   (above should show Up ... (healthy), alive, got next / healthy, re-asserted)"

step "1. Public liveness: GET ${PUBLIC_URL}/"
STATUS=$(curl -sk -o "$OUT_DIR/index.html" -w '%{http_code}' "${PUBLIC_URL}/")
if [[ "$STATUS" != "200" ]]; then
  red "expected 200; got $STATUS"
  failed=1
else
  green "OK (200, $(wc -c <"$OUT_DIR/index.html") bytes)"
fi

step "2. Subscription liveness via WSS"
node --experimental-websocket - > "$OUT_DIR/sub.log" 2>&1 <<'NODE' || true
const WS_URL = process.env.PUBLIC_WS || "wss://delibraresearchteam.hengxpersonal.com/query";
const ws = new WebSocket(WS_URL, "graphql-transport-ws");
ws.addEventListener("open", () => ws.send(JSON.stringify({type: "connection_init"})));
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.type === "connection_ack") {
    ws.send(JSON.stringify({id: "q", type: "subscribe", payload: {
      query: "subscription S { scopedAttributes(input:[{kinds:[\"global\"]}]) { attribute{key val node{id ... on Scope{kind}}} done } }",
    }}));
  }
  if (m.type === "next") { console.log("next:", JSON.stringify(m.payload.data)); setTimeout(()=>process.exit(0), 500); }
});
setTimeout(() => { console.error("TIMEOUT after 8s"); process.exit(2); }, 8000);
NODE
if grep -q "next:" "$OUT_DIR/sub.log"; then
  green "OK — got next event:"
  cat "$OUT_DIR/sub.log"
else
  red "WSS subscription timed out (this is the very bug the patch fixes)"; cat "$OUT_DIR/sub.log"; failed=1
fi

step "3. Container-internal curl to /query (token-based)"
"$NAS_SSH" 'TOKEN=$(cat /data/callBackSessionToken 2>/dev/null | tr -d "\r\n"); echo "token=$TOKEN (first 16 chars)"; \
  curl -s -o /dev/null -w "code=%{http_code}\n" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"query\":\"{ __typename }\"}" http://127.0.0.1:3000/query' > "$OUT_DIR/inner_query.log" 2>&1 || true
cat "$OUT_DIR/inner_query.log"
if grep -q "code=200" "$OUT_DIR/inner_query.log"; then green "OK"; else red "in-container /query returned non-200"; failed=1; fi

step "4. Console-marker check on a participant browser"
blue "Manually open in Chrome: ${PUBLIC_URL}/?participantKey=${PARTICIPANT_KEY}"
blue "Open DevTools → Console, look for:"
blue "  [pilot] tajriba-noop-global-attrs PATCH INSTALLED"
blue "  [pilot] tajriba-reconnect-watchdog PATCH INSTALLED"
blue "If BOTH markers are present the patches loaded. (Press Enter to continue)"
read -r _ < /dev/tty || true

step "5. Forced partial-freeze (60 s Tajriba pause)"
blue "On the participant browser, watch the live 'Reconnecting for Ns…' counter."
blue "We will SIGSTOP the Tajriba process inside the container for 60 s. Expect:"
blue "  - within ~30 s the WS layer emits 'closed' (keepAlive ping expired)"
blue "  - within 25 s the auto-reload timer on ConnectionRecovery fires"
blue "  - after Tajriba resumes, page reloads and participant lands back in the game"
"$NAS_SSH" 'docker exec delibra-empirica sh -c "PID=$(pgrep -f tajriba | head -1); echo stopping pid=$PID; kill -STOP $PID; sleep 60; kill -CONT $PID; echo resumed"' > "$OUT_DIR/freeze.log" 2>&1 &
FREEZE_PID=$!
blue "  freeze started (pid=$FREEZE_PID) — open the page NOW to observe"
wait $FREEZE_PID || true
cat "$OUT_DIR/freeze.log"
green "  if you saw the participant auto-reload within 90 s the patches are working"

step "6. Result"
if (( failed == 0 )); then
  green "all automated checks passed"
  echo
  yellow "manual observation checklist:"
  echo "  [ ] participant page in step 5 reloaded within ~25 s after STOP"
  echo "  [ ] no 'sessionParticipant timed out' stacked in console"
  echo "  [ ] no '[delibra-watchdog] forcing stop()+connect()' on a healthy run"
  yellow "logs preserved at $OUT_DIR"
else
  red "one or more checks failed; see logs at $OUT_DIR"
fi
exit $failed
