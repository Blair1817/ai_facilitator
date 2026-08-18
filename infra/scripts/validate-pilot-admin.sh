#!/usr/bin/env bash
# Validate the mounted Tajriba operator credential without printing the
# username, password, GraphQL response, or returned session token.

set -euo pipefail

CONFIG_FILE="${1:-/mnt/dm-0/delibra/secrets/empirica.toml}"
ENDPOINT="${2:-http://192.168.0.109:3000/query}"

USERNAME="$(sed -n 's/^username = "\(.*\)"/\1/p' "$CONFIG_FILE")"
PASSWORD="$(sed -n 's/^password = "\(.*\)"/\1/p' "$CONFIG_FILE")"
[[ -n "$USERNAME" && -n "$PASSWORD" ]] || {
  echo "FATAL: operator credential fields are missing" >&2
  exit 2
}

PAYLOAD="$(
  DELIBRA_ADMIN_USERNAME="$USERNAME" DELIBRA_ADMIN_PASSWORD="$PASSWORD" \
    python3 - <<'PY'
import json
import os
print(json.dumps({
    "query": "mutation Login($input: LoginInput!) { login(input: $input) { sessionToken user { username } } }",
    "variables": {"input": {
        "username": os.environ["DELIBRA_ADMIN_USERNAME"],
        "password": os.environ["DELIBRA_ADMIN_PASSWORD"],
    }},
}))
PY
)"
RESPONSE="$(curl -fsS -H 'content-type: application/json' --data-binary "$PAYLOAD" "$ENDPOINT")"

DELIBRA_ADMIN_USERNAME="$USERNAME" DELIBRA_LOGIN_RESPONSE="$RESPONSE" python3 - <<'PY'
import json
import os
response = json.loads(os.environ["DELIBRA_LOGIN_RESPONSE"])
data = response.get("data") or {}
login = data.get("login") or {}
token = login.get("sessionToken") or ""
username = (login.get("user") or {}).get("username")
if len(token) < 20 or username != os.environ["DELIBRA_ADMIN_USERNAME"]:
    messages = [str(item.get("message", "GraphQL error")) for item in response.get("errors", [])]
    summary = "; ".join(messages[:3]) or "no login data returned"
    raise SystemExit(f"operator login validation failed: {summary}")
print("Operator login validated without exposing credentials or session token.")
PY
