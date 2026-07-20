#!/usr/bin/env bash
# Shared helpers for the cost-suite setup scripts.
#
# Auth: export NP_API_KEY (or pass --env-file <file> with NP_API_KEY=…).
# All scripts are idempotent and safe to re-run.

set -euo pipefail

API_BASE="${NP_API_BASE:-https://api.nullplatform.com}"
ENGINE_BASE="$API_BASE/workflows"

parse_common_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --env-file)
        # shellcheck disable=SC1090
        set -a; source "$2"; set +a; shift 2 ;;
      *) shift ;;
    esac
  done
}

require_key() {
  if [[ -z "${NP_API_KEY:-}" ]]; then
    echo "ERROR: export NP_API_KEY or pass --env-file <file>" >&2
    exit 1
  fi
}

TOKEN=""
ORG_ID=""

mint_token() {
  require_key
  local resp
  resp=$(curl -fsS -X POST "$API_BASE/token" \
    -H 'Content-Type: application/json' -H 'Accept: application/json' \
    -d "{\"api_key\": \"$NP_API_KEY\"}")
  TOKEN=$(jq -r '.access_token' <<<"$resp")
  ORG_ID=$(jq -r '.organization_id // empty' <<<"$resp")
  [[ -n "$TOKEN" && "$TOKEN" != "null" ]] || { echo "ERROR: token exchange failed: $resp" >&2; exit 1; }
  echo "token OK (organization_id: ${ORG_ID:-unknown})" >&2
}

# api <method> <path> [json-body] → body on stdout.
# Status goes to a file (callers usually run `api` inside $(...), where a
# plain variable would die with the subshell). Read it with `last_status`.
STATUS_FILE="/tmp/np-setup-status.$$"
api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -X "$method" "$API_BASE$path" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -o /tmp/np-setup-resp.json -w '%{http_code}')
  [[ -n "$body" ]] && args+=(-d "$body")
  curl "${args[@]}" > "$STATUS_FILE" || true
  cat /tmp/np-setup-resp.json
}
last_status() { cat "$STATUS_FILE" 2>/dev/null; }
# Back-compat: scripts that referenced $LAST_STATUS directly should migrate
# to last_status; keep the variable for direct (non-subshell) api calls.
LAST_STATUS=""
