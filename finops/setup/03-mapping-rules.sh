#!/usr/bin/env bash
# Upserts cost_mapping_rule rows from a JSON array (e.g. setup/rules.<org>.json).
# Needs NP_API_KEY (org API key with catalog entities write) or NP_TOKEN.
#   NP_API_KEY=… ./03-mapping-rules.sh setup/rules.nullplatform.json
set -euo pipefail
API="https://api.nullplatform.com"
FILE="${1:?usage: 03-mapping-rules.sh <rules.json>}"
if [[ -z "${NP_TOKEN:-}" ]]; then
  [[ -n "${NP_API_KEY:-}" ]] || { echo "ERROR: set NP_TOKEN or NP_API_KEY"; exit 1; }
  NP_TOKEN=$(curl -s -X POST "$API/token" -H 'Content-Type: application/json' -d "{\"apikey\":\"$NP_API_KEY\"}" | jq -r '.access_token // empty')
  [[ -n "$NP_TOKEN" ]] || { echo "ERROR: could not mint token"; exit 1; }
fi
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -c '.[]' "$FILE" | while read -r rule; do
  id=$(jq -r '.id' <<<"$rule")
  body=$(jq --arg now "$now" '. + {updated_at: $now} | .created_at //= $now' <<<"$rule")
  st=$(curl -s -o /tmp/np_rule_out -w '%{http_code}' -X PATCH "$API/catalog/instances/cost_mapping_rule/$id?upsert=true" \
    -H "Authorization: Bearer $NP_TOKEN" -H 'Content-Type: application/json' -d "$body")
  if [[ "$st" =~ ^2 ]]; then echo "upserted $id"; else echo "FAILED $id ($st): $(head -c 300 /tmp/np_rule_out)"; exit 1; fi
done
