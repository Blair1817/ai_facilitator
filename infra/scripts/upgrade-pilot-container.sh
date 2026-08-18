#!/usr/bin/env bash
# Controlled LAN-pilot container upgrade with a consistent data backup and an
# automatic rollback. The previous container is retained under a timestamped
# name; this script never deletes runtime data or the rollback container.

set -euo pipefail
umask 077

NEW_IMAGE="${1:-}"
ACTIVE_CONTAINER="delibra-empirica"
BASE_DIR="/mnt/dm-0/delibra"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ROLLBACK_CONTAINER="${ACTIVE_CONTAINER}-rollback-${STAMP}"
FAILED_CONTAINER="${ACTIVE_CONTAINER}-failed-${STAMP}"
DATA_FILE="$BASE_DIR/data/tajriba.json"
BACKUP_FILE="$BASE_DIR/backups/tajriba-pre-upgrade-${STAMP}.json"
DELIBRA_RUNTIME_ENV_TMP="$(mktemp /tmp/delibra-container-env.XXXXXX)"

cleanup() {
  rm -f "$DELIBRA_RUNTIME_ENV_TMP"
}
trap cleanup EXIT

[[ "$(id -u)" == "0" ]] || { echo "FATAL: run as root" >&2; exit 2; }
[[ -n "$NEW_IMAGE" ]] || { echo "Usage: $0 <new-image-tag>" >&2; exit 2; }
docker image inspect "$NEW_IMAGE" >/dev/null 2>&1 || {
  echo "FATAL: image not found: $NEW_IMAGE" >&2
  exit 3
}
docker container inspect "$ACTIVE_CONTAINER" >/dev/null 2>&1 || {
  echo "FATAL: active container not found: $ACTIVE_CONTAINER" >&2
  exit 4
}
[[ -s "$DATA_FILE" ]] || { echo "FATAL: Tajriba store missing or empty" >&2; exit 5; }

CURRENT_HEALTH="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$ACTIVE_CONTAINER")"
[[ "$CURRENT_HEALTH" == "healthy" ]] || {
  echo "FATAL: refusing upgrade because current container is not healthy ($CURRENT_HEALTH)" >&2
  exit 6
}

# Preserve the exact runtime environment without printing it. The temporary
# file is mode 600 and is removed by the EXIT trap.
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
  "$ACTIVE_CONTAINER" > "$DELIBRA_RUNTIME_ENV_TMP"
chmod 600 "$DELIBRA_RUNTIME_ENV_TMP"

echo "Stopping the active container for a consistent Tajriba snapshot..."
docker stop "$ACTIVE_CONTAINER" >/dev/null

cp -a "$DATA_FILE" "$BACKUP_FILE"
chmod 600 "$BACKUP_FILE"
sha256sum "$BACKUP_FILE" > "$BACKUP_FILE.sha256"
sha256sum -c "$BACKUP_FILE.sha256" >/dev/null
echo "Backup verified: $BACKUP_FILE"

docker rename "$ACTIVE_CONTAINER" "$ROLLBACK_CONTAINER"

rollback() {
  echo "Upgrade failed; restoring the previous container..." >&2
  if docker container inspect "$ACTIVE_CONTAINER" >/dev/null 2>&1; then
    docker stop "$ACTIVE_CONTAINER" >/dev/null 2>&1 || true
    docker rename "$ACTIVE_CONTAINER" "$FAILED_CONTAINER"
  fi
  docker rename "$ROLLBACK_CONTAINER" "$ACTIVE_CONTAINER"
  docker start "$ACTIVE_CONTAINER" >/dev/null
  echo "Rollback container restored: $ACTIVE_CONTAINER" >&2
}

set +e
docker run --detach \
  --name "$ACTIVE_CONTAINER" \
  --restart unless-stopped \
  --init \
  --stop-signal SIGINT \
  --stop-timeout 45 \
  --env-file "$DELIBRA_RUNTIME_ENV_TMP" \
  --publish 192.168.0.109:3000:3000 \
  --mount type=bind,src="$BASE_DIR/data",dst=/data \
  --mount type=bind,src="$BASE_DIR/backups",dst=/backups/internal \
  --mount type=bind,src="$BASE_DIR/external-backup-pending",dst=/backups/external,readonly \
  --mount type=bind,src="$BASE_DIR/secrets/empirica.toml",dst=/run/secrets/empirica.toml,readonly \
  --mount type=bind,src="$BASE_DIR/secrets/backup-passphrase",dst=/run/secrets/backup_passphrase,readonly \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 512 \
  --memory 6g \
  --cpus 3.0 \
  --ulimit nofile=65536:65536 \
  --health-cmd 'curl -fsS http://127.0.0.1:3000/' \
  --health-interval 10s \
  --health-timeout 10s \
  --health-retries 8 \
  --health-start-period 90s \
  --log-driver json-file \
  --log-opt max-size=20m \
  --log-opt max-file=5 \
  "$NEW_IMAGE" \
  serve /opt/delibra/delibra.tar.zst \
  --config /run/secrets/empirica.toml \
  --addr :3000 \
  --tajriba.store.file /data/tajriba.json \
  --callbacks.sessionTokenPath /data/callBackSessionToken \
  --log.json \
  --log.level warn \
  --tajriba.log.level warn >/dev/null
RUN_STATUS=$?
set -e

if [[ "$RUN_STATUS" -ne 0 ]]; then
  rollback
  exit 7
fi

for _ in $(seq 1 36); do
  STATE="$(docker inspect --format '{{.State.Status}}' "$ACTIVE_CONTAINER")"
  HEALTH="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$ACTIVE_CONTAINER")"
  if [[ "$STATE" == "running" && "$HEALTH" == "healthy" ]]; then
    docker exec "$ACTIVE_CONTAINER" \
      node /opt/delibra/verify-tajriba-integrity.mjs /data/tajriba.json
    echo "Upgrade healthy. Rollback container retained as: $ROLLBACK_CONTAINER"
    exit 0
  fi
  if [[ "$STATE" == "exited" || "$STATE" == "dead" ]]; then
    break
  fi
  sleep 5
done

docker logs --tail 120 "$ACTIVE_CONTAINER" 2>&1 \
  | grep -E 'tajriba-integrity|FATAL|fatal|panic|server: started|Startup self-check' \
  | tail -80 || true
rollback
exit 8
