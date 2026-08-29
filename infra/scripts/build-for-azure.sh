#!/usr/bin/env bash
# Build the Delibra production image as linux/amd64 and optionally push it to
# the project's Azure Container Registry. This path is independent of the NAS
# and never uses infra/prewarm/ or capture-prewarm-from-running.sh.
#
# Usage:
#   infra/scripts/build-for-azure.sh
#   infra/scripts/build-for-azure.sh --push
#
# The immutable tag is always:
#   <7-char-git-sha>-v1.12.5-azure-<UTC-YYYYMMDD>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$INFRA_DIR/.." && pwd)"

readonly ACR_LOGIN_SERVER="acrdelibra-hhckbjfbe3ctata7.azurecr.io"
readonly ACR_NAME="acrdelibra"
readonly IMAGE_REPOSITORY="delibra-nas"
readonly EMPIRICA_VERSION="v1.12.5"
readonly IMAGE_PLATFORM="linux/amd64"

PUSH=0
for arg in "$@"; do
  case "$arg" in
    --push) PUSH=1 ;;
    -h|--help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

require_clean_release_source() {
  if ! command -v git >/dev/null 2>&1; then
    echo "FATAL: --push requires Git so the release source can be verified." >&2
    exit 2
  fi

  if [[ "$(git -C "$REPO_DIR" rev-parse --is-inside-work-tree 2>/dev/null || true)" != "true" ]] ||
    ! git -C "$REPO_DIR" rev-parse --verify HEAD >/dev/null 2>&1; then
    echo "FATAL: --push requires the project source to be a real Git repository with a committed HEAD." >&2
    exit 2
  fi

  if ! git -C "$REPO_DIR" diff --cached --quiet --ignore-submodules -- ||
    ! git -C "$REPO_DIR" diff --quiet --ignore-submodules -- ||
    [[ -n "$(git -C "$REPO_DIR" ls-files --others --exclude-standard)" ]]; then
    echo "FATAL: --push requires a clean Git source tree (no staged, unstaged, or untracked files)." >&2
    echo "Review 'git status --short' and commit or otherwise resolve the changes explicitly; no cleanup was performed." >&2
    exit 6
  fi
}

require_expected_post_build_source() {
  local allowed_generated_path="infra/bundle/manifest.txt"
  local path
  local changed_paths=""

  while IFS= read -r -d '' path; do
    changed_paths+="  ${path}"$'\n'
  done < <(git -C "$REPO_DIR" diff --cached --name-only -z --ignore-submodules --)

  if [[ -n "$changed_paths" ]]; then
    echo "ERROR: Refusing to push because staged changes appeared during the build:" >&2
    printf '%s' "$changed_paths" >&2
    exit 6
  fi

  changed_paths=""
  while IFS= read -r -d '' path; do
    if [[ "$path" != "$allowed_generated_path" ]]; then
      changed_paths+="  ${path}"$'\n'
    fi
  done < <(git -C "$REPO_DIR" diff --name-only -z --ignore-submodules --)

  if [[ -n "$changed_paths" ]]; then
    echo "ERROR: Refusing to push because unexpected tracked files changed during the build:" >&2
    printf '%s' "$changed_paths" >&2
    echo "Only ${allowed_generated_path} may change during bundle generation." >&2
    exit 6
  fi

  changed_paths=""
  while IFS= read -r -d '' path; do
    changed_paths+="  ${path}"$'\n'
  done < <(git -C "$REPO_DIR" ls-files --others --exclude-standard -z)

  if [[ -n "$changed_paths" ]]; then
    echo "ERROR: Refusing to push because untracked files appeared during the build:" >&2
    printf '%s' "$changed_paths" >&2
    exit 6
  fi
}

if [[ "$PUSH" -eq 1 ]]; then
  # Release tags claim an exact commit. Refuse dirty or non-Git source before
  # any dependency installation, image build, Azure authentication, or push.
  require_clean_release_source
fi

for required in docker git empirica node npm rsync tar shasum zstd python3; do
  if ! command -v "$required" >/dev/null 2>&1; then
    echo "FATAL: required command not found: $required" >&2
    exit 2
  fi
done

PROJECT_EMPIRICA_VERSION="$(awk -F': *' '/^version:/ {print $2; exit}' "$REPO_DIR/.empirica/release")"
if [[ "$PROJECT_EMPIRICA_VERSION" != "$EMPIRICA_VERSION" ]]; then
  echo "FATAL: expected Empirica $EMPIRICA_VERSION, found ${PROJECT_EMPIRICA_VERSION:-unknown}" >&2
  exit 3
fi

