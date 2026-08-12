#!/usr/bin/env bash
# Upserts the config entries the security-assessment workflows read, at
# engine path /action-items/security-assessment. Re-running rotates values
# in place (POST /workflows/config is an upsert by name+path).
#
# GITHUB_TOKEN needs read access to the repositories the scanner's agent step
# clones and reviews. A fine-grained PAT must list them explicitly.
#
# NP_API_KEY doubles as the workflows' credential (every np-api-call step and
# the ensure-action-item sub-workflow read secrets.NP_API_KEY). It is written
# ONCE at root path "/" (shared across every workflow suite in the org) and is
# NEVER overwritten by a re-run if an entry already exists there — GET is
# checked first so this can't clobber a live secret.
#
# SEC_AGENT_MODEL is intentionally NOT seeded here — the workflow falls back
# to a default via `${{ vars.SEC_AGENT_MODEL || 'claude-sonnet-5' }}`; set it
# manually with POST /workflows/config only if you need a non-default model.
#
# Usage:
#   NP_API_KEY=… GITHUB_TOKEN=… NP_ORGANIZATION_ID=<org id> \
#     SEC_CATEGORY_SLUG=<existing category slug> ./01-config-entries.sh
#   ./01-config-entries.sh --env-file ../../.env.null

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../cost/setup/lib.sh
source "$SCRIPT_DIR/../../cost/setup/lib.sh"

parse_common_args "$@"

FOLDER="/action-items/security-assessment"

: "${GITHUB_TOKEN:?set GITHUB_TOKEN}"
: "${NP_ORGANIZATION_ID:?set NP_ORGANIZATION_ID}"
: "${SEC_CATEGORY_SLUG:?set SEC_CATEGORY_SLUG}"
SEC_MIN_SEVERITY="${SEC_MIN_SEVERITY:-medium}"
SEC_DUE_DAYS="${SEC_DUE_DAYS:-14}"

mint_token

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

echo "Upserting config entries on $FOLDER:"
put GITHUB_TOKEN       "$GITHUB_TOKEN"       true  "$FOLDER"
put NP_ORGANIZATION_ID "$NP_ORGANIZATION_ID" false "$FOLDER"
put SEC_CATEGORY_SLUG  "$SEC_CATEGORY_SLUG"  false "$FOLDER"
put SEC_MIN_SEVERITY   "$SEC_MIN_SEVERITY"   false "$FOLDER"
put SEC_DUE_DAYS       "$SEC_DUE_DAYS"       false "$FOLDER"

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
echo "Folder: $FOLDER"
