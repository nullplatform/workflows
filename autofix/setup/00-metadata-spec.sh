#!/usr/bin/env bash
# Creates (or verifies) the `quality_metrics` metadata specification on builds:
# the contract CI writes and the autofix listener reads. Payload:
# 00-metadata-spec.json, with <ORG_ID> replaced by the key's organization.
#
# Idempotent: an existing build spec named `quality_metrics` at the org NRN is
# reported, not duplicated. Updating a spec's schema is a PATCH on its id —
# do that deliberately, it changes what every CI write is validated against.
#
# Usage: NP_API_KEY=… ./00-metadata-spec.sh [--nrn organization=X:account=Y]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../cost/setup/lib.sh
source "$SCRIPT_DIR/../../cost/setup/lib.sh"

NRN=""
args=("$@")
parse_common_args "$@"
set -- "${args[@]}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) shift 2 ;;
    --nrn) NRN="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

mint_token
[[ -n "$NRN" ]] || NRN="organization=$ORG_ID"

existing=$(api GET "/metadata/metadata_specification?entity=build&nrn=$(jq -rn --arg n "$NRN" '$n|@uri')")
st="$(last_status)"
[[ "$st" =~ ^2 ]] || { echo "FAILED listing specifications ($st): $existing"; exit 1; }
id=$(jq -r '(.results // .) | map(select(.metadata == "quality_metrics")) | .[0].id // empty' <<<"$existing")
if [[ -n "$id" ]]; then
  echo "quality_metrics specification already exists at $NRN: $id"
  exit 0
fi

body=$(jq --arg nrn "$NRN" '.nrn = $nrn' "$SCRIPT_DIR/00-metadata-spec.json")
out=$(api POST "/metadata/metadata_specification" "$body")
st="$(last_status)"
[[ "$st" =~ ^2 ]] || { echo "FAILED ($st): $out"; exit 1; }
echo "created quality_metrics specification at $NRN: $(jq -r '.id' <<<"$out")"