GIT_SHA="$(git -C "$REPO_DIR" rev-parse --short=7 HEAD)"
BUILD_DATE="$(date -u +%Y%m%d)"
IMAGE_TAG="${GIT_SHA}-${EMPIRICA_VERSION}-azure-${BUILD_DATE}"
LOCAL_IMAGE="${IMAGE_REPOSITORY}:${IMAGE_TAG}"
REMOTE_IMAGE="${ACR_LOGIN_SERVER}/${IMAGE_REPOSITORY}:${IMAGE_TAG}"

echo "==> Installing exact client dependencies..."
npm ci --prefix "$REPO_DIR/client"

echo "==> Installing exact server dependencies..."
npm ci --prefix "$REPO_DIR/server"

echo "==> Building sanitised Delibra bundle..."
DELIBRA_SKIP_NPM_CI=1 "$INFRA_DIR/scripts/build-nas-bundle.sh"

echo "==> Building $LOCAL_IMAGE for $IMAGE_PLATFORM..."
docker build --pull \
  --platform "$IMAGE_PLATFORM" \
  --build-arg "DELIBRA_UID=${DELIBRA_UID:-10001}" \
  --build-arg "DELIBRA_GID=${DELIBRA_GID:-10001}" \
  --tag "$LOCAL_IMAGE" \
  --file "$INFRA_DIR/Dockerfile" \
  "$REPO_DIR"

IMAGE_ARCH="$(docker image inspect "$LOCAL_IMAGE" --format '{{.Os}}/{{.Architecture}}')"
if [[ "$IMAGE_ARCH" != "$IMAGE_PLATFORM" ]]; then
  echo "FATAL: expected image platform $IMAGE_PLATFORM, built $IMAGE_ARCH" >&2
  exit 4
fi

echo
echo "Image built and verified: $LOCAL_IMAGE ($IMAGE_ARCH)"

if [[ "$PUSH" -ne 1 ]]; then
  echo "No registry push requested. To push this deterministic build, rerun:"
  echo "  $0 --push"
  exit 0
fi

# Re-check immediately before any Azure authentication. This catches source
# changes made while dependencies, the bundle, or the image were being built.
require_expected_post_build_source

if ! command -v az >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  echo "FATAL: --push requires Azure CLI, curl, and an authenticated Azure identity; admin credentials are not supported." >&2
  exit 5
fi

echo "==> Verifying Azure identity and immutable target tag..."
az account show --output none

ACR_TOKEN="$(az acr login --name "$ACR_NAME" --expose-token --output tsv --query accessToken)"
if [[ -z "$ACR_TOKEN" ]]; then
  echo "FATAL: Azure CLI did not return a registry access token." >&2
  exit 7
fi

MANIFEST_STATUS="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --request HEAD \
  --header "Authorization: Bearer $ACR_TOKEN" \
  --header 'Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
  "https://${ACR_LOGIN_SERVER}/v2/${IMAGE_REPOSITORY}/manifests/${IMAGE_TAG}")"

case "$MANIFEST_STATUS" in
  200)
    unset ACR_TOKEN
    echo "FATAL: immutable release tag already exists: $REMOTE_IMAGE" >&2
    echo "No overwrite, deletion, reuse, or automatic replacement tag was attempted." >&2
    exit 8
    ;;
  404) ;;
  *)
    unset ACR_TOKEN
    echo "FATAL: could not prove that the release tag is absent (ACR returned HTTP $MANIFEST_STATUS)." >&2
    echo "Failing closed without publishing $REMOTE_IMAGE." >&2
    exit 9
    ;;
esac

echo "==> Authenticating Docker to $ACR_LOGIN_SERVER through Azure CLI..."
printf '%s' "$ACR_TOKEN" | docker login "$ACR_LOGIN_SERVER" \
  --username 00000000-0000-0000-0000-000000000000 \
  --password-stdin >/dev/null
unset ACR_TOKEN

echo "==> Pushing immutable tag $REMOTE_IMAGE..."
docker tag "$LOCAL_IMAGE" "$REMOTE_IMAGE"
docker push "$REMOTE_IMAGE"

ACR_DIGEST="$(az acr repository show \
  --name "$ACR_NAME" \
  --image "${IMAGE_REPOSITORY}:${IMAGE_TAG}" \
  --query digest \
  --output tsv)"
if [[ -z "$ACR_DIGEST" ]]; then
  echo "FATAL: image push completed but the immutable ACR digest could not be read." >&2
  exit 10
fi

echo
echo "Push complete"
echo "Git commit: $(git -C "$REPO_DIR" rev-parse HEAD)"
echo "Bundle SHA: $(awk -F= '/^bundle_sha256=/ {print $2}' "$INFRA_DIR/bundle/manifest.txt")"
echo "Image tag:  $REMOTE_IMAGE"
echo "ACR digest: $ACR_DIGEST"
