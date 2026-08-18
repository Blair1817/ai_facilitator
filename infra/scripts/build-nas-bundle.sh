#!/usr/bin/env bash
# Build a production Empirica bundle from a sanitised temporary worktree.
# The checked-out .empirica/local database, backups, credentials, .env files,
# probes, generated output, and OS metadata must never enter the bundle.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="$REPO_DIR/infra/bundle"
BUNDLE_PATH="$OUTPUT_DIR/delibra.tar.zst"
MANIFEST_PATH="$OUTPUT_DIR/manifest.txt"
STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/delibra-bundle.XXXXXX")"
BUNDLE_TMP="$STAGING_DIR/delibra.tar.zst"

cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT

for required in empirica node npm rsync tar shasum git; do
  if ! command -v "$required" >/dev/null 2>&1; then
    echo "FATAL: required command not found: $required" >&2
    exit 2
  fi
done

mkdir -p "$STAGING_DIR/.empirica" "$STAGING_DIR/client" "$STAGING_DIR/server" "$OUTPUT_DIR"

for file in release id treatments.yaml lobbies.yaml; do
  cp "$REPO_DIR/.empirica/$file" "$STAGING_DIR/.empirica/$file"
done
cp "$REPO_DIR/infra/empirica.toml.template" "$STAGING_DIR/.empirica/empirica.toml"
cp "$REPO_DIR/.empirica/.gitignore" "$STAGING_DIR/.empirica/.gitignore"

rsync -a \
  --exclude '.DS_Store' \
  --exclude '.env' \
  --exclude '*.env' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  "$REPO_DIR/client/" "$STAGING_DIR/client/"
rsync -a \
  --exclude '.DS_Store' \
  --exclude '.env' \
  --exclude '*.env' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  "$REPO_DIR/server/" "$STAGING_DIR/server/"

# Reuse the already installed, lockfile-matched dependencies without copying
# them into the bundle. Empirica executes the builds through these symlinks.
ln -s "$REPO_DIR/client/node_modules" "$STAGING_DIR/client/node_modules"
ln -s "$REPO_DIR/server/node_modules" "$STAGING_DIR/server/node_modules"

(
  cd "$STAGING_DIR"
  empirica bundle --out "$BUNDLE_TMP"
)

CONTENTS_FILE="$STAGING_DIR/bundle-contents.txt"
tar -tf "$BUNDLE_TMP" > "$CONTENTS_FILE"

if grep -E '(^|/)(local|backups)(/|$)|(^|/)\.env$|\.DS_Store$|__pycache__|feature_server\.py' "$CONTENTS_FILE" >/dev/null; then
  echo "FATAL: sensitive or stale runtime files entered the Empirica bundle" >&2
  exit 3
fi

# The bundle must contain only the public placeholder admin config. The real
# NAS config is mounted at runtime with --config and never enters the image.
ARCHIVE_CONFIG_SHA="$(tar -xOf "$BUNDLE_TMP" .empirica/empirica.toml | shasum -a 256 | awk '{print $1}')"
TEMPLATE_CONFIG_SHA="$(shasum -a 256 "$REPO_DIR/infra/empirica.toml.template" | awk '{print $1}')"
if [[ "$ARCHIVE_CONFIG_SHA" != "$TEMPLATE_CONFIG_SHA" ]]; then
  echo "FATAL: bundle config differs from the public placeholder template" >&2
  exit 4
fi

# Strip the `volta` field from every package.json in the bundle. Empirica
# v1.12's serve re-runs `npm run build` per start; npm/pnpm honour the
# `volta` field and try to download the pinned node version from
# github.com. The NAS has no public internet, so the install hangs and
# the health check times out. Removing `volta` makes the system node
# 20.12.2 (the image base) the canonical version.
PATCHED_BUNDLE_TMP="$STAGING_DIR/delibra-patched.tar.zst"
python3 - "$BUNDLE_TMP" "$PATCHED_BUNDLE_TMP" <<'PY'
import json, sys, tarfile, io, zstandard as zstd
src, dst = sys.argv[1], sys.argv[2]
dctx = zstd.ZstdDecompressor()
cctx = zstd.ZstdCompressor()
with tarfile.open(src, "r:zst") as ti, \
     tarfile.open(dst, "w:zst", compresslevel=3) as to:
    for m in ti:
        if m.isfile() and m.name.endswith("package.json"):
            with ti.extractfile(m) as f:
                data = f.read()
            try:
                pkg = json.loads(data)
            except Exception:
                pkg = None
            if isinstance(pkg, dict) and "volta" in pkg:
                del pkg["volta"]
                data = (json.dumps(pkg, indent=2) + "\n").encode("utf-8")
                buf = io.BytesIO(data)
                info = tarfile.TarInfo(name=m.name)
                info.size = len(data)
                info.mode = 0o644
                info.mtime = m.mtime
                to.addfile(info, buf)
                continue
        # default: copy the original member as-is
        if m.isfile():
            with ti.extractfile(m) as f:
                data = f.read()
        else:
            data = None
        to.addfile(m) if data is None else to.addfile(m, io.BytesIO(data))
PY
BUNDLE_TMP="$PATCHED_BUNDLE_TMP"

COMMIT="$(git -C "$REPO_DIR" rev-parse HEAD)"
DIRTY="clean"
if [[ -n "$(git -C "$REPO_DIR" status --porcelain)" ]]; then
  DIRTY="dirty"
fi
BUNDLE_SHA="$(shasum -a 256 "$BUNDLE_TMP" | awk '{print $1}')"
BUILT_AT="$(date -u +%FT%TZ)"

cp "$BUNDLE_TMP" "$BUNDLE_PATH"

cat > "$MANIFEST_PATH" <<EOF
built_at_utc=$BUILT_AT
commit=$COMMIT
working_tree=$DIRTY
empirica_version=$(empirica version | awk '/^Version:/ {print $2; exit}')
bundle_sha256=$BUNDLE_SHA
EOF

chmod 600 "$BUNDLE_PATH" "$MANIFEST_PATH"
echo "Bundle OK: $BUNDLE_PATH"
echo "SHA-256: $BUNDLE_SHA"
echo "Source: $COMMIT ($DIRTY)"
