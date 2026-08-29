#!/usr/bin/env bash
# LEGACY NAS RECOVERY UTILITY ONLY.
#
# Capture the Tajriba binary + Volta runtime from an existing v1.12.5
# Empirica container for an old offline NAS recovery workflow.
#
# Why this exists:
#   Historical NAS builds used a cache copied from a running container.
#   The Azure fresh-image Dockerfile now downloads checksum-pinned official
#   Linux AMD64 Empirica and Volta artifacts and DOES NOT read infra/prewarm/.
#   Neither the Azure helper nor GitHub Actions invokes this script, and the
#   NAS container is not an authoritative source for Azure images.
#
# Usage:
#   1. Only for deliberate legacy recovery, identify an existing compatible
#      container and obtain permission to access it.
#   2. Run:  infra/scripts/capture-prewarm-from-running.sh
#   3. It writes to infra/prewarm/ for the legacy recovery procedure only.
#
# SSH / Docker host selection: this script talks to the NAS via SSH.
# Adjust NAS_HOST / NAS_PORT / NAS_SSH_KEY below if your NAS differs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$INFRA_DIR/.." && pwd)"
PREWARM_DIR="$INFRA_DIR/prewarm"

# --- NAS connection (edit if your NAS is on a different host/port/key) ---
NAS_HOST="192.168.0.109"
NAS_PORT="922"
NAS_USER="root"
NAS_SSH_KEY="${NAS_SSH_KEY:-$HOME/.ssh/id_nas}"
CONTAINER_NAME="delibra-empirica"
# --------------------------------------------------------------------------

# Sanity: do not silently clobber an existing prewarm/ that has data.
if [[ -d "$PREWARM_DIR/empirica/bin/version" ]] && \
   ls "$PREWARM_DIR/empirica/bin/version/" 2>/dev/null | grep -q v; then
  echo "prewarm/empirica/bin/version/ already populated. Refusing to overwrite." >&2
  echo "Delete it manually if you want to recapture." >&2
  exit 1
fi

if [[ ! -f "$NAS_SSH_KEY" ]]; then
  echo "FATAL: SSH key not found at $NAS_SSH_KEY" >&2
  echo "       Set NAS_SSH_KEY=/path/to/key to override." >&2
  exit 2
fi

SSH=(ssh -p "$NAS_PORT" -i "$NAS_SSH_KEY" -o StrictHostKeyChecking=no "$NAS_USER@$NAS_HOST")

echo "[1/3] Verifying $CONTAINER_NAME on $NAS_HOST is running v1.12.5..."
"${SSH[@]}" "docker inspect $CONTAINER_NAME --format '{{.State.Running}} {{.Config.Image}}'" >&2
REMOTE_VER=$("${SSH[@]}" "docker exec $CONTAINER_NAME /home/delibra/.cache/empirica/bin/version/v1.12.5 --version" 2>/dev/null \
             || true)
if ! "${SSH[@]}" "docker exec $CONTAINER_NAME test -x /home/delibra/.cache/empirica/bin/version/v1.12.5" >/dev/null 2>&1; then
  echo "FATAL: $CONTAINER_NAME does not have v1.12.5 in its cache. Aborting." >&2
  echo "       Either upgrade the running container first, or capture from a different one." >&2
  exit 3
fi

echo "[2/3] Pulling v1.12.0 and v1.12.5 Tajriba binaries from the container..."
mkdir -p "$PREWARM_DIR/empirica/bin/version"
for ver in v1.12.0 v1.12.5; do
  TMP=$(mktemp -d)
  "${SSH[@]}" "docker cp $CONTAINER_NAME:/home/delibra/.cache/empirica/bin/version/$ver $TMP/$ver" >&2
  install -m 0755 "$TMP/$ver" "$PREWARM_DIR/empirica/bin/version/$ver"
  rm -rf "$TMP"
  echo "      $ver: $(shasum -a 256 "$PREWARM_DIR/empirica/bin/version/$ver" | awk '{print $1}')"
done

# Volta: optional. On Azure the container has outbound internet, so the
# first `empirica serve` will install Volta via get.volta.sh if missing.
# Capturing it makes first starts deterministic on hosts without internet.
if "${SSH[@]}" "docker exec $CONTAINER_NAME test -d /home/delibra/.local/share/empirica/volta" >/dev/null 2>&1; then
  echo "[3/3] Pulling Volta runtime from the container (optional but recommended)..."
  TMP=$(mktemp -d)
  "${SSH[@]}" "docker cp $CONTAINER_NAME:/home/delibra/.local/share/empirica/volta $TMP/volta" >&2
  rm -rf "$PREWARM_DIR/volta"
  cp -R "$TMP/volta" "$PREWARM_DIR/volta"
  rm -rf "$TMP"
  echo "      volta: $(du -sh "$PREWARM_DIR/volta" | awk '{print $1}')"
else
  echo "[3/3] Volta not in container, skipping (Azure has outbound internet anyway)."
fi

echo
echo "Prewarm captured to $PREWARM_DIR"
ls -la "$PREWARM_DIR/empirica/bin/version/"
