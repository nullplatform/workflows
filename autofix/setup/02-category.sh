#!/usr/bin/env bash
# Ensures the action item category the autofix items are filed under exists,
# and prints its SLUG — which is what AUTOFIX_CATEGORY_SLUG must hold.
#
# Category slugs are GLOBAL on the platform: when the name is already taken,
# the server mints "security-2" etc., so never assume the slug — read it back.
# This script only verifies/creates; it never renames an existing category.
#
# Usage: NP_API_KEY=… ./02-category.sh [--name Security] [--slug security]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../cost/setup/lib.sh
source "$SCRIPT_DIR/../../cost/setup/lib.sh"

NAME="Security"
TARGET_SLUG="security"
args=("$@")
parse_common_args "$@"
set -- "${args[@]}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --slug) TARGET_SLUG="$2"; shift 2 ;;
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

slug=$(jq -r --arg slug "$TARGET_SLUG" '(.results // .) | map(select(.slug == $slug)) | .[0].slug // empty' <<<"$existing" 2>/dev/null || true)
cid=$(jq -r --arg slug "$TARGET_SLUG" '(.results // .) | map(select(.slug == $slug)) | .[0].id // empty' <<<"$existing" 2>/dev/null || true)
if [[ -n "$slug" ]]; then
  echo "category $TARGET_SLUG already exists (id $cid)"
  echo "AUTOFIX_CATEGORY_SLUG=$slug"
  exit 0
fi

body=$(jq -n --arg nrn "organization=$ORG_ID" --arg name "$NAME" \
  '{nrn: $nrn, name: $name, description: "Security findings from CI scans (vulnerabilities, SAST, secrets, licenses) and their automated fixes"}')
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
  echo "!! WARNING: expected slug '$TARGET_SLUG' but the server assigned '$slug'."
  echo "!! Re-run 01-config-entries.sh with --category-slug $slug."
  echo ""
fi
echo "AUTOFIX_CATEGORY_SLUG=$slug"
