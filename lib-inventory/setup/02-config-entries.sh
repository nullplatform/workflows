#!/usr/bin/env bash
# Upserts the config entries the lib-inventory workflows read, at engine path
# /lib-inventory. Re-running rotates values in place (POST /workflows/config is
# an upsert by name+path).
#
# GITHUB_TOKEN is a SECRET and needs read access to the repositories of the
# applications in scope. A fine-grained PAT must list them explicitly — verify
# with `curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user/repos`
# before running, because a token that sees zero repos fails every scan with
# `repo_unreachable` and looks exactly like a permissions bug in NP.
#
# NP_API_KEY is written ONCE at root path "/" and is NEVER overwritten by a
# re-run — GET is checked first so this can't clobber a live secret.
#
# Usage:
#   ./02-config-entries.sh --env-file ../../../.env.the reference organization \
#     [--scope-nrn organization=X:account=Y:namespace=Z:application=W] \
#     [--internal-patterns '["^github\\.com/acme/"]'] \
#     [--max-builds 50] [--min-coverage 95] [--lookback-days 15] \
#     [--github-token ghp_…]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../cost/setup/lib.sh
source "$SCRIPT_DIR/../../cost/setup/lib.sh"

# Empty resolves to the whole org after mint_token. Pass a deeper NRN to stage
# the rollout — that is the intended starting point.
SCOPE_NRN=""
INTERNAL_PATTERNS=""
MAX_BUILDS="50"
MIN_COVERAGE="95"
# The backfill scans what is ACTIVE plus anything deployed within this many
# days — recent history, so a rollback candidate's inventory already exists.
LOOKBACK_DAYS="15"
GH_TOKEN=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)          set -a; source "$2"; set +a; shift 2 ;;
    --scope-nrn)         SCOPE_NRN="$2";          shift 2 ;;
    --internal-patterns) INTERNAL_PATTERNS="$2";  shift 2 ;;
    --max-builds)        MAX_BUILDS="$2";         shift 2 ;;
    --min-coverage)      MIN_COVERAGE="$2";       shift 2 ;;
    --lookback-days)     LOOKBACK_DAYS="$2";      shift 2 ;;
    --github-token)      GH_TOKEN="$2";           shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

# --github-token wins over whatever --env-file exported.
GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [[ -z "$GH_TOKEN" ]]; then
  echo "ERROR: no GitHub token. Pass --github-token or put GITHUB_TOKEN in the env file." >&2
  exit 1
fi

mint_token
[[ -n "$SCOPE_NRN" ]] || SCOPE_NRN="organization=$ORG_ID"
[[ -n "$INTERNAL_PATTERNS" ]] || {
  echo "ERROR: --internal-patterns is required — without it every dependency" >&2
  echo "       looks external and the inventory keeps only direct deps." >&2
  echo "       Example: --internal-patterns '[\"^github\\\\.com/acme/\"]'" >&2
  exit 1
}

# Fail loudly here rather than 6,733 times inside the scanner.
echo "Checking the GitHub token can actually see repositories:"
gh_code=$(curl -sS -o /tmp/np-gh-check.json -w '%{http_code}' \
  -H "Authorization: Bearer $GH_TOKEN" -H 'User-Agent: np-lib-inventory-setup' \
  'https://api.github.com/user/repos?per_page=1')
if [[ "$gh_code" != "200" ]]; then
  echo "  FAILED: GitHub returned $gh_code — the token is invalid or expired." >&2
  exit 1
fi
gh_login=$(curl -sS -H "Authorization: Bearer $GH_TOKEN" -H 'User-Agent: np-lib-inventory-setup' \
  https://api.github.com/user | jq -r '.login // "?"')
if [[ "$(jq 'length' /tmp/np-gh-check.json)" == "0" ]]; then
  echo "  WARNING: token '$gh_login' lists ZERO repositories." >&2
  echo "  A fine-grained PAT must grant Contents:read on each repository in scope." >&2
  echo "  Every scan will report repo_unreachable until that is fixed." >&2
else
  echo "  token OK (user: $gh_login)"
fi

put() { # name value secret(true|false) path
  local body out
  body=$(jq -n --arg name "$1" --arg value "$2" --argjson secret "$3" --arg path "$4" \
    '{name: $name, value: $value, secret: $secret, path: $path}')
  out=$(api POST "/workflows/config" "$body")
  if [[ "$(last_status)" =~ ^2 ]]; then
    echo "  $4 $1 → $(jq -r '.mode // "upserted"' <<<"$out")"
  else
    echo "  $4 $1 FAILED ($(last_status)): $out"; exit 1
  fi
}

echo "Upserting config entries on /lib-inventory:"
put LIB_SCAN_NRN_PREFIX   "$SCOPE_NRN"          false "/lib-inventory"
put LIB_INTERNAL_PATTERNS "$INTERNAL_PATTERNS"  false "/lib-inventory"
put LIB_MAX_BUILDS        "$MAX_BUILDS"         false "/lib-inventory"
put LIB_MIN_COVERAGE_PCT  "$MIN_COVERAGE"       false "/lib-inventory"
put LIB_BACKFILL_LOOKBACK_DAYS "$LOOKBACK_DAYS" false "/lib-inventory"
put GITHUB_TOKEN          "$GH_TOKEN"           true  "/lib-inventory"

echo "Checking root secret NP_API_KEY (path /):"
existing=$(api GET "/workflows/config?path=/")
st="$(last_status)"
if [[ "$st" =~ ^2 ]]; then
  if jq -e '(.data // .) | map(select(.name == "NP_API_KEY")) | length > 0' <<<"$existing" >/dev/null 2>&1; then
    echo "  / NP_API_KEY already exists → left untouched (never clobber a live secret)"
  else
    put NP_API_KEY "$NP_API_KEY" true "/"
  fi
else
  echo "FAILED: could not verify existing secret (status $st) — refusing to write NP_API_KEY"
  exit 1
fi

echo
echo "Scope is pinned to: $SCOPE_NRN"
echo "Widen it later with: ./02-config-entries.sh --env-file … --scope-nrn organization=$ORG_ID"
