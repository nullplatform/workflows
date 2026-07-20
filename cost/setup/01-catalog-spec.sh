#!/usr/bin/env bash
# Creates the `cost_tracking` catalog specification on the scope entity.
# Idempotent: an "already exists" answer is reported and treated as success.
#
# Usage: NP_API_KEY=… ./01-catalog-spec.sh   (or --env-file <file>)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
parse_common_args "$@"
mint_token

[[ -n "$ORG_ID" ]] || { echo "ERROR: could not resolve organization_id from the token"; exit 1; }

# Visibility: the cost data is maintained by the cost-tracker workflow, NOT
# entered by hand. Root visibleOn ["read"] keeps the whole "Cost Tracking"
# section off the scope create/update forms (no empty section header); every
# field shows on the scope DETAIL, and only two survive on LIST cards:
# provisioning_status as a colored header chip + the 7-day cost in the body
# (anything more turns the cards into a wall of numbers). The uiSchema
# chip/icon/mapping options follow the platform's metadata card conventions.
# The full instance JSON still lands in the lake; the Insights dashboards
# un-nest daily_series from core_entities_metadata.data.
RO='["read"]'
ROL='["read","list"]'
SPEC=$(jq -n --arg nrn "organization=$ORG_ID" --argjson ro "$RO" --argjson rol "$ROL" '{
  name: "Cost tracking",
  description: "Daily compute cost + usage-vs-request per scope (millicores + RAM from cluster Prometheus). Maintained by the cost-tracker workflow — do not edit by hand.",
  nrn: $nrn,
  entity: "scope",
  metadata: "cost_tracking",
  schema: {
    type: "object",
    visibleOn: $ro,
    properties: {
      provisioning_status: { type: "string", title: "Provisioning", description: "over_provisioned | optimal | under_provisioned | unknown", enum: ["over_provisioned","optimal","under_provisioned","unknown"], visibleOn: $rol },
      rightsizing_item_id: { type: ["string","null"], title: "Right-sizing item", description: "Live right-sizing action item id (owned by the scanner; null when none)", visibleOn: $ro },
      cost_7d:   { type: "number", title: "Cost (7d)", description: "Rolling 7-day cost (USD, chargeback basis)", visibleOn: $rol },
      cost_today: { type: "number", title: "Cost today", description: "Chargeback cost of the last computed day: max(requested, used) — reservations bind cluster nodes (USD)", visibleOn: $ro },
      usage_cost_today: { type: "number", title: "Used today", description: "What the scope actually consumed (USD) — the gap vs cost_today is reclaimable", visibleOn: $ro },
      waste_today: { type: "number", title: "Waste today", description: "cost_today - usage_cost_today: reserved but unused (USD)", visibleOn: $ro },
      pods_min_today: { type: "number", title: "Pods (min)", description: "Fewest concurrent pods observed during the day", visibleOn: $ro },
      pods_max_today: { type: "number", title: "Pods (max)", description: "Most concurrent pods observed during the day", visibleOn: $ro },
      pods_avg_today: { type: "number", title: "Pods (avg)", description: "Average concurrent pods during the day", visibleOn: $ro },
      cpu_peak10m_mc_today: { type: "number", title: "CPU peak 10m (mc)", description: "Highest 10-minute average fleet CPU of the day (millicores) — peaks that hourly averages hide", visibleOn: $ro },
      mem_peak_mb_today: { type: "number", title: "Memory peak (MB)", description: "Highest fleet memory working set of the day (MB, 10m resolution)", visibleOn: $ro },
      last_scan_at: { type: ["string","null"], title: "Last right-sizing scan", description: "When the right-sizing scanner last reached a verdict for this scope (ISO; owned by the scanner — drives the rescan window)", visibleOn: $ro },
      last_scan_status: { type: ["string","null"], title: "Last scan verdict", description: "Outcome of the last scanner verdict (created | updated | unchanged | active_valid | closed_stale | not_candidate | not_genuine | below_min_savings)", visibleOn: $ro },
      last_scan_note: { type: ["string","null"], title: "Last scan note", description: "One-line human-readable reason behind the last scanner verdict (why an item was or was not opened)", visibleOn: $ro },
      last_scan_savings_usd_month: { type: ["number","null"], title: "Last scan saving", description: "Monthly saving the last scan saw for this scope (USD; item or portfolio estimate)", visibleOn: $ro },
      cost_30d:  { type: "number", title: "Cost (30d)", description: "Rolling 30-day cost (USD)", visibleOn: $ro },
      cost_365d: { type: "number", title: "Cost (365d)", description: "Rolling 365-day cost (USD)", visibleOn: $ro },
      avg_daily_cost_30d: { type: "number", title: "Avg daily cost (30d)", description: "Average daily cost over the last 30 days (USD)", visibleOn: $ro },
      cost_breakdown: {
        type: "object", title: "Cost breakdown", visibleOn: $ro,
        properties: {
          cpu_pct: { type: "number" },
          mem_pct: { type: "number" }
        }
      },
      cpu_request_mc: { type: "number", title: "CPU requested (mc)", description: "Avg requested CPU (millicores) on the last computed day", visibleOn: $ro },
      cpu_avg_usage_mc: { type: "number", title: "CPU used (mc)", description: "Avg used CPU (millicores) on the last computed day", visibleOn: $ro },
      cpu_utilization_pct: { type: "number", title: "CPU utilization (%)", description: "CPU used/requested (%) — <50 over-provisioned, >90 under-provisioned", visibleOn: $ro },
      mem_request_mb: { type: "number", title: "Memory requested (MB)", description: "Avg requested memory (MB) on the last computed day", visibleOn: $ro },
      mem_avg_usage_mb: { type: "number", title: "Memory used (MB)", description: "Avg used memory (MB) on the last computed day", visibleOn: $ro },
      mem_utilization_pct: { type: "number", title: "Memory utilization (%)", description: "Memory used/requested (%) — <50 over-provisioned, >90 under-provisioned", visibleOn: $ro },
      currency: { type: "string", title: "Currency", visibleOn: $ro },
      last_computed_at: { type: "string", title: "Last computed at", visibleOn: $ro },
      daily_series: {
        type: "array", visibleOn: $ro,
        description: "Last 365 daily points {d, usage, requested, cost} — feeds the lake/dashboards (over/under-provisioning trends)",
        items: {
          type: "object",
          properties: {
            d: { type: "string" },
            cpu_mc_h: { type: "number" },
            mem_mb_h: { type: "number" },
            cpu_req_mc: { type: "number" },
            mem_req_mb: { type: "number" },
            cpu_req_mc_h: { type: "number" },
            mem_req_mb_h: { type: "number" },
            pods_min: { type: "number" },
            pods_max: { type: "number" },
            pods_avg: { type: "number" },
            cpu_mc_p95: { type: "number" },
            cpu_mc_pk10m: { type: "number" },
            mem_mb_pk: { type: "number" },
            cpu_mc_valley: { type: "number" },
            peak_hour: { type: "number" },
            cost: { type: "number" },
            use_cost: { type: "number" }
          }
        }
      }
    },
    uiSchema: {
      type: "VerticalLayout",
      elements: [
        {
          type: "Control",
          scope: "#/properties/provisioning_status",
          options: {
            format: "chip",
            mapping: {
              over_provisioned: { label: "Over-provisioned", color: "warning", variant: "outlined", icon: "mdi:arrow-collapse-down", tooltip: "Requested resources far exceed real usage — right-sizing opportunity" },
              under_provisioned: { label: "Under-provisioned", color: "error", variant: "outlined", icon: "mdi:alert-outline", tooltip: "Usage above 90% of requests — risk of CPU throttling or OOM kills" },
              optimal: { label: "Right-sized", color: "success", variant: "outlined", icon: "mdi:check-circle-outline", tooltip: "Usage sits in the healthy band of the requested resources" },
              unknown: { label: "No cost data", color: "default", variant: "outlined", icon: "mdi:help-circle-outline", tooltip: "Not enough metrics to assess provisioning" }
            }
          }
        },
        {
          type: "Control",
          scope: "#/properties/cost_7d",
          options: { icon: "mdi:cash-multiple" }
        }
      ]
    }
  }
}')

# Create, or update in place if it already exists (spec id via the
# entity+metadata listing). Specs are addressable by id for PATCH.
out=$(api POST "/metadata/metadata_specification" "$SPEC")
st="$(last_status)"
if [[ "$st" == "200" || "$st" == "201" ]]; then
  echo "created: $(jq -r '.id // "ok"' <<<"$out")"
elif [[ "$st" == "400" || "$st" == "409" ]]; then
  # Already exists — find its id and PATCH the schema in place.
  sid=$(api GET "/metadata/metadata_specification?nrn=organization=$ORG_ID&limit=100" \
    | jq -r '(.results // .) | map(select(.entity=="scope" and .metadata=="cost_tracking")) | .[0].id // empty')
  if [[ -z "$sid" ]]; then echo "FAILED: exists but could not resolve spec id ($st): $out"; exit 1; fi
  patch=$(jq -c '{schema: .schema, description: .description}' <<<"$SPEC")
  out=$(api PATCH "/metadata/metadata_specification/$sid" "$patch")
  [[ "$(last_status)" =~ ^2 ]] && echo "updated spec $sid" || { echo "FAILED patch ($(last_status)): $out"; exit 1; }
else
  echo "FAILED ($st): $out"; exit 1
fi
