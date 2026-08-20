#!/bin/sh
# host-watchdog.sh — Tajriba v1.12 freeze watchdog (2026-08-20 revision)
#
# Runs from the NAS host crontab (*/1). Three improvements over the
# 2026-08-19 version:
#
# 1. SIGQUIT goroutine capture. When the freeze is detected, we send
#    SIGQUIT to the empirica Go process (PID 1) BEFORE restarting. The Go
#    runtime prints a complete dump of every goroutine's stack to stderr
#    (= docker logs), which is the evidence needed to identify the actual
#    upstream bug (subscription dispatcher / lobby timer goroutine block).
#    Dumps are persisted to /var/log/tajriba-freeze-dumps/.
# 2. Uptime guard. If the container started less than MIN_UPTIME_S ago we
#    do NOT kill/restart it — this prevents a restart loop while the
#    server is still booting (health-start-period).
# 3. SIGQUIT itself restarts the container: the process exits non-zero and
#    the `unless-stopped` restart policy brings it back. No docker
#    restart needed; we only verify recovery afterwards.
#
# Liveness check = real subscription probe (tajriba-watchdog.js, 8s).

LOG=/var/log/tajriba-watchdog.log
DUMPS=/var/log/tajriba-freeze-dumps
MIN_UPTIME_S=180
CONTAINER=delibra-empirica

mkdir -p "$DUMPS"
echo "--- $(date -u +%FT%TZ) ---" >> "$LOG"

# Liveness probe (node 20 needs --experimental-websocket).
if docker exec "$CONTAINER" node --experimental-websocket /opt/delibra/bin/tajriba-watchdog.js >> "$LOG" 2>&1; then
  exit 0
fi

# Frozen (or starting). Check uptime before acting.
STARTED_AT=$(docker inspect --format '{{.State.StartedAt}}' "$CONTAINER" 2>/dev/null)
START_EPOCH=$(date -d "$STARTED_AT" +%s 2>/dev/null || echo 0)
NOW_EPOCH=$(date +%s)
AGE=$((NOW_EPOCH - START_EPOCH))

if [ "$AGE" -lt "$MIN_UPTIME_S" ]; then
  echo "  probe failed but container is only ${AGE}s old (< ${MIN_UPTIME_S}s); assuming still booting, no action" >> "$LOG"
  exit 0
fi

echo "  FROZEN (uptime ${AGE}s); capturing goroutine dump via SIGQUIT" >> "$LOG"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

# SIGQUIT -> Go runtime dumps all goroutine stacks to stderr, then exits.
# The container's `unless-stopped` restart policy restarts it.
docker exec "$CONTAINER" sh -c 'kill -QUIT 1' >> "$LOG" 2>&1 || true

# Give the runtime a moment to print the dump and exit.
sleep 8

# Persist the dump (docker logs survive, but copy for safety + retention).
docker logs --tail 5000 "$CONTAINER" > "$DUMPS/goroutines-${STAMP}.log" 2>&1 || true
echo "  dump saved: $DUMPS/goroutines-${STAMP}.log ($(wc -c < "$DUMPS/goroutines-${STAMP}.log" 2>/dev/null) bytes)" >> "$LOG"

# Make sure the container is coming back (restart policy should do it).
sleep 15
if ! docker ps --filter "name=${CONTAINER}" --filter "status=running" -q | grep -q .; then
  echo "  container not running after SIGQUIT; docker start" >> "$LOG"
  docker start "$CONTAINER" >> "$LOG" 2>&1 || true
fi

# Verify recovery (startup takes ~30-60s with the prewarm bake).
sleep 60
if docker exec "$CONTAINER" node --experimental-websocket /opt/delibra/bin/tajriba-watchdog.js >> "$LOG" 2>&1; then
  echo "  RECOVERED after SIGQUIT restart" >> "$LOG"
else
  echo "  STILL UNHEALTHY after restart; manual investigation needed (see $DUMPS/goroutines-${STAMP}.log)" >> "$LOG"
fi
