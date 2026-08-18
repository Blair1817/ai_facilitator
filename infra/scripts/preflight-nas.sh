#!/usr/bin/env bash
# Fail closed before the first NAS image build or service start.

set -euo pipefail
umask 077

MODE="${1:-formal}"
if [[ "$MODE" != "formal" && "$MODE" != "--lan-staging" ]]; then
  echo "Usage: $0 [--lan-staging]" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "FATAL: this pinned Empirica image requires a Linux x86_64 NAS" >&2
  exit 2
fi
for required in docker openssl awk grep; do
  command -v "$required" >/dev/null 2>&1 || {
    echo "FATAL: required command not found: $required" >&2
    exit 3
  }
done

cd "$INFRA_DIR"
if [[ ! -f .env ]]; then
  echo "FATAL: create infra/.env from .env.example" >&2
  exit 4
fi
set -a
# shellcheck disable=SC1091
source .env
set +a

for variable in \
  DELIBRA_UID DELIBRA_GID NAS_BIND_IP DELIBRA_IMAGE_TAG DELIBRA_DATA_DIR \
  DELIBRA_INTERNAL_BACKUP_DIR DELIBRA_EXTERNAL_BACKUP_DIR \
  DELIBRA_CONFIG_FILE DELIBRA_BACKUP_KEY_FILE OPENAI_API_KEY OPENAI_MODEL \
  LLM_API_ENDPOINT LLM_MAX_OUTPUT_TOKENS; do
  if [[ -z "${!variable:-}" || "${!variable}" == __REGENERATE* ]]; then
    echo "FATAL: $variable is missing or still a placeholder" >&2
    exit 5
  fi
done

if [[ "$MODE" == "formal" ]]; then
  for variable in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY; do
    if [[ -z "${!variable:-}" || "${!variable}" == __REGENERATE* ]]; then
      echo "FATAL: $variable is required for formal assignment persistence" >&2
      exit 5
    fi
  done
fi

if [[ "$DELIBRA_INTERNAL_BACKUP_DIR" == "$DELIBRA_EXTERNAL_BACKUP_DIR" ]]; then
  echo "FATAL: internal and external backup paths must differ" >&2
  exit 6
fi
if [[ ! -s "$DELIBRA_CONFIG_FILE" || ! -s "$DELIBRA_BACKUP_KEY_FILE" ]]; then
  echo "FATAL: runtime config or backup passphrase file is missing/empty" >&2
  exit 7
fi
if grep -v '^[[:space:]]*#' "$DELIBRA_CONFIG_FILE" \
  | grep -q '__REGENERATE\|local-test-token\|localtest'; then
  echo "FATAL: Empirica config contains a placeholder or development credential" >&2
  exit 8
fi

for directory in "$DELIBRA_DATA_DIR" "$DELIBRA_INTERNAL_BACKUP_DIR" "$DELIBRA_EXTERNAL_BACKUP_DIR"; do
  if [[ ! -d "$directory" || ! -w "$directory" ]]; then
    echo "FATAL: required directory is not writable: $directory" >&2
    exit 9
  fi
done


internal_device="$(df -P "$DELIBRA_INTERNAL_BACKUP_DIR" | awk 'NR == 2 {print $1}')"
external_device="$(df -P "$DELIBRA_EXTERNAL_BACKUP_DIR" | awk 'NR == 2 {print $1}')"
if [[ "$MODE" == "formal" && ( -z "$internal_device" || "$internal_device" == "$external_device" ) ]]; then
  echo "FATAL: formal backups require an independently mounted external device" >&2
  exit 9
fi

if [[ ! -s bundle/delibra.tar.zst || ! -s bundle/manifest.txt ]]; then
  echo "FATAL: run infra/scripts/build-nas-bundle.sh before NAS preflight" >&2
  exit 10
fi

if docker compose version >/dev/null 2>&1; then
  docker compose --env-file .env config --quiet
  echo "NAS preflight OK for Docker Compose (no service was started)"
elif [[ -x scripts/run-legacy-ugos.sh ]]; then
  echo "NAS preflight OK for legacy Docker CLI (no service was started)"
else
  echo "FATAL: Docker Compose is unavailable and the legacy UGOS runner is missing" >&2
  exit 11
fi
