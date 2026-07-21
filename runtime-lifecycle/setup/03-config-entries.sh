#!/usr/bin/env bash
# Upserts the config entries the runtime-lifecycle workflows read, at engine
# path /action-items/runtime-lifecycle. Re-running rotates values in place
# (the engine's POST /workflows/config is an upsert by name+path).
#
# Also upserts the DEPLOY_* family at /deploy — wf-r4 reuses the shared
# `progressive_deploy` sub-workflow, which reads its window/traffic/gate
# config from that path (same convention as the cost suite's wf5). Defaults
# below mirror what's live on the nullplatform org (org 4) as of 2026-07-20.
#
# NP_API_KEY doubles as the workflows' credential. It is written ONCE at
# root path "/" (shared across every workflow suite in the org) and is
# NEVER overwritten by a re-run if an entry already exists there — GET is
# checked first so this script can't clobber a live secret.
#
# Usage:
#   NP_API_KEY=… ./03-config-entries.sh \
#     [--category-slug engineering] [--warn-days 31] [--horizon-days 180] \
#     [--window 01:00-05:00] [--tz-offset -03:00] \
#     [--traffic-steps 10,50,100] [--step-wait 120] \
#     [--pending-timeout 30] [--max-err-increase 1] [--max-rt-ratio 1.5] \
#     [--qa-max-replies 3]
#
# --category-slug (alias: --category) must match the ACTUAL slug reported by
# 02-category.sh — if the server minted "engineering-2" because the name was
# taken, pass that here so RUNTIME_LIFECYCLE_CATEGORY_SLUG matches reality.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../cost/setup/lib.sh
source "$SCRIPT_DIR/../../cost/setup/lib.sh"

CATEGORY="engineering"
WARN_DAYS="31"
HORIZON_DAYS="180"
# DEPLOY_* defaults — read live from org 4 (/deploy) on 2026-07-20. Fallback
# values (if a future re-derivation can't read org 4) would be
# WINDOW_START=01:00 WINDOW_END=06:00 TZ_OFFSET=-3 TRAFFIC_STEPS=25,50,100
# STEP_WAIT_SECONDS=300 PENDING_TIMEOUT_MINUTES=240
# MAX_ERROR_RATE_INCREASE=0.05 MAX_RESPONSE_TIME_RATIO=1.5 — not used here
# since org 4 answered.
WINDOW="01:00-05:00"; TZ_OFFSET="-03:00"
TRAFFIC_STEPS="10,50,100"; STEP_WAIT="120"
PENDING_TIMEOUT="30"; MAX_ERR_INCREASE="1"; MAX_RT_RATIO="1.5"
# Runaway brake for wf-r3's comment Q&A responder: max AI replies per item.
QA_MAX_REPLIES="3"

args=("$@")
parse_common_args "$@"
set -- "${args[@]}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) shift 2 ;;
    --category) CATEGORY="$2"; shift 2 ;;
    --category-slug) CATEGORY="$2"; shift 2 ;;
    --warn-days) WARN_DAYS="$2"; shift 2 ;;
    --horizon-days) HORIZON_DAYS="$2"; shift 2 ;;
    --window) WINDOW="$2"; shift 2 ;;
    --tz-offset) TZ_OFFSET="$2"; shift 2 ;;
    --traffic-steps) TRAFFIC_STEPS="$2"; shift 2 ;;
    --step-wait) STEP_WAIT="$2"; shift 2 ;;
    --pending-timeout) PENDING_TIMEOUT="$2"; shift 2 ;;
    --max-err-increase) MAX_ERR_INCREASE="$2"; shift 2 ;;
    --max-rt-ratio) MAX_RT_RATIO="$2"; shift 2 ;;
    --qa-max-replies) QA_MAX_REPLIES="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

mint_token
WINDOW_START="${WINDOW%-*}"; WINDOW_END="${WINDOW#*-}"

put() { # name value secret(true|false) path
  local body
  body=$(jq -n --arg name "$1" --arg value "$2" --argjson secret "$3" --arg path "$4" \
    '{name: $name, value: $value, secret: $secret, path: $path}')
  local out
  out=$(api POST "/workflows/config" "$body")
  if [[ "$(last_status)" =~ ^2 ]]; then
    echo "  $4 $1 → $(jq -r '.mode // "upserted"' <<<"$out")"
  else
    echo "  $4 $1 FAILED ($(last_status)): $out"; exit 1
  fi
}

echo "Upserting config entries on /action-items/runtime-lifecycle:"
put NP_ORGANIZATION_ID              "$ORG_ID"      false "/action-items/runtime-lifecycle"
put RUNTIME_LIFECYCLE_CATEGORY_SLUG "$CATEGORY"    false "/action-items/runtime-lifecycle"
put RUNTIME_WARN_DAYS               "$WARN_DAYS"   false "/action-items/runtime-lifecycle"
put RUNTIME_QA_MAX_REPLIES          "$QA_MAX_REPLIES" false "/action-items/runtime-lifecycle"

echo "Upserting config entries on /deploy (progressive_deploy sub-workflow):"
put DEPLOY_WINDOW_START            "$WINDOW_START"   false "/deploy"
put DEPLOY_WINDOW_END              "$WINDOW_END"     false "/deploy"
put DEPLOY_WINDOW_TZ_OFFSET        "$TZ_OFFSET"      false "/deploy"
put DEPLOY_TRAFFIC_STEPS           "$TRAFFIC_STEPS"  false "/deploy"
put DEPLOY_STEP_WAIT_SECONDS       "$STEP_WAIT"      false "/deploy"
put DEPLOY_PENDING_TIMEOUT_MINUTES "$PENDING_TIMEOUT" false "/deploy"
put DEPLOY_MAX_ERROR_RATE_INCREASE "$MAX_ERR_INCREASE" false "/deploy"
put DEPLOY_MAX_RESPONSE_TIME_RATIO "$MAX_RT_RATIO"   false "/deploy"

echo "Checking root secret NP_API_KEY (path /):"
existing=$(api GET "/workflows/config?path=/")
st="$(last_status)"
if [[ "$st" =~ ^2 ]]; then
  if jq -e '(.data // .) | map(select(.name == "NP_API_KEY")) | length > 0' <<<"$existing" >/dev/null 2>&1; then
    echo "  / NP_API_KEY already exists → left untouched (never clobber a live secret)"
  else
    put NP_API_KEY "$NP_API_KEY" true "/"
  fi
else
  echo "FAILED: could not verify existing secret (status $st) — refusing to write NP_API_KEY"
  exit 1
fi

echo "done."
