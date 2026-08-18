#!/usr/bin/env bash
# Rotate the LAN-pilot Tajriba operator identity without printing credentials.
# A new username is used because Tajriba does not update an already-created
# User when only the mounted config password changes.

set -euo pipefail
umask 077

CONTAINER="delibra-empirica"
BASE_DIR="/mnt/dm-0/delibra"
NAS_BIND_IP="192.168.0.109"
CONFIG_FILE="$BASE_DIR/secrets/empirica.toml"
DATA_FILE="$BASE_DIR/data/tajriba.json"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
CONFIG_BACKUP="$BASE_DIR/backups/empirica-pre-admin-rotation-${STAMP}.toml"
DATA_BACKUP="$BASE_DIR/backups/tajriba-pre-admin-rotation-${STAMP}.json"
CONFIG_TMP="$(mktemp "$BASE_DIR/secrets/empirica.toml.XXXXXX")"

cleanup() {
  rm -f "$CONFIG_TMP"
}
trap cleanup EXIT

[[ "$(id -u)" == "0" ]] || { echo "FATAL: run as root" >&2; exit 2; }
[[ -s "$CONFIG_FILE" && -s "$DATA_FILE" ]] || {
  echo "FATAL: configuration or Tajriba store is missing" >&2
  exit 3
}

NEW_USERNAME="delibra-admin-${STAMP}-$(openssl rand -hex 4)"
NEW_PASSWORD="$(openssl rand -hex 32)"
NEW_SRTOKEN="$(openssl rand -hex 32)"

docker stop "$CONTAINER" >/dev/null
cp -a "$CONFIG_FILE" "$CONFIG_BACKUP"
cp -a "$DATA_FILE" "$DATA_BACKUP"
chmod 600 "$CONFIG_BACKUP" "$DATA_BACKUP"
sha256sum "$CONFIG_BACKUP" > "$CONFIG_BACKUP.sha256"
sha256sum "$DATA_BACKUP" > "$DATA_BACKUP.sha256"
sha256sum -c "$CONFIG_BACKUP.sha256" "$DATA_BACKUP.sha256" >/dev/null
echo "Configuration and Tajriba backups verified before credential rotation."

DELIBRA_NEW_USERNAME="$NEW_USERNAME" \
DELIBRA_NEW_PASSWORD="$NEW_PASSWORD" \
DELIBRA_NEW_SRTOKEN="$NEW_SRTOKEN" \
python3 - "$CONFIG_FILE" "$CONFIG_TMP" <<'PY'
import os
import re
import sys

source, destination = sys.argv[1:]
text = open(source, encoding="utf-8").read()
replacements = {
    r'(?m)^srtoken\s*=\s*"[^"]*"$': f'srtoken = "{os.environ["DELIBRA_NEW_SRTOKEN"]}"',
    r'(?m)^username\s*=\s*"[^"]*"$': f'username = "{os.environ["DELIBRA_NEW_USERNAME"]}"',
    r'(?m)^password\s*=\s*"[^"]*"$': f'password = "{os.environ["DELIBRA_NEW_PASSWORD"]}"',
}
for pattern, replacement in replacements.items():
    text, count = re.subn(pattern, replacement, text, count=1)
    if count != 1:
        raise SystemExit("configuration shape did not match the expected Tajriba auth fields")
with open(destination, "w", encoding="utf-8") as handle:
    handle.write(text)
PY

chown 10001:10001 "$CONFIG_TMP"
chmod 400 "$CONFIG_TMP"
mv "$CONFIG_TMP" "$CONFIG_FILE"

docker start "$CONTAINER" >/dev/null
for _ in $(seq 1 36); do
  STATE="$(docker inspect --format '{{.State.Status}}' "$CONTAINER")"
  HEALTH="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER")"
  HTTP_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 1 --max-time 2 "http://$NAS_BIND_IP:3000/" || true)"
  if [[ "$STATE" == "running" && "$HEALTH" == "healthy" && "$HTTP_STATUS" == "200" ]]; then
    break
  fi
  if [[ "$STATE" == "exited" || "$STATE" == "dead" ]]; then
    echo "FATAL: container failed after credential rotation" >&2
    exit 4
  fi
  sleep 5
done

PAYLOAD="$({
  DELIBRA_NEW_USERNAME="$NEW_USERNAME" DELIBRA_NEW_PASSWORD="$NEW_PASSWORD" python3 - <<'PY'
import json
import os
print(json.dumps({
    "query": "mutation Login($input: LoginInput!) { login(input: $input) { sessionToken user { username } } }",
    "variables": {"input": {
        "username": os.environ["DELIBRA_NEW_USERNAME"],
        "password": os.environ["DELIBRA_NEW_PASSWORD"],
    }},
}))
PY
})"
RESPONSE="$(curl -fsS -H 'content-type: application/json' --data-binary "$PAYLOAD" "http://$NAS_BIND_IP:3000/query")"

DELIBRA_NEW_USERNAME="$NEW_USERNAME" DELIBRA_LOGIN_RESPONSE="$RESPONSE" python3 - <<'PY'
import json
import os
response = json.loads(os.environ["DELIBRA_LOGIN_RESPONSE"])
login = response.get("data", {}).get("login") or {}
token = login.get("sessionToken") or ""
username = (login.get("user") or {}).get("username")
if len(token) < 20 or username != os.environ["DELIBRA_NEW_USERNAME"]:
    raise SystemExit("admin login validation failed")
print("New operator login validated without exposing credentials or session token.")
PY

docker exec "$CONTAINER" \
  node /opt/delibra/verify-tajriba-integrity.mjs /data/tajriba.json
echo "Credential rotation complete; the active credential remains only in the mounted mode-400 config."
