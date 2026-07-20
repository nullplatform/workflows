#!/usr/bin/env bash
# Creates the `cost_pricing` catalog specification on the ACCOUNT entity and
# (optionally) writes a calibration instance. This is the record of the unit
# prices the cost tracker bills scopes with — the monthly cluster-cost
# calibration workflow updates BOTH this metadata and the /cost config
# entries (COST_PER_MILLICORE_HOUR / COST_PER_MB_RAM_HOUR).
#
# Usage:
#   NP_API_KEY=… ./05-account-pricing.sh                      # spec only
#   NP_API_KEY=… ./05-account-pricing.sh --account 17 \
#     --price-cpu 0.0000335 --price-mem 0.00000455 \
#     --monthly-cost 2162 --nodes 16 --vcpu 64 --gb 176 \
#     --method "CE AmortizedCost 2026-06 split 7.2:1 vCPU:GB"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

ACCOUNT=""; PRICE_CPU=""; PRICE_MEM=""; MONTHLY=""; NODES=""; VCPU=""; GB=""; METHOD=""
args=("$@"); parse_common_args "$@"; set -- "${args[@]}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) shift 2 ;;
    --account) ACCOUNT="$2"; shift 2 ;;
    --price-cpu) PRICE_CPU="$2"; shift 2 ;;
    --price-mem) PRICE_MEM="$2"; shift 2 ;;
    --monthly-cost) MONTHLY="$2"; shift 2 ;;
    --nodes) NODES="$2"; shift 2 ;;
    --vcpu) VCPU="$2"; shift 2 ;;
    --gb) GB="$2"; shift 2 ;;
    --method) METHOD="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

mint_token
RO='["read"]'
SPEC=$(jq -n --arg nrn "organization=$ORG_ID" --argjson ro "$RO" '{
  name: "Cost pricing",
  description: "Cluster-derived unit prices the cost tracker bills scopes with. Maintained by the monthly cluster-cost calibration — do not edit by hand.",
  nrn: $nrn,
  entity: "account",
  metadata: "cost_pricing",
  schema: {
    type: "object",
    visibleOn: $ro,
    properties: {
      price_per_millicore_hour: { type: "number", title: "USD / mc-hour", visibleOn: $ro },
      price_per_mb_ram_hour:    { type: "number", title: "USD / MB-hour", visibleOn: $ro },
      currency:                 { type: "string", title: "Currency", visibleOn: $ro },
      monthly_compute_cost:     { type: "number", title: "Cluster compute (USD/month, amortized)", visibleOn: $ro },
      nodes:                    { type: "number", title: "Nodes at calibration", visibleOn: $ro },
      vcpu_total:               { type: "number", title: "Fleet vCPU", visibleOn: $ro },
      gb_total:                 { type: "number", title: "Fleet RAM (GB)", visibleOn: $ro },
      method:                   { type: "string", title: "Calibration method", visibleOn: $ro },
      calibrated_at:            { type: "string", title: "Calibrated at", visibleOn: $ro }
    }
  }
}')

out=$(api POST "/metadata/metadata_specification" "$SPEC")
st="$(last_status)"
if [[ "$st" == "200" || "$st" == "201" ]]; then
  echo "spec created: $(jq -r '.id // "ok"' <<<"$out")"
elif [[ "$st" == "400" || "$st" == "409" ]]; then
  sid=$(api GET "/metadata/metadata_specification?nrn=organization=$ORG_ID&limit=100" \
    | jq -r '(.results // .) | map(select(.entity=="account" and .metadata=="cost_pricing")) | .[0].id // empty')
  [[ -n "$sid" ]] || { echo "FAILED: exists but id not found ($st): $out"; exit 1; }
  patch=$(jq -c '{schema: .schema, description: .description}' <<<"$SPEC")
  out=$(api PATCH "/metadata/metadata_specification/$sid" "$patch")
  [[ "$(last_status)" =~ ^2 ]] && echo "spec updated: $sid" || { echo "FAILED patch ($(last_status)): $out"; exit 1; }
else
  echo "FAILED ($st): $out"; exit 1
fi

if [[ -n "$ACCOUNT" && -n "$PRICE_CPU" && -n "$PRICE_MEM" ]]; then
  BODY=$(jq -n --argjson pc "$PRICE_CPU" --argjson pm "$PRICE_MEM" \
    --argjson mc "${MONTHLY:-0}" --argjson nn "${NODES:-0}" \
    --argjson vc "${VCPU:-0}" --argjson gb "${GB:-0}" \
    --arg m "${METHOD:-manual}" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{
      price_per_millicore_hour: $pc, price_per_mb_ram_hour: $pm,
      currency: "USD", monthly_compute_cost: $mc, nodes: $nn,
      vcpu_total: $vc, gb_total: $gb, method: $m, calibrated_at: $at }')
  out=$(api PATCH "/metadata/account/$ACCOUNT/cost_pricing" "$BODY")
  st="$(last_status)"
  if [[ "$st" =~ ^2 ]]; then
    echo "instance upserted on account $ACCOUNT"
  elif [[ "$st" == "404" ]]; then
    out=$(api POST "/metadata/account/$ACCOUNT/cost_pricing" "$BODY")
    [[ "$(last_status)" =~ ^2 ]] && echo "instance created on account $ACCOUNT" || { echo "FAILED create ($(last_status)): $out"; exit 1; }
  else
    echo "FAILED instance ($st): $out"; exit 1
  fi
fi
echo "done."
