#!/usr/bin/env bash
# Registers the `security_assessment` metadata specification for the
# APPLICATION entity. Required before wf2 (assess-deployment) can persist or
# read per-app assessment state: writing an unregistered metadata key 400s
# ("body must NOT have additional properties") until a spec exists once per
# org — see API-CONTRACTS.md §1b. Without this, wf2's read_state/write_state
# steps never see a prior baseline and every run falls back to a full sweep.
#
# Placement: numbered 00- (not folded into 01-config-entries.sh, and not
# renumbering the two scripts that already ship here) so it runs BEFORE
# config entries — mirroring workflows/lib-inventory/setup/01-metadata-spec.sh,
# which registers its spec ahead of that suite's 02-config-entries.sh in the
# same way. Kept self-contained (curl + python3, same idiom as
# 01-config-entries.sh in this suite) rather than sourcing
# workflows/cost/setup/lib.sh, which nothing else in security-assessment
# depends on.
#
# Idempotent, same pattern as lib-inventory's script: POST the spec; on a
# 400/409 (already exists) resolve the existing spec id via GET+filter, then
# PATCH schema+description in place. Never touches instance data.
#
# Schema covers exactly the state fields wf2's `decide` step writes to
# `next_state` (wf2-assess-deployment.yaml): last_commit, last_run_at,
# last_full_at, last_mode. `additionalProperties: true`, matching the
# lib-inventory precedent, so the schema doesn't have to be kept byte-exact
# with wf2 forever.
#
# Usage: source .env.null && ./00-metadata-spec.sh   (needs NP_API_KEY + NP_ORGANIZATION_ID)
set -euo pipefail

API="${NP_API_BASE:-https://api.nullplatform.com}"
ORG_ID="${NP_ORGANIZATION_ID:?set NP_ORGANIZATION_ID}"
NRN="organization=$ORG_ID"

TOKEN=$(curl -sf -X POST "$API/token" -H 'Content-Type: application/json' \
  -d "{\"api_key\":\"$NP_API_KEY\"}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])')

SPEC_JSON=$(python3 -c '
import json, sys
nrn = sys.argv[1]
spec = {
    "name": "Security assessment",
    "description": "Per-application security assessment state, maintained by the security-assessment workflows (wf2). Do not edit by hand.",
    "nrn": nrn,
    "entity": "application",
    "metadata": "security_assessment",
    "schema": {
        "type": "object",
        "additionalProperties": True,
        "visibleOn": [],
        "properties": {
            "last_commit":  {"type": "string", "description": "Commit sha assessed on the last run (delta baseline)."},
            "last_run_at":  {"type": "string", "description": "ISO timestamp of the last run, any mode."},
            "last_full_at": {"type": "string", "description": "ISO timestamp of the last full-mode run."},
            "last_mode":    {"type": "string", "enum": ["full", "delta"], "description": "Effective mode of the last run."}
        }
    }
}
print(json.dumps(spec))
' "$NRN")

echo "Registering security_assessment metadata specification on $NRN"
STATUS=$(curl -sS -o /tmp/np-sec-metaspec-resp.json -w '%{http_code}' -X POST "$API/metadata/metadata_specification" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$SPEC_JSON")
BODY=$(cat /tmp/np-sec-metaspec-resp.json)

if [[ "$STATUS" =~ ^2 ]]; then
  echo "  created: $(python3 -c 'import json,sys;print(json.load(sys.stdin).get("id","ok"))' <<<"$BODY")"
elif [[ "$STATUS" == "400" || "$STATUS" == "409" ]]; then
  LIST_JSON=$(curl -sf "$API/metadata/metadata_specification?nrn=$NRN&limit=200" -H "Authorization: Bearer $TOKEN")
  SID=$(python3 -c '
import json, sys
data = json.load(sys.stdin)
items = data.get("results", data) if isinstance(data, dict) else data
items = items if isinstance(items, list) else []
for it in items:
    if it.get("entity") == "application" and it.get("metadata") == "security_assessment":
        print(it.get("id", ""))
        break
' <<<"$LIST_JSON")
  if [[ -z "$SID" ]]; then
    echo "FAILED: exists but could not resolve spec id ($STATUS): $BODY"
    exit 1
  fi
  PATCH_JSON=$(python3 -c '
import json, sys
spec = json.load(sys.stdin)
print(json.dumps({"schema": spec["schema"], "description": spec["description"]}))
' <<<"$SPEC_JSON")
  PSTATUS=$(curl -sS -o /tmp/np-sec-metaspec-patch.json -w '%{http_code}' -X PATCH "$API/metadata/metadata_specification/$SID" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$PATCH_JSON")
  PBODY=$(cat /tmp/np-sec-metaspec-patch.json)
  if [[ "$PSTATUS" =~ ^2 ]]; then
    echo "  updated spec $SID"
  else
    echo "FAILED patch ($PSTATUS): $PBODY"
    exit 1
  fi
else
  echo "FAILED ($STATUS): $BODY"
  exit 1
fi
echo "Done."
