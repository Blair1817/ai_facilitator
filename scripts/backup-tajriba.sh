#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
project_dir="$(cd "$script_dir/.." && pwd)"
backup_dir="$project_dir/.empirica/backups"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
found=0

mkdir -p "$backup_dir"

for relative_path in ".empirica/local/tajriba.json" ".empirica/tajriba.json" ".empirica/local/export-audit.jsonl"; do
  source_path="$project_dir/$relative_path"
  if [[ ! -f "$source_path" ]]; then
    continue
  fi
  found=1
  safe_name="${relative_path//\//_}"
  destination="$backup_dir/${timestamp}_${safe_name}"
  cp -p "$source_path" "$destination"
  shasum -a 256 "$destination" > "$destination.sha256"
  echo "Backed up $relative_path -> $destination"
done

if [[ "$found" -eq 0 ]]; then
  echo "No Tajriba JSON database found; refusing to claim that a backup exists." >&2
  exit 1
fi
