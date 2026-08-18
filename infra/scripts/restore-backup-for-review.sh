#!/usr/bin/env bash
# Verify and decrypt a backup into a new review directory. This script never
# overwrites the active Tajriba database.

set -euo pipefail
umask 077

ARCHIVE_PATH="${1:-}"
KEY_FILE="${BACKUP_KEY_FILE:-/run/secrets/backup_passphrase}"
RESTORE_ROOT="${RESTORE_REVIEW_DIR:-/data/restore-review}"

if [[ -z "$ARCHIVE_PATH" ]]; then
  echo "Usage: restore-backup-for-review.sh /backups/internal/delibra-tajriba-<timestamp>.tar.enc" >&2
  exit 2
fi
if [[ ! -f "$ARCHIVE_PATH" || ! -f "$ARCHIVE_PATH.sha256" ]]; then
  echo "FATAL: archive or checksum sidecar not found" >&2
  exit 3
fi
if [[ ! -s "$KEY_FILE" ]]; then
  echo "FATAL: backup passphrase file is missing or empty" >&2
  exit 4
fi

ARCHIVE_DIR="$(cd "$(dirname "$ARCHIVE_PATH")" && pwd)"
ARCHIVE_NAME="$(basename "$ARCHIVE_PATH")"
(
  cd "$ARCHIVE_DIR"
  sha256sum -c "$ARCHIVE_NAME.sha256"
)

RESTORE_DIR="$RESTORE_ROOT/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$RESTORE_DIR"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -pass "file:$KEY_FILE" -in "$ARCHIVE_PATH" \
  | tar -C "$RESTORE_DIR" -xf -

node - "$RESTORE_DIR/tajriba.json" <<'NODE'
const fs = require("fs");
const path = process.argv[2];
const lines = fs.readFileSync(path, "utf8").split("\n");
let records = 0;
for (let i = 0; i < lines.length; i += 1) {
  if (!lines[i].trim()) continue;
  JSON.parse(lines[i]);
  records += 1;
}
if (records < 2) process.exit(1);
NODE

EXPECTED_SHA="$(awk -F= '/^source_sha256=/ {print $2}' "$RESTORE_DIR/backup-metadata.txt")"
ACTUAL_SHA="$(sha256sum "$RESTORE_DIR/tajriba.json" | awk '{print $1}')"
if [[ -z "$EXPECTED_SHA" || "$EXPECTED_SHA" != "$ACTUAL_SHA" ]]; then
  echo "FATAL: restored data hash does not match backup metadata" >&2
  exit 5
fi

echo "Restore drill OK: $RESTORE_DIR"
echo "The active database was not modified."
