#!/usr/bin/env bash
# Build the pinned Delibra image on old UGOS releases that provide Docker but
# not the Docker Compose plugin. This script does not start or replace anything.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$INFRA_DIR/.." && pwd)"

cd "$INFRA_DIR"
[[ -f .env ]] || { echo "FATAL: create infra/.env first" >&2; exit 2; }
# shellcheck disable=SC1091
source .env

for variable in DELIBRA_UID DELIBRA_GID DELIBRA_IMAGE_TAG; do
  [[ -n "${!variable:-}" ]] || { echo "FATAL: $variable is missing" >&2; exit 3; }
done
[[ -s bundle/delibra.tar.zst && -s bundle/manifest.txt ]] || {
  echo "FATAL: the verified NAS bundle and manifest are missing" >&2
  exit 4
}

docker build --pull \
  --build-arg "DELIBRA_UID=$DELIBRA_UID" \
  --build-arg "DELIBRA_GID=$DELIBRA_GID" \
  --tag "delibra-nas:$DELIBRA_IMAGE_TAG" \
  --file "$INFRA_DIR/Dockerfile" \
  "$REPO_DIR"

echo "Legacy UGOS image build OK: delibra-nas:$DELIBRA_IMAGE_TAG"
