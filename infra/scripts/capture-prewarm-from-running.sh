#!/usr/bin/env bash
# Capture the Tajriba binary + Volta runtime from a running v1.12.5
# Empirica container so the next docker build can run offline
# (no github.com / install.empirica.dev fetch on first start).
#
# Why this exists:
#   The Dockerfile COPYs infra/prewarm/ into the image. infra/prewarm/
#   is gitignored ("Never commit — it's a binary cache"). On a fresh
#   build host — e.g. a teammate's Mac or a CI runner — there is no
#   prewarm yet. This script populates it by `docker exec`ing into a
#   known-good running v1.12.5 container and pulling the cache out.
#
# Usage:
#   1. Make sure you have a v1.12.5 container running somewhere
#      reachable (the NAS at 192.168.0.109:922 is the source of
#      truth for this project).
#   2. Run:  infra/scripts/capture-prewarm-from-running.sh
#   3. It writes to infra/prewarm/. Then `docker build` works.
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
