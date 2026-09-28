#!/usr/bin/env bash
# Metadata-specification helpers shared by the deploy-analysis setup scripts.
# Source after cost/setup/lib.sh (needs api, last_status).

# upsert_spec <nrn> <entity> <metadata> <schema-file> [name-suffix]
# POSTs the spec; when it already exists at that exact NRN, PATCHes its schema.
upsert_spec() {
  local nrn="$1" entity="$2" metadata="$3" schema_file="$4" suffix="${5:-}"
  local name description schema
  name=$(jq -r '.name' "$schema_file")${suffix:+ ${suffix}}
  description=$(jq -r '.description' "$schema_file")${suffix:+ (staging environment)}
  schema=$(jq -c '.schema' "$schema_file")

  local body
  body=$(jq -n --arg nrn "$nrn" --arg e "$entity" --arg m "$metadata" \
    --arg n "$name" --arg d "$description" --argjson s "$schema" \
    '{name:$n, description:$d, nrn:$nrn, entity:$e, metadata:$m, schema:$s}')

  local out st
  out=$(api POST "/metadata/metadata_specification" "$body")
  st="$(last_status)"
  if [[ "$st" =~ ^2 ]]; then
    echo "  created $entity/$metadata @ $nrn"
  else
    local sid
    sid=$(api GET "/metadata/metadata_specification?nrn=$nrn&limit=200" \
      | jq -r --arg e "$entity" --arg m "$metadata" --arg nrn "$nrn" \
        '(.results // .) | map(select(.entity==$e and .metadata==$m and .nrn==$nrn)) | .[0].id // empty')
    [[ -n "$sid" ]] || { echo "FAILED $entity/$metadata @ $nrn ($st): $out" >&2; exit 1; }
    out=$(api PATCH "/metadata/metadata_specification/$sid" "$(jq -c '{schema: .schema}' <<<"$body")")
    [[ "$(last_status)" =~ ^2 ]] && echo "  updated $entity/$metadata @ $nrn" \
      || { echo "FAILED patch $sid ($(last_status)): $out" >&2; exit 1; }
  fi
}
