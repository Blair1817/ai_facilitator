#!/usr/bin/env bash
# Create matching encrypted, checksummed Tajriba snapshots on the NAS and an
# independently mounted disk. Run inside the delibra container.

set -euo pipefail
umask 077

DATA_FILE="${TAJRIBA_DATA_FILE:-/data/tajriba.json}"
INTERNAL_DIR="${INTERNAL_BACKUP_DIR:-/backups/internal}"
EXTERNAL_DIR="${EXTERNAL_BACKUP_DIR:-/backups/external}"
KEY_FILE="${BACKUP_KEY_FILE:-/run/secrets/backup_passphrase}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-90}"
DEPLOYMENT_MANIFEST="${DEPLOYMENT_MANIFEST:-/opt/delibra/manifest.txt}"
LOCK_DIR="$INTERNAL_DIR/.backup-lock"

log() {
  printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"
}

for required in openssl tar sha256sum node; do
  if ! command -v "$required" >/dev/null 2>&1; then
    log "FATAL: required command not found: $required" >&2
    exit 2
  fi
done

if [[ ! -s "$DATA_FILE" ]]; then
  log "FATAL: Tajriba data file is missing or empty: $DATA_FILE" >&2
  exit 3
fi
if [[ ! -s "$KEY_FILE" ]]; then
  log "FATAL: backup passphrase file is missing or empty" >&2
  exit 4
fi
if [[ ! "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || (( RETENTION_DAYS < 30 )); then
  log "FATAL: BACKUP_RETENTION_DAYS must be an integer of at least 30" >&2
  exit 5
fi

mkdir -p "$INTERNAL_DIR" "$EXTERNAL_DIR"
if [[ ! -w "$INTERNAL_DIR" || ! -w "$EXTERNAL_DIR" ]]; then
  log "FATAL: both backup destinations must be mounted and writable" >&2
  exit 6
fi

INTERNAL_DEVICE="$(df -P "$INTERNAL_DIR" | awk 'NR == 2 {print $1}')"
EXTERNAL_DEVICE="$(df -P "$EXTERNAL_DIR" | awk 'NR == 2 {print $1}')"
if [[ -z "$INTERNAL_DEVICE" || "$INTERNAL_DEVICE" == "$EXTERNAL_DEVICE" ]]; then
  log "FATAL: backup destinations are not on independent mounted devices" >&2
  exit 6
fi

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "FATAL: another backup is already running" >&2
  exit 7
fi

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE_NAME="delibra-tajriba-$TIMESTAMP"
STAGING_DIR="$(mktemp -d "$INTERNAL_DIR/.staging.XXXXXX")"
ARCHIVE_NAME="$BASE_NAME.tar.enc"
CHECKSUM_NAME="$ARCHIVE_NAME.sha256"

cleanup() {
  rm -rf "$STAGING_DIR"
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

cp "$DATA_FILE" "$STAGING_DIR/tajriba.json"

# Tajriba is an append-only JSON-lines file. Reject a snapshot containing a
# truncated or malformed record before it is encrypted and rotated.
node - "$STAGING_DIR/tajriba.json" <<'NODE'
const fs = require("fs");
const path = process.argv[2];
const lines = fs.readFileSync(path, "utf8").split("\n");
let records = 0;
for (let i = 0; i < lines.length; i += 1) {
  if (!lines[i].trim()) continue;
  try {
    JSON.parse(lines[i]);
    records += 1;
  } catch (error) {
    console.error(`Invalid Tajriba JSON record at line ${i + 1}: ${error.message}`);
    process.exit(1);
  }
}
if (records < 2) {
  console.error("Tajriba snapshot does not contain the expected header records");
  process.exit(1);
}
NODE

cat > "$STAGING_DIR/backup-metadata.txt" <<EOF
created_at_utc=$TIMESTAMP
source_file=$DATA_FILE
source_sha256=$(sha256sum "$STAGING_DIR/tajriba.json" | awk '{print $1}')
deployment_bundle_sha256=$(awk -F= '/^bundle_sha256=/ {print $2}' "$DEPLOYMENT_MANIFEST")
EOF

tar -C "$STAGING_DIR" -cf - tajriba.json backup-metadata.txt \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
      -pass "file:$KEY_FILE" -out "$INTERNAL_DIR/$ARCHIVE_NAME"

(
  cd "$INTERNAL_DIR"
  sha256sum "$ARCHIVE_NAME" > "$CHECKSUM_NAME"
  sha256sum -c "$CHECKSUM_NAME"
)

cp "$INTERNAL_DIR/$ARCHIVE_NAME" "$EXTERNAL_DIR/$ARCHIVE_NAME"
cp "$INTERNAL_DIR/$CHECKSUM_NAME" "$EXTERNAL_DIR/$CHECKSUM_NAME"
(
  cd "$EXTERNAL_DIR"
  sha256sum -c "$CHECKSUM_NAME"
)

# Rotation is deliberately constrained to this script's filename pattern and
# to the two explicitly mounted backup directories.
find "$INTERNAL_DIR" -maxdepth 1 -type f -name 'delibra-tajriba-*.tar.enc' -mtime "+$RETENTION_DAYS" -delete
find "$INTERNAL_DIR" -maxdepth 1 -type f -name 'delibra-tajriba-*.tar.enc.sha256' -mtime "+$RETENTION_DAYS" -delete
find "$EXTERNAL_DIR" -maxdepth 1 -type f -name 'delibra-tajriba-*.tar.enc' -mtime "+$RETENTION_DAYS" -delete
find "$EXTERNAL_DIR" -maxdepth 1 -type f -name 'delibra-tajriba-*.tar.enc.sha256' -mtime "+$RETENTION_DAYS" -delete

log "Backup OK: $ARCHIVE_NAME written and verified on both destinations"
