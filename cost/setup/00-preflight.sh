#!/usr/bin/env bash
# Preflight for the cost/right-sizing suite: verifies every grant and API the
# workflows need, WITHOUT creating anything. Run first, fix what it flags.
#
# Usage: NP_API_KEY=… ./00-preflight.sh   (or ./00-preflight.sh --env-file ../../../.env.demo)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
parse_common_args "$@"
mint_token

pass=0; fail=0
check() { # <label> <expected-status-regex> <method> <path> [body]
  local label="$1" expect="$2" method="$3" path="$4" body="${5:-}"
  local out
  out=$(api "$method" "$path" "$body" 2>/dev/null || true)
  if [[ "$(last_status)" =~ $expect ]]; then
    echo "  OK   $label ($(last_status))"; pass=$((pass+1))
  else
    echo "  FAIL $label — got $(last_status): $(head -c 150 <<<"$out")"; fail=$((fail+1))
  fi
}

echo "== Core grants =="
check "engine: list definitions"    "200" GET "/workflows/definitions?limit=1"
check "engine: config entries read" "200" GET "/workflows/config?path=/cost"
check "lake: query"                 "200" POST "/data/lake/query" '{"query":"SELECT 1 FORMAT JSON"}'
check "governance: list items"      "200" GET "/governance/action_item?nrn=organization=$ORG_ID&limit=1"
check "governance: list categories" "200" GET "/governance/action_item_category?nrn=organization=$ORG_ID&limit=10"

echo "== Agent channel =="
agents=$(api GET "/controlplane/agent?status=active&limit=100" || true)
if [[ "$(last_status)" == "200" ]]; then
  count=$(jq -r '(.results // .) | length' <<<"$agents" 2>/dev/null || echo 0)
  echo "  OK   controlplane: $count active agent(s)"
  jq -r '(.results // .)[] | "       - id=\(.id) nrn=\(.nrn // "?") tags=\(.tags // {} | tostring)"' <<<"$agents" 2>/dev/null | head -10
  pass=$((pass+1))
else
  echo "  FAIL controlplane agents — got $(last_status)"; fail=$((fail+1))
fi

echo "== Catalog (metadata) API =="
# Read-only probe: 404 (no spec/instance yet) and 200 both prove the route
# exists for the scope entity; 400/405 means scope isn't a supported entity
# and the spec must move to another entity (adjust 01-catalog-spec.sh).
sample_scope=$(api POST "/data/lake/query" '{"query":"SELECT id FROM core_entities_scope FINAL WHERE _deleted = 0 AND status = '\''active'\'' LIMIT 1 FORMAT JSON"}' | jq -r '.data[0].id // empty')
if [[ -n "$sample_scope" ]]; then
  check "metadata read on scope $sample_scope" "200|404" GET "/metadata/scope/$sample_scope/cost_tracking"
else
  echo "  WARN no active scope found to probe the metadata API"
fi

echo "== K8s scopes to cover =="
api POST "/data/lake/query" '{"query":"SELECT count() AS n FROM core_entities_scope FINAL WHERE _deleted = 0 AND status = '\''active'\'' AND type = '\''web_pool_k8s'\'' FORMAT JSON"}' | jq -r '"  web_pool_k8s active: \(.data[0].n)"'

echo
echo "$pass ok, $fail failing. Next: 01-catalog-spec.sh, 02-config-entries.sh, 03-category.sh, 04-upload-workflows.mjs"
[[ $fail -eq 0 ]]
