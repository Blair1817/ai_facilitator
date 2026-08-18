#!/bin/sh

set -eu

TAJRIBA_STORE_FILE="${TAJRIBA_STORE_FILE:-/data/tajriba.json}"
SOURCE_BUNDLE="/opt/delibra/delibra.tar.zst"
RUNTIME_CONFIG="/run/secrets/empirica.toml"

if [ -e "$TAJRIBA_STORE_FILE" ]; then
  node /opt/delibra/verify-tajriba-integrity.mjs "$TAJRIBA_STORE_FILE"
else
  echo "[tajriba-integrity] no existing store; Empirica will initialise a new one"
fi

if [ "${1:-}" = "serve" ] && [ "${2:-}" = "$SOURCE_BUNDLE" ]; then
  [ -r "$RUNTIME_CONFIG" ] || {
    echo "FATAL: mounted Empirica runtime config is missing" >&2
    exit 2
  }

  DELIBRA_RUNTIME_ROOT="$(mktemp -d /tmp/delibra-runtime.XXXXXX)"
  DELIBRA_RUNTIME_BUNDLE="$(mktemp /tmp/delibra-runtime.XXXXXX.tar.zst)"
  tar --zstd -xf "$SOURCE_BUNDLE" -C "$DELIBRA_RUNTIME_ROOT"
  cp "$RUNTIME_CONFIG" "$DELIBRA_RUNTIME_ROOT/.empirica/empirica.toml"
  # Empirica's unbundler may overwrite this file while switching to the
  # release pinned in the archive, so the ephemeral copy must remain writable
  # by the non-root runtime user. The mounted source stays mode 400/read-only.
  chmod 600 "$DELIBRA_RUNTIME_ROOT/.empirica/empirica.toml"
  tar --zstd -cf "$DELIBRA_RUNTIME_BUNDLE" \
    -C "$DELIBRA_RUNTIME_ROOT" .empirica callbacks player
  chmod 600 "$DELIBRA_RUNTIME_BUNDLE"
  rm -rf "$DELIBRA_RUNTIME_ROOT"

  ARCHIVE_CONFIG_SHA="$(tar --zstd -xOf "$DELIBRA_RUNTIME_BUNDLE" .empirica/empirica.toml | sha256sum | awk '{print $1}')"
  MOUNTED_CONFIG_SHA="$(sha256sum "$RUNTIME_CONFIG" | awk '{print $1}')"
  if [ "$ARCHIVE_CONFIG_SHA" != "$MOUNTED_CONFIG_SHA" ]; then
    echo "FATAL: runtime bundle did not receive the mounted config" >&2
    exit 3
  fi
  echo "[runtime-config] mounted Empirica config injected into ephemeral bundle"

  if [ "${DELIBRA_PREPARE_ONLY:-0}" = "1" ]; then
    echo "[runtime-config] prepare-only verification passed"
    exit 0
  fi

  shift 2
  set -- serve "$DELIBRA_RUNTIME_BUNDLE" "$@"
fi

exec empirica "$@"
