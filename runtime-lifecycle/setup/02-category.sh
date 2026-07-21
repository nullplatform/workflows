#!/usr/bin/env bash
# Ensures the "Engineering" action item category exists for the runtime
# lifecycle suite's items (label workflow_type=lambda-runtime). The suite
# does NOT own this category — it is shared with other engineering-flavored
# workflows — so this script only verifies/reports it, it never renames or
# reconfigures an existing one.
#
# Category slugs are GLOBAL on the platform (the engineering-1/engineering-2
# lesson from the AMI drift rollout): never assume the slug, always read it
# back and print it.
#
# Usage: NP_API_KEY=… ./02-category.sh [--name Engineering]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../cost/setup/lib.sh
source "$SCRIPT_DIR/../../cost/setup/lib.sh"

NAME="Engineering"
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

existing=$(api GET "/governance/action_item_category?nrn=organization=$ORG_ID&limit=200")
st="$(last_status)"
if [[ ! "$st" =~ ^2 ]]; then
  if [[ "$st" == "403" ]]; then
    echo "WARN: 403 listing categories — the API key lacks grants for this org."
    echo "      Create '$NAME' by hand (or grant the key) and re-run to verify."
    exit 0
  fi
  echo "FAILED listing categories ($st): $existing"; exit 1
fi

# Category slugs, not names, are the stable identity — the AMI drift
# rollout taught us the server mints "engineering-2" etc. when the name is
# already taken elsewhere on the org, so a name match can silently miss the
# real category. Match on the TARGET_SLUG the runtime-lifecycle suite
# actually reads (RUNTIME_LIFECYCLE_CATEGORY_SLUG default in
# 03-config-entries.sh).
TARGET_SLUG="engineering"
slug=$(jq -r --arg slug "$TARGET_SLUG" '(.results // .) | map(select(.slug == $slug)) | .[0].slug // empty' <<<"$existing" 2>/dev/null || true)
cid=$(jq -r --arg slug "$TARGET_SLUG" '(.results // .) | map(select(.slug == $slug)) | .[0].id // empty' <<<"$existing" 2>/dev/null || true)

if [[ -n "$slug" ]]; then
  echo "category $TARGET_SLUG: $cid"
  echo "category id: $cid"
  exit 0
fi

body=$(jq -n --arg nrn "organization=$ORG_ID" --arg name "$NAME" \
  '{nrn: $nrn, name: $name, description: "Engineering improvements, technical debt, runtime upgrades, and deprecations"}')
out=$(api POST "/governance/action_item_category" "$body")
st="$(last_status)"
if [[ "$st" == "403" ]]; then
  echo "WARN: 403 creating category — the key lacks grants for this org."
  echo "      Create '$NAME' by hand (or grant the key) and re-run to verify."
  exit 0
fi
[[ "$st" =~ ^2 ]] || { echo "FAILED ($st): $out"; exit 1; }
slug=$(jq -r '.slug // empty' <<<"$out")
cid=$(jq -r '.id // empty' <<<"$out")
[[ -n "$slug" ]] || { echo "ERROR: could not resolve the category slug"; exit 1; }

echo "created category '$NAME' → slug: $slug (id $cid)"
if [[ "$slug" != "$TARGET_SLUG" ]]; then
  echo ""
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "!! WARNING: expected slug '$TARGET_SLUG' but the server assigned"
  echo "!! '$slug' instead (the name was already taken on this org)."
  echo "!! Pass --category-slug $slug to 03-config-entries.sh so"
  echo "!! RUNTIME_LIFECYCLE_CATEGORY_SLUG matches reality."
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo ""
fi
echo "category id: $cid"
