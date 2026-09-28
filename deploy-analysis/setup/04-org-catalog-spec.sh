#!/usr/bin/env bash
# Puts the weekly deploy summaries in the namespace dashboard's Catalog panel.
#
# The panel reads the namespace Global Specification only (only=global), and
# metadata-api builds that view from the global spec plus the regular specs at
# the SAME NRN. The per-namespace specs from 01-metadata-specs.sh therefore
# never reach the panel: this script writes at the ORGANIZATION NRN instead.
# Trade-off: an org-level spec shows the "Deploy summaries" category in every
# namespace of the org, not only the analyzed ones (01's scoping still governs
# where the workflow writes).
#
# 1. Upserts the regular namespace/deploy_summaries spec at the org NRN, from
#    schemas/namespace-deploy-summaries.json (the same schema 01 uses).
# 2. PATCHes the global spec with {schema: {required, uiSchema}} only — the one
#    shape metadata-api accepts for a global spec — replacing the category from
#    schemas/namespace-deploy-summaries.catalog-category.json and keeping every
#    other category and the current `required`.
#
# Refuses to run when the org has no namespace global spec: the first regular
# POST would create one, which is an organization-wide decision.
#
# Usage:
#   ./04-org-catalog-spec.sh [--env-file <file>] [--dry-run] "organization=<org>"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../cost/setup/lib.sh
source "$SCRIPT_DIR/../../cost/setup/lib.sh"
# shellcheck source=./specs.sh
source "$SCRIPT_DIR/specs.sh"

NRN="" DRY_RUN=""
ARGS=("$@")
i=0
while [[ $i -lt ${#ARGS[@]} ]]; do
  case "${ARGS[$i]}" in
    --env-file) set -a; source "${ARGS[$((i+1))]}"; set +a; i=$((i+2)) ;;
    --dry-run) DRY_RUN=1; i=$((i+1)) ;;
    organization=*) NRN="${ARGS[$i]}"; i=$((i+1)) ;;
    *) i=$((i+1)) ;;
  esac
done
[[ "$NRN" =~ ^organization=[0-9]+$ ]] || { echo "usage: $0 [--env-file f] [--dry-run] organization=<org>" >&2; exit 1; }

SCHEMA_FILE="$SCRIPT_DIR/schemas/namespace-deploy-summaries.json"
CATEGORY_FILE="$SCRIPT_DIR/schemas/namespace-deploy-summaries.catalog-category.json"

mint_token

global_spec() {
  api GET "/metadata/metadata_specification?nrn=$NRN&entity=namespace&only=global&limit=200" \
    | jq -c --arg nrn "$NRN" '(.results // .) | map(select(.entity=="namespace" and .nrn==$nrn and .metadata==null)) | .[0] // empty'
}

global=$(global_spec)
[[ -n "$global" ]] || { echo "FAILED: no namespace global spec at $NRN ($(last_status)); create it deliberately first" >&2; exit 1; }

global_patch=$(jq -c --slurpfile c "$CATEGORY_FILE" '
  $c[0] as $category
  | .schema
  | {
      required: (.required // []),
      uiSchema: (
        (.uiSchema // {type: "Categorization", elements: []})
        | .elements = (
            if any(.elements[]?; .label == $category.label)
            then [.elements[] | if .label == $category.label then $category else . end]
            else (.elements // []) + [$category]
            end
          )
      )
    }' <<<"$global")

if [[ -n "$DRY_RUN" ]]; then
  current=$(jq -c '.schema.definitions.deploy_summaries // {}' <<<"$global")
  echo "== namespace/deploy_summaries @ $NRN (schema)"
  diff <(jq -S . <<<"$current") <(jq -S '.schema' "$SCHEMA_FILE") || true
  echo "== global spec $(jq -r '.id' <<<"$global") (uiSchema)"
  diff <(jq -S '.schema.uiSchema // {}' <<<"$global") <(jq -S '.uiSchema' <<<"$global_patch") || true
  exit 0
fi

upsert_spec "$NRN" namespace deploy_summaries "$SCHEMA_FILE"

gid=$(jq -r '.id' <<<"$global")
out=$(api PATCH "/metadata/metadata_specification/$gid" "$(jq -c '{schema: .}' <<<"$global_patch")")
[[ "$(last_status)" =~ ^2 ]] && echo "  updated namespace global spec $gid @ $NRN (uiSchema)" \
  || { echo "FAILED patch global $gid ($(last_status)): $out" >&2; exit 1; }
