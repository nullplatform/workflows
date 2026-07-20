#!/usr/bin/env bash
# Upserts the /cost config entries the workflows read. Re-running rotates
# values in place (the engine's POST /workflows/config is an upsert by
# name+path).
#
# Usage:
#   NP_API_KEY=… ./02-config-entries.sh \
#     [--agent-nrn organization=123] [--agent-cluster my-cluster] \
#     [--cmdline /opt/nullplatform/cost/collect-metrics.sh] \
#     [--matchers 'namespace="{app_name}",pod=~"{scope_slug}.*"'] \
#     [--price-cpu 0.000011] [--price-mem 0.0000048] \
#     [--window 01:00-05:00] [--tz-offset -03:00] [--category finops]
#
# NP_API_KEY doubles as the workflows' credential (stored as the secret).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

AGENT_NRN=""; AGENT_CLUSTER="my-cluster"
CMDLINE="/opt/nullplatform/cost/collect-metrics.sh"
MATCHERS='namespace="{app_name}",pod=~"{scope_slug}.*"'
PRICE_CPU="0.000011"; PRICE_MEM="0.0000048"; CURRENCY="USD"
WINDOW="01:00-05:00"; TZ_OFFSET="-03:00"
CATEGORY="finops"; DEVIATION="50"; LOOKBACK="14"
CPU_MIN="100"; MEM_MIN="128"
# Minimum estimated monthly saving (USD) to open an action item, per
# environment (lowercase) with a "default" fallback — a ticket costs human
# attention, prod tolerates a higher bar than dev.
MIN_SAVINGS='{"default":1,"production":5}'
# Minimum change (% of the configured request) worth acting on, per
# environment — production only moves for big wins.
MIN_CHANGE_PCT='{"default":10,"production":25}'
# Post-change utilization ceilings per environment, plus the BASIS per
# dimension: production CPU sizes against the p95 of 10-minute windows
# (compressible — one-off deployment/startup bursts are brief throttling,
# not capacity), production MEMORY against the observed maximum working set
# (not compressible), everything else against window averages.
TARGET_UTIL='{"default":{"cpu":70,"mem":85,"basis":"avg"},"production":{"cpu":50,"mem":70,"cpu_basis":"p95_10m","mem_basis":"peak10m"}}'
# Platform floors per environment: prod keeps the classic 100mc/128MB;
# non-prod goes lower — dozens of tiny idle scopes pinned at an oversized
# floor are real aggregate money. Verify the platform accepts sub-100mc
# specs before applying non-prod recommendations.
FLOORS='{"default":{"cpu":50,"mem":64},"production":{"cpu":100,"mem":128}}'
# A scope with a conclusive scanner verdict is not re-analyzed for this many
# days (usage profiles don't change weekly; each full analysis costs an AI
# run). Live items are validated from tracker data on every run regardless.
RESCAN_DAYS='15'
# Runaway brake for the Q&A responder: max AI replies per action item.
QA_MAX_REPLIES='10'
# Replica floor per environment (reliability note in the AI analysis —
# right-sizing never changes replica counts itself).
MIN_REPLICAS='{"default":1,"production":2}'
# K8s namespace the scopes live in (used to build the AI's PromQL matchers).
K8S_NAMESPACE='default'
# Monthly cluster-cost calibration (wf6): agent-side costing command, the
# CPU:RAM split ratio, and the account whose cost_pricing metadata records
# each calibration.
COSTING_CMDLINE='/opt/nullplatform/cost/cluster-costing.sh'
CPU_RAM_RATIO='7.2'
ACCOUNT_ID=''
# Progressive deploy (wf5): traffic steps, soak between steps, degradation
# thresholds (error-rate absolute increase in pct points, response-time
# ratio vs baseline), and how long a gated/pending deployment is polled.
TRAFFIC_STEPS='10,50,100'; STEP_WAIT='120'
MAX_ERR_INCREASE='1'; MAX_RT_RATIO='1.5'; PENDING_TIMEOUT='30'

