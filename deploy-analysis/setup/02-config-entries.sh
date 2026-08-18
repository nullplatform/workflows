#!/usr/bin/env bash
# Config entries for the deploy-analysis suite, at folder /deploy-analysis.
#
# Secrets (values via env, never echoed):
#   NP_API_KEY            — key the workflows use for lake queries + metadata writes
#                           (needs metadata read/write on the analyzed namespaces)
#   GITHUB_TOKEN          — PAT that can read the analyzed applications' repos
#                           (compare, PRs, reviews). Prefer a service PAT.
# Vars (plain, shared):
#   DEPLOY_ANALYSIS_NAMESPACES   — comma-separated namespace ids to analyze
#   DEPLOY_ANALYSIS_ENVIRONMENTS — comma-separated scope `environment` dimension
#                                  values (e.g. "prod,stage"); check YOUR org's
#                                  slugs — some use `prod`, others `production`.
#
# Usage:
#   NP_API_KEY=… GITHUB_TOKEN=… ./02-config-entries.sh \
#     --namespaces "<ns1>,<ns2>" --environments "prod,stage" [--env-file <file>]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../cost/setup/lib.sh
source "$SCRIPT_DIR/../../cost/setup/lib.sh"

NAMESPACES=""
ENVIRONMENTS="prod,stage"
ARGS=("$@")
i=0
while [[ $i -lt ${#ARGS[@]} ]]; do
  case "${ARGS[$i]}" in
    --env-file)     set -a; source "${ARGS[$((i+1))]}"; set +a; i=$((i+2)) ;;
    --namespaces)   NAMESPACES="${ARGS[$((i+1))]}"; i=$((i+2)) ;;
    --environments) ENVIRONMENTS="${ARGS[$((i+1))]}"; i=$((i+2)) ;;
    *) i=$((i+1)) ;;
  esac
done
[[ -n "$NAMESPACES" ]] || { echo "usage: $0 --namespaces \"<ns1>,<ns2>\" [--environments \"prod,stage\"]" >&2; exit 1; }
[[ -n "${GITHUB_TOKEN:-}" ]] || { echo "ERROR: export GITHUB_TOKEN" >&2; exit 1; }

mint_token

set_entry() {
  local name="$1" value="$2" secret="$3"
  local body out
  body=$(jq -n --arg n "$name" --arg v "$value" --argjson s "$secret" \
    '{name:$n, value:$v, secret:$s, path:"/deploy-analysis"}')
  out=$(api POST "/workflows/config" "$body")
  [[ "$(last_status)" =~ ^2 ]] && echo "  $name: $(jq -r '.mode // "ok"' <<<"$out")" \
    || { echo "FAILED $name ($(last_status)): $out" >&2; exit 1; }
}

set_entry NP_API_KEY   "$NP_API_KEY"    true
set_entry GITHUB_TOKEN "$GITHUB_TOKEN"  true
set_entry DEPLOY_ANALYSIS_NAMESPACES   "$NAMESPACES"   false
set_entry DEPLOY_ANALYSIS_ENVIRONMENTS "$ENVIRONMENTS" false
echo "done."
