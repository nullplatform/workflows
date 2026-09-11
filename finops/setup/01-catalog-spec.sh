#!/usr/bin/env bash
# Creates (or updates in place) the two catalog entity specifications of the
# cost-finout suite: `infrastructure_cost` and `blended_rate`.
#
# NOTE: creating catalog SPECIFICATIONS requires an org-admin principal.
# The suite's API key (workflow-deployment-analyzer) can write INSTANCES once
# the specs exist (entities grants allow create/write to *), but not create
# the specs themselves — run this once with a user session token:
#
#   NP_TOKEN=<session bearer> ./01-catalog-specs.sh
#   (or NP_API_KEY=<admin key> ./01-catalog-specs.sh)
#
# Idempotent: an existing spec (same slug) is PATCHed with the current schema.
set -euo pipefail

API="https://api.nullplatform.com"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPECS_DIR="$SCRIPT_DIR/../specs"

if [[ -z "${NP_TOKEN:-}" ]]; then
  [[ -n "${NP_API_KEY:-}" ]] || { echo "ERROR: set NP_TOKEN (session bearer) or NP_API_KEY"; exit 1; }
  NP_TOKEN=$(curl -s -X POST "$API/token" -H 'Content-Type: application/json' \
    -d "{\"apikey\":\"$NP_API_KEY\"}" | jq -r '.access_token // empty')
  [[ -n "$NP_TOKEN" ]] || { echo "ERROR: could not mint token from NP_API_KEY"; exit 1; }
fi

# Resolve organization from the token (falabella = 987889794)
ORG_ID=$(python3 - "$NP_TOKEN" <<'EOF'
import base64, json, sys
p = sys.argv[1].split('.')[1]; p += '=' * (-len(p) % 4)
c = json.loads(base64.urlsafe_b64decode(p))
grp = c.get('cognito:groups') or []
org = next((g.split('=')[1] for g in grp if g.startswith('@nullplatform/organization=')), '')
print(org or c.get('organization_id', ''))
EOF
)
[[ -n "$ORG_ID" ]] || ORG_ID=1255165411
echo "organization: $ORG_ID"
TOKEN_USER_ID=$(python3 - "$NP_TOKEN" <<'PY'
import base64, json, sys, re
p = sys.argv[1].split('.')[1]; p += '=' * (-len(p) % 4)
g = json.loads(base64.urlsafe_b64decode(p)).get('cognito:groups', [])
m = [re.sub(r'.*user=', '', x) for x in g if 'user=' in x]
print(m[0] if m else 0)
PY
)
echo "admin user for grants: ${ADMIN_USER_ID:-$TOKEN_USER_ID}"

api() { # method path [body-file]
  local m="$1" p="$2" b="${3:-}"
  if [[ -n "$b" ]]; then
    curl -s -w '\n%{http_code}' -X "$m" "$API$p" -H "Authorization: Bearer $NP_TOKEN" \
      -H 'Content-Type: application/json' --data-binary "@$b"
  else
    curl -s -w '\n%{http_code}' -X "$m" "$API$p" -H "Authorization: Bearer $NP_TOKEN"
  fi
}

for slug in cost_daily cost_mapping_rule cost_mapping_suggestion application_cost_daily; do
  f="$SPECS_DIR/$slug.spec.json"
  body=$(mktemp)
  # Spec grants must name a user of THIS org: rewrite the admin principal in the JSON
  # (every `type: user` principal, placeholder 732189543) to ADMIN_USER_ID, default = the token's user.
  jq --arg nrn "organization=$ORG_ID" --argjson admin "${ADMIN_USER_ID:-$TOKEN_USER_ID}" \
     '. + {nrn: $nrn} | (.. | objects | select(.type? == "user") | .id) |= $admin' "$f" > "$body"

  out=$(api POST "/catalog/specifications" "$body")
  st=$(tail -n1 <<<"$out"); res=$(sed '$d' <<<"$out")
  if [[ "$st" =~ ^2 ]]; then
    echo "created $slug: $(jq -r '.id // "ok"' <<<"$res")"
  elif [[ "$st" == "409" || ( "$st" == "400" && "$res" == *exist* ) ]]; then
    sid=$(api GET "/catalog/specifications?nrn=organization=$ORG_ID&limit=100" | sed '$d' \
      | jq -r --arg s "$slug" '[.. | objects | select(.slug? == $s)] | .[0].id // empty')
    [[ -n "$sid" ]] || { echo "FAILED: $slug exists but id not resolvable: $res"; exit 1; }
    # NOTA: el PATCH rechaza la key `relations` dentro de schema (400) — se quita
    patch=$(mktemp); jq '{schema: (.schema | del(.relations)), description: .description, name: .name}' "$body" > "$patch"
    out=$(api PATCH "/catalog/specifications/$sid" "$patch")
    st=$(tail -n1 <<<"$out")
    [[ "$st" =~ ^2 ]] && echo "updated $slug ($sid)" || { echo "FAILED patch $slug ($st): $(sed '$d' <<<"$out")"; exit 1; }
  else
    echo "FAILED $slug ($st): $res"; exit 1
  fi
done
