#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
project_dir="$(cd "$script_dir/.." && pwd)"

"$script_dir/backup-tajriba.sh"
cd "$project_dir"
exec empirica "$@"
