#!/usr/bin/env bash
# Seeds the config entries for the security-assessment suite on the folder
# /action-items/security-assessment. Secrets are WRITE-ONLY: re-running
# upserts by name+path (POST /workflows/config is an upsert).
#
# Usage: source .env.null && ./01-config-entries.sh   (needs NP_API_KEY + GITHUB_TOKEN)
set -euo pipefail

API="${NP_API_BASE:-https://api.nullplatform.com}"
FOLDER="/action-items/security-assessment"

TOKEN=$(curl -sf -X POST "$API/token" -H 'Content-Type: application/json' \
  -d "{\"api_key\":\"$NP_API_KEY\"}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])')

entry() { # $1 name $2 value $3 secret(true|false)
  curl -sf -X POST "$API/workflows/config" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "$(python3 -c "import json,sys;print(json.dumps({'name':sys.argv[1],'value':sys.argv[2],'secret':sys.argv[3]=='true','path':'$FOLDER'}))" "$1" "$2" "$3")" \
    > /dev/null && echo "  ✓ $1"
}

echo "Seeding config entries on $FOLDER"
entry NP_API_KEY "$NP_API_KEY" true
entry GITHUB_TOKEN "$GITHUB_TOKEN" true
entry NP_ORGANIZATION_ID "${NP_ORGANIZATION_ID:?set NP_ORGANIZATION_ID}" false
entry SEC_CATEGORY_SLUG "${SEC_CATEGORY_SLUG:?set SEC_CATEGORY_SLUG}" false
entry SEC_MIN_SEVERITY "${SEC_MIN_SEVERITY:-medium}" false
entry SEC_DUE_DAYS "${SEC_DUE_DAYS:-14}" false
# SEC_AGENT_MODEL looks optional (the YAMLs read
# ${{ vars.SEC_AGENT_MODEL || 'claude-opus-5' }}) but the || fallback never
# fires: the expression resolver throws CONFIG_ENTRY_UNRESOLVED on the
# unresolved var before evaluating the ||, so the entry MUST exist.
entry SEC_AGENT_MODEL "${SEC_AGENT_MODEL:-claude-opus-5}" false
echo "Done."
