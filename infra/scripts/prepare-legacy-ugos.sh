#!/usr/bin/env bash
# One-time, fail-closed preparation for the DXP4600 Pro legacy UGOS host.
# Run as the temporary root maintenance account after copying model.env and the
# deployment files. Existing runtime configuration is never overwritten.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE_DIR="${DELIBRA_BASE_DIR:-/mnt/dm-0/delibra}"
MODEL_ENV="$INFRA_DIR/model.env"
RUNTIME_ENV="$INFRA_DIR/.env"

[[ "$(id -u)" == "0" ]] || { echo "FATAL: run as the temporary root maintenance account" >&2; exit 2; }
[[ -s "$MODEL_ENV" ]] || { echo "FATAL: model.env was not transferred" >&2; exit 3; }
[[ ! -e "$RUNTIME_ENV" ]] || { echo "FATAL: refusing to overwrite existing infra/.env" >&2; exit 4; }

for key in OPENAI_API_KEY OPENAI_MODEL LLM_API_ENDPOINT LLM_MAX_OUTPUT_TOKENS; do
  line="$(grep -E "^${key}=" "$MODEL_ENV" | tail -n 1 || true)"
  [[ -n "$line" ]] || { echo "FATAL: $key is missing from model.env" >&2; exit 5; }
  if printf '%s' "$line" | grep -Eq 'your-key|__REGENERATE|placeholder'; then
    echo "FATAL: $key is still a placeholder" >&2
    exit 6
  fi
done

mkdir -p \
  "$BASE_DIR" \
  "$BASE_DIR/data" \
  "$BASE_DIR/backups" \
  "$BASE_DIR/external-backup-pending" \
  "$BASE_DIR/secrets"
chmod 700 \
  "$BASE_DIR" \
  "$BASE_DIR/data" \
  "$BASE_DIR/backups" \
  "$BASE_DIR/external-backup-pending" \
  "$BASE_DIR/secrets"
chown 10001:10001 \
  "$BASE_DIR/data" \
  "$BASE_DIR/backups" \
  "$BASE_DIR/external-backup-pending" \
  "$BASE_DIR/secrets"

CONFIG_FILE="$BASE_DIR/secrets/empirica.toml"
BACKUP_KEY_FILE="$BASE_DIR/secrets/backup-passphrase"
[[ ! -e "$CONFIG_FILE" && ! -e "$BACKUP_KEY_FILE" ]] || {
  echo "FATAL: refusing to overwrite existing runtime secrets" >&2
  exit 7
}

SRTOKEN="$(openssl rand -hex 32)"
ADMIN_PASSWORD="$(openssl rand -hex 32)"
BACKUP_PASSPHRASE="$(openssl rand -hex 32)"
sed \
  -e "s/__REGENERATE_TAJRIBA_SRTOKEN__/$SRTOKEN/" \
  -e "s/__REGENERATE_TAJRIBA_ADMIN_PASSWORD__/$ADMIN_PASSWORD/" \
  "$INFRA_DIR/empirica.toml.template" > "$CONFIG_FILE"
printf '%s\n' "$BACKUP_PASSPHRASE" > "$BACKUP_KEY_FILE"
chown 10001:10001 "$CONFIG_FILE" "$BACKUP_KEY_FILE"
chmod 400 "$CONFIG_FILE" "$BACKUP_KEY_FILE"

{
  grep -E '^(OPENAI_API_KEY|OPENAI_MODEL|LLM_API_ENDPOINT|LLM_MAX_OUTPUT_TOKENS)=' "$MODEL_ENV"
  cat <<EOF
DELIBRA_UID=10001
DELIBRA_GID=10001
NAS_BIND_IP=192.168.0.109
DELIBRA_IMAGE_TAG=9c6a777
DELIBRA_ENV_FILE=.env
DELIBRA_DATA_DIR=$BASE_DIR/data
DELIBRA_INTERNAL_BACKUP_DIR=$BASE_DIR/backups
DELIBRA_EXTERNAL_BACKUP_DIR=$BASE_DIR/external-backup-pending
DELIBRA_CONFIG_FILE=$CONFIG_FILE
DELIBRA_BACKUP_KEY_FILE=$BACKUP_KEY_FILE
BACKUP_RETENTION_DAYS=90
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
EOF
} > "$RUNTIME_ENV"
chmod 600 "$RUNTIME_ENV"
rm -f "$MODEL_ENV"

echo "Legacy UGOS staging directories and secrets prepared."
echo "Formal mode remains blocked until Supabase and an independent external disk are configured."