args=("$@")
parse_common_args "$@"
set -- "${args[@]}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) shift 2 ;;
    --agent-nrn) AGENT_NRN="$2"; shift 2 ;;
    --agent-cluster) AGENT_CLUSTER="$2"; shift 2 ;;
    --cmdline) CMDLINE="$2"; shift 2 ;;
    --matchers) MATCHERS="$2"; shift 2 ;;
    --costing-cmdline) COSTING_CMDLINE="$2"; shift 2 ;;
    --account-id) ACCOUNT_ID="$2"; shift 2 ;;
    --price-cpu) PRICE_CPU="$2"; shift 2 ;;
    --price-mem) PRICE_MEM="$2"; shift 2 ;;
    --currency) CURRENCY="$2"; shift 2 ;;
    --window) WINDOW="$2"; shift 2 ;;
    --tz-offset) TZ_OFFSET="$2"; shift 2 ;;
    --category) CATEGORY="$2"; shift 2 ;;
    --deviation) DEVIATION="$2"; shift 2 ;;
    --lookback) LOOKBACK="$2"; shift 2 ;;
    --min-savings) MIN_SAVINGS="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

mint_token
[[ -n "$AGENT_NRN" ]] || AGENT_NRN="organization=$ORG_ID"
WINDOW_START="${WINDOW%-*}"; WINDOW_END="${WINDOW#*-}"

put() { # name value secret(true|false)
  local body
  body=$(jq -n --arg name "$1" --arg value "$2" --argjson secret "$3" \
    '{name: $name, value: $value, secret: $secret, path: "/cost"}')
  local out
  out=$(api POST "/workflows/config" "$body")
  if [[ "$(last_status)" =~ ^2 ]]; then
    echo "  $1 → $(jq -r '.mode // "upserted"' <<<"$out")"
  else
    echo "  $1 FAILED ($(last_status)): $out"; exit 1
  fi
}

echo "Upserting config entries on /cost:"
put NP_API_KEY                 "$NP_API_KEY"    true
put NP_ORGANIZATION_ID         "$ORG_ID"        false
put COST_PER_MILLICORE_HOUR    "$PRICE_CPU"     false
put COST_PER_MB_RAM_HOUR       "$PRICE_MEM"     false
put COST_CURRENCY              "$CURRENCY"      false
put COST_AGENT_CMDLINE         "$CMDLINE"       false
put COST_AGENT_NRN             "$AGENT_NRN"     false
put COST_AGENT_CLUSTER         "$AGENT_CLUSTER" false
put COST_POD_MATCHERS_TEMPLATE "$MATCHERS"      false
put RIGHTSIZING_DEVIATION_PCT  "$DEVIATION"     false
put RIGHTSIZING_LOOKBACK_DAYS  "$LOOKBACK"      false
put RIGHTSIZING_RESCAN_DAYS    "$RESCAN_DAYS"   false
put RIGHTSIZING_QA_MAX_REPLIES "$QA_MAX_REPLIES" false
put RIGHTSIZING_CATEGORY_SLUG  "$CATEGORY"      false
put RIGHTSIZING_MIN_SAVINGS_BY_ENV "$MIN_SAVINGS" false
put RIGHTSIZING_MIN_CHANGE_PCT_BY_ENV "$MIN_CHANGE_PCT" false
put RIGHTSIZING_TARGET_UTIL_BY_ENV "$TARGET_UTIL" false
put RIGHTSIZING_FLOORS_BY_ENV "$FLOORS" false
put RIGHTSIZING_MIN_REPLICAS_BY_ENV "$MIN_REPLICAS" false
put COST_K8S_NAMESPACE "$K8S_NAMESPACE" false
put CLUSTER_COSTING_CMDLINE "$COSTING_CMDLINE" false
put CLUSTER_COST_CPU_RAM_RATIO "$CPU_RAM_RATIO" false
[[ -n "$ACCOUNT_ID" ]] && put COST_ACCOUNT_ID "$ACCOUNT_ID" false
put CPU_MIN_MILLICORES         "$CPU_MIN"       false
put MEM_MIN_MB                 "$MEM_MIN"       false
put DEPLOY_WINDOW_START        "$WINDOW_START"  false
put DEPLOY_WINDOW_END          "$WINDOW_END"    false
put DEPLOY_WINDOW_TZ_OFFSET    "$TZ_OFFSET"     false
put DEPLOY_TRAFFIC_STEPS       "$TRAFFIC_STEPS" false
put DEPLOY_STEP_WAIT_SECONDS   "$STEP_WAIT"     false
put DEPLOY_MAX_ERROR_RATE_INCREASE "$MAX_ERR_INCREASE" false
put DEPLOY_MAX_RESPONSE_TIME_RATIO "$MAX_RT_RATIO" false
put DEPLOY_PENDING_TIMEOUT_MINUTES "$PENDING_TIMEOUT" false
echo "done."
