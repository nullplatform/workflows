#!/usr/bin/env bash
# Declares the `dependencies` metadata specification for the ASSET entity.
#
# Hidden from the UI: root `visibleOn: []` keeps it off every asset form and
# card. It is written exclusively by the lib-inventory workflows and only needs
# to be API/lake readable.
#
# Idempotent: creates the spec, or PATCHes the schema in place if it exists.
# Never touches any instance data.
#
# Usage:
#   ./01-metadata-spec.sh --env-file ../../../.env.<org>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../cost/setup/lib.sh
source "$SCRIPT_DIR/../../cost/setup/lib.sh"

parse_common_args "$@"
mint_token

SPEC=$(jq -n --arg nrn "organization=$ORG_ID" '{
  name: "Asset dependencies",
  description: "Libraries in use by this asset, extracted from the application repository at the commit its build was made from. Maintained by the lib-inventory workflows — do not edit by hand.",
  nrn: $nrn,
  entity: "asset",
  metadata: "dependencies",
  schema: {
    type: "object",
    visibleOn: [],
    properties: {
      status: { type: "string",
        enum: ["ok","no_manifest","unresolved","repo_unreachable","repo_missing","lang_unsupported"] },
      status_detail:    { type: ["string","null"] },
      primary_language: { type: ["string","null"] },
      languages:        { type: "array", items: { type: "string" } },
      repository_url:   { type: ["string","null"] },
      repository_path:  { type: ["string","null"] },
      commit:           { type: ["string","null"] },
      match_level:      { type: ["string","null"] },
      manifests: { type: "array", items: { type: "object", properties: {
        path: {type:"string"}, language: {type:"string"} } } },
      dependencies: { type: "array", items: { type: "object", properties: {
        name:      {type:"string"},
        version:   {type:"string"},
        direct:    {type:"boolean"},
        internal:  {type:"boolean"},
        local:     {type:"boolean"},
        ecosystem: {type:"string"} } } },
      total_count:    { type: "number" },
      direct_count:   { type: "number" },
      internal_count: { type: "number" },
      local_count:    { type: "number" },
      transitive_external_dropped: { type: "number" },
      scanned_at:      { type: "string" },
      scanner_version: { type: "string" }
    }
  }
}')

echo "Declaring asset/dependencies metadata specification on organization=$ORG_ID:"
out=$(api POST "/metadata/metadata_specification" "$SPEC")
st="$(last_status)"
if [[ "$st" =~ ^2 ]]; then
  echo "  created: $(jq -r '.id // "ok"' <<<"$out")"
elif [[ "$st" == "400" || "$st" == "409" ]]; then
  sid=$(api GET "/metadata/metadata_specification?nrn=organization=$ORG_ID&limit=200" \
    | jq -r '(.results // .) | map(select(.entity=="asset" and .metadata=="dependencies")) | .[0].id // empty')
  [[ -n "$sid" ]] || { echo "FAILED: exists but could not resolve spec id ($st): $out"; exit 1; }
  patch=$(jq -c '{schema: .schema, description: .description}' <<<"$SPEC")
  out=$(api PATCH "/metadata/metadata_specification/$sid" "$patch")
  [[ "$(last_status)" =~ ^2 ]] && echo "  updated spec $sid" \
    || { echo "FAILED patch ($(last_status)): $out"; exit 1; }
else
  echo "FAILED ($st): $out"; exit 1
fi
