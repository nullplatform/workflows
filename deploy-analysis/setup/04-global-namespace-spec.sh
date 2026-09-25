#!/usr/bin/env bash
# Merges the deploy_summaries slice into the organization's namespace
# "Global Specification" — the spec the namespace dashboard's Catalog panel
# renders (it asks for the global spec only, so the per-namespace specs from
# 01-metadata-specs.sh never reach that panel).
#
# Only the deploy_summaries definition, property and "Deploy summaries"
# category are replaced; every other category of the global spec is kept.
# Refuses to create the global spec: that is an organization-wide decision.
#
# Usage:
#   ./04-global-namespace-spec.sh [--env-file <file>] [--dry-run] "organization=<org>"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../cost/setup/lib.sh
source "$SCRIPT_DIR/../../cost/setup/lib.sh"

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

FRAGMENT="$SCRIPT_DIR/schemas/global-namespace-deploy-summaries.json"
CATEGORY_LABEL=$(jq -r '.category.label' "$FRAGMENT")

mint_token

spec=$(api GET "/metadata/metadata_specification?nrn=$NRN&entity=namespace&limit=200" \
  | jq -c --arg nrn "$NRN" '(.results // .) | map(select(.entity=="namespace" and .nrn==$nrn and .metadata==null)) | .[0] // empty')
[[ -n "$spec" ]] || { echo "FAILED: no namespace Global Specification at $NRN ($(last_status))" >&2; exit 1; }
sid=$(jq -r '.id' <<<"$spec")

merged=$(jq -c --slurpfile f "$FRAGMENT" --arg label "$CATEGORY_LABEL" '
  $f[0] as $frag
  | .schema
  | .definitions.deploy_summaries = $frag.definition
  | .properties.deploy_summaries = $frag.property
  | .uiSchema = (
      (.uiSchema // {type: "Categorization", elements: []})
      | .elements = (
          if any(.elements[]?; .label == $label)
          then [.elements[] | if .label == $label then $frag.category else . end]
          else (.elements // []) + [$frag.category]
          end
        )
    )' <<<"$spec")

if [[ -n "$DRY_RUN" ]]; then
  diff <(jq -S '.schema' <<<"$spec") <(jq -S '.' <<<"$merged") && echo "no changes for $sid"
  exit 0
fi

out=$(api PATCH "/metadata/metadata_specification/$sid" "$(jq -c '{schema: .}' <<<"$merged")")
[[ "$(last_status)" =~ ^2 ]] && echo "updated namespace Global Specification $sid @ $NRN" \
  || { echo "FAILED patch $sid ($(last_status)): $out" >&2; exit 1; }
