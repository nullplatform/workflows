#!/usr/bin/env bash
# Declares the deploy-analysis metadata specifications, SCOPED to the
# namespaces the suite will analyze (never organization-wide: application
# and namespace summaries are developer-visible, so entities outside the
# analyzed namespaces must not grow empty metadata blocks).
#
# Per namespace NRN this creates five specs:
#   deployment  / change                  — per-deployment analysis (risk, PRs, participants)
#   application / deploy_summaries        — weekly roll-up, PROD deploys
#   application / deploy_summaries_stage  — weekly roll-up, STAGE deploys
#   namespace   / deploy_summaries        — weekly roll-up, PROD deploys
#   namespace   / deploy_summaries_stage  — weekly roll-up, STAGE deploys
#
# Idempotent: existing (entity, metadata, nrn) specs get their schema PATCHed.
#
# Usage:
#   ./01-metadata-specs.sh [--env-file <file>] \
#     "organization=<org>:account=<acc>:namespace=<ns1>" \
#     "organization=<org>:account=<acc>:namespace=<ns2>" ...

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../cost/setup/lib.sh
source "$SCRIPT_DIR/../../cost/setup/lib.sh"

NRNS=()
ARGS=("$@")
i=0
while [[ $i -lt ${#ARGS[@]} ]]; do
  case "${ARGS[$i]}" in
    --env-file) set -a; source "${ARGS[$((i+1))]}"; set +a; i=$((i+2)) ;;
    organization=*) NRNS+=("${ARGS[$i]}"); i=$((i+1)) ;;
    *) i=$((i+1)) ;;
  esac
done
[[ ${#NRNS[@]} -gt 0 ]] || { echo "usage: $0 [--env-file f] <namespace-nrn> [...]" >&2; exit 1; }

mint_token

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

for nrn in "${NRNS[@]}"; do
  echo "namespace $nrn"
  upsert_spec "$nrn" deployment  change                 "$SCRIPT_DIR/schemas/deployment-change.json"
  upsert_spec "$nrn" application deploy_summaries       "$SCRIPT_DIR/schemas/application-deploy-summaries.json"
  upsert_spec "$nrn" application deploy_summaries_stage "$SCRIPT_DIR/schemas/application-deploy-summaries.json" "(staging)"
  upsert_spec "$nrn" namespace   deploy_summaries       "$SCRIPT_DIR/schemas/namespace-deploy-summaries.json"
  upsert_spec "$nrn" namespace   deploy_summaries_stage "$SCRIPT_DIR/schemas/namespace-deploy-summaries.json" "(staging)"
done
echo "done."
