#!/usr/bin/env bash
# Creates the `lambda_runtimes` catalog specification on the ORGANIZATION
# entity, then seeds an empty instance if none exists yet. The instance is
# maintained by the wf-r1 catalog-sync workflow — this script only creates
# the shell.
#
# Idempotent: an "already exists" spec answer is patched in place; an
# existing instance is left untouched.
#
# Usage: NP_API_KEY=… ./01-catalog-spec.sh   (or --env-file <file>)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../cost/setup/lib.sh
source "$SCRIPT_DIR/../../cost/setup/lib.sh"
parse_common_args "$@"
mint_token

[[ -n "$ORG_ID" ]] || { echo "ERROR: could not resolve organization_id from the token"; exit 1; }

# Hidden from the UI: root visibleOn [] keeps the whole catalog off every
# scope/org form and card. It is scraped weekly by the catalog-sync
# workflow, not entered by hand, and only needs to be API/lake-readable.
SPEC=$(jq -n --arg nrn "organization=$ORG_ID" '{
  name: "Lambda runtimes",
  description: "AWS Lambda runtime support/deprecation catalog scraped weekly from AWS docs. Maintained by the runtime-lifecycle catalog-sync workflow — do not edit by hand.",
  nrn: $nrn,
  entity: "organization",
  metadata: "lambda_runtimes",
  schema: {
    type: "object",
    visibleOn: [],
    properties: {
      runtimes: { type: "array", items: { type: "object", properties: {
        id: {type:"string"}, language: {type:"string"}, version: {type:"string"},
        status: {type:"string",enum:["supported","deprecated"]},
        deprecation_date: {type:["string","null"]},
        block_function_create: {type:["string","null"]},
        block_function_update: {type:["string","null"]},
        os: {type:["string","null"]} } } },
      source_urls: { type: "array", items: {type:"string"} },
      scraped_at: { type: "string" },
      supported_count: { type: "number" },
      deprecated_count: { type: "number" }
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
    | jq -r '(.results // .) | map(select(.entity=="organization" and .metadata=="lambda_runtimes")) | .[0].id // empty')
  if [[ -z "$sid" ]]; then echo "FAILED: exists but could not resolve spec id ($st): $out"; exit 1; fi
  patch=$(jq -c '{schema: .schema, description: .description}' <<<"$SPEC")
  out=$(api PATCH "/metadata/metadata_specification/$sid" "$patch")
  [[ "$(last_status)" =~ ^2 ]] && echo "updated spec $sid" || { echo "FAILED patch ($(last_status)): $out"; exit 1; }
else
  echo "FAILED ($st): $out"; exit 1
fi

# Seed the instance if it doesn't exist yet. Never overwrite a live catalog
# here — that's the catalog-sync workflow's job.
out=$(api GET "/metadata/organization/$ORG_ID/lambda_runtimes")
st="$(last_status)"
if [[ "$st" == "200" ]]; then
  echo "instance already exists (scraped_at: $(jq -r '.scraped_at // "unknown"' <<<"$out"))"
elif [[ "$st" == "404" ]]; then
  seed='{"runtimes":[],"source_urls":[],"scraped_at":"1970-01-01T00:00:00Z","supported_count":0,"deprecated_count":0}'
  out=$(api POST "/metadata/organization/$ORG_ID/lambda_runtimes" "$seed")
  [[ "$(last_status)" =~ ^2 ]] && echo "instance seeded" || { echo "FAILED seed ($(last_status)): $out"; exit 1; }
else
  echo "FAILED instance GET ($st): $out"; exit 1
fi

echo "done."
