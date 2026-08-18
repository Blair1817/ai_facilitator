#!/usr/bin/env bash
# Start Delibra with the Docker CLI on old UGOS releases without Compose.
# Default mode is fail-closed for formal use. --lan-staging permits UI/health
# validation while keeping the pending external-backup mount read-only.

set -euo pipefail
umask 077

MODE="${1:-formal}"
if [[ "$MODE" != "formal" && "$MODE" != "--lan-staging" ]]; then
  echo "Usage: $0 [--lan-staging]" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$INFRA_DIR"

scripts/preflight-nas.sh "$MODE"
# shellcheck disable=SC1091
source .env

IMAGE="delibra-nas:$DELIBRA_IMAGE_TAG"
docker image inspect "$IMAGE" >/dev/null 2>&1 || {
  echo "FATAL: image not found; run scripts/build-image-legacy-ugos.sh" >&2
  exit 3
}
if docker container inspect delibra-empirica >/dev/null 2>&1; then
  echo "FATAL: delibra-empirica already exists; refusing to replace it" >&2
  exit 4
fi

external_mount_suffix=""
if [[ "$MODE" == "--lan-staging" ]]; then
  external_mount_suffix=",readonly"
  echo "WARNING: LAN staging only; backups and formal recruitment remain blocked"
fi

docker run --detach \
  --name delibra-empirica \
  --restart unless-stopped \
  --init \
  --stop-signal SIGINT \
  --stop-timeout 45 \
  --env-file "$INFRA_DIR/.env" \
  --env NODE_ENV=production \
  --publish "$NAS_BIND_IP:3000:3000" \
  --mount "type=bind,src=$DELIBRA_DATA_DIR,dst=/data" \
  --mount "type=bind,src=$DELIBRA_INTERNAL_BACKUP_DIR,dst=/backups/internal" \
  --mount "type=bind,src=$DELIBRA_EXTERNAL_BACKUP_DIR,dst=/backups/external$external_mount_suffix" \
  --mount "type=bind,src=$DELIBRA_CONFIG_FILE,dst=/run/secrets/empirica.toml,readonly" \
  --mount "type=bind,src=$DELIBRA_BACKUP_KEY_FILE,dst=/run/secrets/backup_passphrase,readonly" \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --pids-limit 512 \
  --memory 6g \
  --cpus 3.0 \
  --ulimit nofile=65536:65536 \
  --health-cmd 'curl -fsS http://127.0.0.1:3000/' \
  --health-interval 30s \
  --health-timeout 10s \
  --health-retries 5 \
  --health-start-period 90s \
  --log-driver json-file \
  --log-opt max-size=20m \
  --log-opt max-file=5 \
  "$IMAGE" \
  serve /opt/delibra/delibra.tar.zst \
  --config /run/secrets/empirica.toml \
  --addr :3000 \
  --tajriba.store.file /data/tajriba.json \
  --callbacks.sessionTokenPath /data/callBackSessionToken \
  --log.json \
  --log.level warn \
  --tajriba.log.level warn

echo "Delibra container created. Mode: $MODE"
