#!/usr/bin/env bash
# Build the Delibra image for Azure deployment and (optionally) push
# it to Azure Container Registry. The image is identical to the NAS
# one — only the destination registry differs.
#
# Usage:
#   1. cp infra/.env.azure.example infra/.env
#   2. edit infra/.env to set ACR_LOGIN_SERVER and DELIBRA_IMAGE_TAG
#   3. (one-time, on first build) infra/scripts/capture-prewarm-from-running.sh
#   4. infra/scripts/build-for-azure.sh
#
# What this script does:
#   - Validates prewarm/ is populated (the COPY in the Dockerfile will
#     fail if it isn't; see capture-prewarm-from-running.sh).
#   - Regenerates infra/bundle/delibra.tar.zst via build-nas-bundle.sh.
#   - Runs `docker build --pull` with a tag derived from git SHA + date
#     (overridable via DELIBRA_IMAGE_TAG in .env).
#   - Optionally `docker push` to ACR.
#
# Push is gated behind --push. Without --push, the script stops after
# the local build so you can inspect `docker images` and `docker run`
# the new image before pushing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$INFRA_DIR/.." && pwd)"

for required in docker git empirica; do
  if ! command -v "$required" >/dev/null 2>&1; then
    echo "FATAL: required command not found: $required" >&2
    exit 2
  fi
done

# Load .env if present.
if [[ -f "$INFRA_DIR/.env" ]]; then
  # shellcheck disable=SC1091
  source "$INFRA_DIR/.env"
fi

# --- config (overridable via .env or environment) ---
ACR_LOGIN_SERVER="${ACR_LOGIN_SERVER:-}"
ACR_NAME="${ACR_NAME:-}"
GIT_SHA="$(git -C "$REPO_DIR" rev-parse --short HEAD)"
BUILD_DATE="$(date -u +%Y%m%d)"
DEFAULT_TAG="${GIT_SHA}-v1.12.5-azure-${BUILD_DATE}"
DELIBRA_IMAGE_TAG="${DELIBRA_IMAGE_TAG:-$DEFAULT_TAG}"
PUSH=0
# -----------------------------------------------------

for arg in "$@"; do
  case "$arg" in
    --push) PUSH=1 ;;
    --tag=*) DELIBRA_IMAGE_TAG="${arg#--tag=}" ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [[ ! -d "$INFRA_DIR/prewarm/empirica/bin/version" ]] || \
   ! ls "$INFRA_DIR/prewarm/empirica/bin/version/"v* >/dev/null 2>&1; then
  echo "FATAL: infra/prewarm/empirica/bin/version/ is empty or missing." >&2
  echo "       Run infra/scripts/capture-prewarm-from-running.sh first." >&2
  exit 3
fi

echo "==> Building Delibra bundle..."
"$INFRA_DIR/scripts/build-nas-bundle.sh"

echo "==> Building Docker image: delibra-nas:${DELIBRA_IMAGE_TAG}"
cd "$REPO_DIR"
docker build --pull \
  --build-arg "DELIBRA_UID=${DELIBRA_UID:-10001}" \
  --build-arg "DELIBRA_GID=${DELIBRA_GID:-10001}" \
  --tag "delibra-nas:${DELIBRA_IMAGE_TAG}" \
  --file "$INFRA_DIR/Dockerfile" \
  "$REPO_DIR"

echo
echo "Image built: delibra-nas:${DELIBRA_IMAGE_TAG}"
docker images "delibra-nas:${DELIBRA_IMAGE_TAG}" --format "  {{.Repository}}:{{.Tag}}  {{.Size}}"

if [[ "$PUSH" -ne 1 ]]; then
  echo
  echo "Built locally. To push to ACR, rerun with --push:"
  echo "  $0 --push"
  exit 0
fi

if [[ -z "$ACR_LOGIN_SERVER" || -z "$ACR_NAME" ]]; then
  echo "FATAL: --push requires ACR_LOGIN_SERVER and ACR_NAME in infra/.env" >&2
  exit 4
fi

echo "==> Logging in to $ACR_LOGIN_SERVER"
# Prefer az CLI if available (handles credentials, no secrets in shell).
if command -v az >/dev/null 2>&1; then
  az acr login --name "$ACR_NAME"
else
  echo "       az CLI not installed; using ACR admin credentials from env."
  if [[ -z "${ACR_USERNAME:-}" || -z "${ACR_PASSWORD:-}" ]]; then
    echo "FATAL: set ACR_USERNAME and ACR_PASSWORD in the environment," >&2
    echo "       or install the az CLI and run 'az acr login --name $ACR_NAME'." >&2
    exit 5
  fi
  echo "$ACR_PASSWORD" | docker login "$ACR_LOGIN_SERVER" -u "$ACR_USERNAME" --password-stdin
fi

REMOTE_TAG="$ACR_LOGIN_SERVER/delibra-nas:${DELIBRA_IMAGE_TAG}"
echo "==> Pushing to $REMOTE_TAG"
docker tag "delibra-nas:${DELIBRA_IMAGE_TAG}" "$REMOTE_TAG"
docker push "$REMOTE_TAG"

echo
echo "Push complete. Update the Azure Container App to use:"
echo "  Image:    $ACR_LOGIN_SERVER/delibra-nas"
echo "  Tag:      $DELIBRA_IMAGE_TAG"
