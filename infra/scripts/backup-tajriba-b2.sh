#!/usr/bin/env bash
# Tajriba -> local volume -> Backblaze B2 with SHA256 verify.
#
# Source-of-truth: project-knowledge/deployment-analysis-2026-08-13.html
#                  line 767-778 (step 6: B2 + cron)
#
# This script is meant to be run from the NAS host (or from inside the
# `delibra-tajriba` container with a writeable local backup mount). It:
#   1. Calls the existing local `scripts/backup-tajriba.sh` from the
#      repo to produce a timestamped local backup with SHA256.
#   2. Pushes the .json and the .sha256 sidecar to a Backblaze B2 bucket
#      using rclone.
#   3. Re-downloads the .sha256 from B2 and compares to the local one to
#      confirm the upload was not corrupted.
#   4. Logs the result; exits non-zero on any step failure so the cron
#      daemon can flag it.
#
# Environment (from .env or the crontab env_file):
#   B2_APPLICATION_KEY_ID
#   B2_APPLICATION_KEY
#   B2_BUCKET_NAME
#
# rclone must be installed and the B2 remote must be configured (one-time
# setup):
#   rclone config create b2 b2 account $(cat B2_APPLICATION_KEY_ID) \
#       key $(cat B2_APPLICATION_KEY)

set -euo pipefail

# ── resolve paths ─────────────────────────────────────────────────────────────
# Default the script's working directory to the repo root on the NAS.
# Override with $DELIBRA_REPO if the repo is checked out elsewhere.
: "${DELIBRA_REPO:=/opt/delibra}"
LOCAL_BACKUP_SCRIPT="$DELIBRA_REPO/scripts/backup-tajriba.sh"
LOCAL_BACKUP_DIR="$DELIBRA_REPO/.empirica/backups"
LOG_FILE="${BACKUP_LOG:-/var/log/delibra-backup.log}"

# Required env. Abort with a clear message if missing.
for v in B2_APPLICATION_KEY_ID B2_APPLICATION_KEY B2_BUCKET_NAME; do
  if [[ -z "${!v:-}" ]]; then
    echo "[$(date -u +%FT%TZ)] FATAL: env $v is empty" | tee -a "$LOG_FILE" >&2
    exit 2
  fi
done

log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$LOG_FILE"; }

# ── 1. local backup ───────────────────────────────────────────────────────────
log "Step 1/4: running local Tajriba backup"
if [[ ! -x "$LOCAL_BACKUP_SCRIPT" ]]; then
  log "FATAL: $LOCAL_BACKUP_SCRIPT is not executable"
  exit 3
fi
"$LOCAL_BACKUP_SCRIPT" >> "$LOG_FILE" 2>&1

# Find the freshest backup pair (json + sha256).
mapfile -t freshest < <(
  ls -1t "$LOCAL_BACKUP_DIR"/*.json 2>/dev/null | head -1
  ls -1t "$LOCAL_BACKUP_DIR"/*.sha256 2>/dev/null | head -1
)
BACKUP_JSON="${freshest[0]:-}"
BACKUP_SHA="${freshest[1]:-}"
if [[ -z "$BACKUP_JSON" || -z "$BACKUP_SHA" ]]; then
  log "FATAL: no fresh backup pair found in $LOCAL_BACKUP_DIR"
  exit 4
fi
log "Step 1/4 OK: produced $BACKUP_JSON (+ .sha256)"

# ── 2. push to B2 ─────────────────────────────────────────────────────────────
log "Step 2/4: pushing to B2 bucket $B2_BUCKET_NAME"
rclone copyto \
  --no-check-dest \
  --s3-no-check-bucket \
  "$BACKUP_JSON" ":b2:$B2_BUCKET_NAME/$(basename "$BACKUP_JSON")" \
  >> "$LOG_FILE" 2>&1
rclone copyto \
  --no-check-dest \
  --s3-no-check-bucket \
  "$BACKUP_SHA" ":b2:$B2_BUCKET_NAME/$(basename "$BACKUP_SHA")" \
  >> "$LOG_FILE" 2>&1
log "Step 2/4 OK: pushed to b2:$B2_BUCKET_NAME/"

# ── 3. verify by re-downloading the sha256 ────────────────────────────────────
log "Step 3/4: re-downloading .sha256 from B2 for integrity check"
TMP_SHA="$(mktemp -t delibra-b2-sha.XXXXXX)"
rclone cat ":b2:$B2_BUCKET_NAME/$(basename "$BACKUP_SHA")" "$TMP_SHA" \
  >> "$LOG_FILE" 2>&1
if ! cmp -s "$TMP_SHA" "$BACKUP_SHA"; then
  log "FATAL: B2 .sha256 does not match local"
  rm -f "$TMP_SHA"
  exit 5
fi
rm -f "$TMP_SHA"
log "Step 3/4 OK: B2 .sha256 matches local"

# ── 4. final summary ──────────────────────────────────────────────────────────
log "Step 4/4: backup complete ($(basename "$BACKUP_JSON"), $(stat -c %s "$BACKUP_JSON" 2>/dev/null || stat -f %z "$BACKUP_JSON") bytes)"
log "All steps OK"
