#!/usr/bin/env bash
# Ensures the right-sizing action item category exists and records its REAL
# slug in the RIGHTSIZING_CATEGORY_SLUG config entry.
#
# Category slugs are GLOBAL on the platform: "FinOps" may land as finops,
# finops-1, finops-2… (the engineering-1/engineering-2 lesson from the AMI
# drift rollout). Never assume the slug — always read it back.
#
# Usage: NP_API_KEY=… ./03-category.sh [--name FinOps]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

NAME="FinOps"
args=("$@")
parse_common_args "$@"
set -- "${args[@]}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

mint_token

# Already there? (match by name within the org)
existing=$(api GET "/governance/action_item_category?nrn=organization=$ORG_ID&limit=200")
slug=$(jq -r --arg name "$NAME" '(.results // .) | map(select(.name == $name)) | .[0].slug // empty' <<<"$existing" 2>/dev/null || true)

if [[ -z "$slug" ]]; then
  body=$(jq -n --arg nrn "organization=$ORG_ID" --arg name "$NAME" \
    '{nrn: $nrn, name: $name, description: "Cost optimization opportunities detected by the right-sizing workflows"}')
  out=$(api POST "/governance/action_item_category" "$body")
  [[ "$(last_status)" =~ ^2 ]] || { echo "FAILED ($(last_status)): $out"; exit 1; }
  slug=$(jq -r '.slug // empty' <<<"$out")
  echo "created category '$NAME' → slug: $slug (id $(jq -r '.id // "?"' <<<"$out"))"
else
  echo "category '$NAME' already exists → slug: $slug"
fi

[[ -n "$slug" ]] || { echo "ERROR: could not resolve the category slug"; exit 1; }

# Point the workflows at the real slug.
body=$(jq -n --arg value "$slug" '{name: "RIGHTSIZING_CATEGORY_SLUG", value: $value, secret: false, path: "/cost"}')
api POST "/workflows/config" "$body" >/dev/null
[[ "$(last_status)" =~ ^2 ]] && echo "RIGHTSIZING_CATEGORY_SLUG=$slug upserted on /cost" || echo "WARN: could not upsert RIGHTSIZING_CATEGORY_SLUG"
