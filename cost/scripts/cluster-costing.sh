#!/usr/bin/env bash
#
# cluster-costing.sh — monthly unit-price calibration for the cost tracker.
#
# Runs ON THE AGENT HOST (dispatched via agent_command). Reads:
#   - AWS Cost Explorer: amortized EC2-Compute cost of a month (Savings
#     Plans/RIs included — UnblendedCost lies when SPs cover the fleet).
#   - Prometheus: fleet size (allocatable vCPU/RAM, node count) averaged
#     over the available window.
# Splits the monthly cost between CPU and RAM with a configurable ratio
# (default 7.2:1 per vCPU vs per GB — AWS's approximate on-demand ratio)
# and prints ONE JSON document with the derived unit prices.
#
# Credentials: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (+ optional
# AWS_SESSION_TOKEN) must be present in the environment — on the
# controlplane-agent they arrive via --command-executor-env. Required IAM:
# ce:GetCostAndUsage (read-only). Needs curl >= 7.75 (--aws-sigv4) and jq.
#
# Usage:
#   cluster-costing.sh [--prom URL] [--region us-east-1] [--ratio 7.2]
#                      [--month YYYY-MM]        # default: last full month
#                      [--monthly-cost N]       # skip CE, use this number
#
# Output:
#   {"month":"2026-06","monthly_compute_cost":2162.4,"nodes":16,
#    "vcpu_total":64.2,"gb_total":176.1,
#    "price_per_millicore_hour":0.0000335,"price_per_mb_ram_hour":0.00000455,
#    "method":"CE AmortizedCost EC2-Compute / prometheus fleet, ratio 7.2"}
#
# Exit codes: 0 ok; 2 usage; 3 CE/Prometheus unreachable or empty.

set -euo pipefail

PROM_URL="${PROM_URL:-http://localhost:9090}"
REGION="us-east-1"; RATIO="7.2"; MONTH=""; COST_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prom)         PROM_URL="$2"; shift 2;;
    --region)       REGION="$2"; shift 2;;
    --ratio)        RATIO="$2"; shift 2;;
    --month)        MONTH="$2"; shift 2;;
    --monthly-cost) COST_OVERRIDE="$2"; shift 2;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2;;
    *) echo "unknown argument: $1" >&2; exit 2;;
  esac
done

fail() { echo "{\"error\":\"$1\"}"; exit 3; }

# Default month: the last FULL month. Pure-shell month arithmetic — the
# agent host is BusyBox (no GNU `date -d`, no BSD `date -v`).
if [[ -z "$MONTH" ]]; then
  Y=$(date -u +%Y); M=$((10#$(date -u +%m) - 1))
  if [ "$M" -eq 0 ]; then M=12; Y=$((Y - 1)); fi
  MONTH=$(printf '%04d-%02d' "$Y" "$M")
fi
START="$MONTH-01"
NY=${MONTH%-*}; NM=$((10#${MONTH#*-} + 1))
if [ "$NM" -eq 13 ]; then NM=1; NY=$((NY + 1)); fi
END=$(printf '%04d-%02d-01' "$NY" "$NM")

# ── Monthly compute cost (Cost Explorer, amortized) ─────────────────────
if [[ -n "$COST_OVERRIDE" ]]; then
  COST="$COST_OVERRIDE"
  METHOD="manual override"
else
  [[ -n "${AWS_ACCESS_KEY_ID:-}" && -n "${AWS_SECRET_ACCESS_KEY:-}" ]] \
    || fail "AWS credentials missing in environment (agent --command-executor-env)"
  CE_BODY=$(jq -cn --arg s "$START" --arg e "$END" '{
    TimePeriod: {Start: $s, End: $e},
    Granularity: "MONTHLY",
    Metrics: ["AmortizedCost"],
    Filter: {Dimensions: {Key: "SERVICE", Values: ["Amazon Elastic Compute Cloud - Compute"]}}
  }')
  CE=$(curl -fsS --max-time 60 \
    --aws-sigv4 "aws:amz:${REGION}:ce" \
    --user "${AWS_ACCESS_KEY_ID}:${AWS_SECRET_ACCESS_KEY}" \
    ${AWS_SESSION_TOKEN:+-H "x-amz-security-token: ${AWS_SESSION_TOKEN}"} \
    -H 'Content-Type: application/x-amz-json-1.1' \
    -H 'X-Amz-Target: AWSInsightsIndexService.GetCostAndUsage' \
    -d "$CE_BODY" "https://ce.${REGION}.amazonaws.com/") \
    || fail "Cost Explorer unreachable or request rejected"
  COST=$(jq -r '.ResultsByTime[0].Total.AmortizedCost.Amount // empty' <<<"$CE")
  [[ -n "$COST" ]] || fail "Cost Explorer returned no amortized cost for $MONTH"
  METHOD="CE AmortizedCost EC2-Compute"
fi

# ── Fleet size (Prometheus, averaged over the available window) ─────────
qavg() {
  local out
  out=$(curl -fsS --max-time 60 "$PROM_URL/api/v1/query" \
    --data-urlencode "query=avg_over_time((${1})[30d:1h])") \
    || fail "prometheus unreachable at $PROM_URL"
  jq -r '.data.result[0].value[1] // "0"' <<<"$out"
}
VCPU=$(qavg 'sum(kube_node_status_allocatable{resource="cpu"})')
GB=$(qavg 'sum(kube_node_status_allocatable{resource="memory"}) / 1073741824')
NODES=$(qavg 'count(kube_node_info)')
awk "BEGIN{exit !($VCPU > 0 && $GB > 0)}" || fail "prometheus returned an empty fleet (vcpu=$VCPU gb=$GB)"

# ── Split + unit prices ──────────────────────────────────────────────────
# total = vcpu × p_vcpu + gb × (p_vcpu / ratio)  →  p_vcpu = total / (vcpu + gb/ratio)
jq -cn --argjson cost "$COST" --argjson vcpu "$VCPU" --argjson gb "$GB" \
       --argjson nodes "$NODES" --argjson ratio "$RATIO" \
       --arg month "$MONTH" --arg method "$METHOD" '
  def r2: . * 100 | round / 100;
  ($cost / ($vcpu + $gb / $ratio)) as $pv |
  ($pv / $ratio) as $pg |
  { month: $month,
    monthly_compute_cost: ($cost | r2),
    nodes: ($nodes | r2),
    vcpu_total: ($vcpu | r2),
    gb_total: ($gb | r2),
    price_per_millicore_hour: (($pv / 730 / 1000) * 10000000 | round / 10000000),
    price_per_mb_ram_hour:    (($pg / 730 / 1024) * 100000000 | round / 100000000),
    method: ($method + " / prometheus fleet, ratio " + ($ratio|tostring)) }'
