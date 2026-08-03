#!/usr/bin/env bash
# One-time catalog setup for the deploy-governance suite.
#
# Creates the metadata specifications the workflows read and write:
#   application/governance        — criticality (named enum, UI-selectable)
#   user/identity                 — github_username (GitHub -> NP user mapping)
#   deployment/change             — per-deploy change analysis (open schema)
#   application/deploy_summaries  — weekly rolling summaries (app level)
#   namespace/deploy_summaries    — weekly rolling summaries (namespace level)
#
# Usage:
#   NP_API_KEY=... NP_ORGANIZATION_ID=<org-id> ./01-catalog-specs.sh
#
# Idempotent-ish: re-running when a spec already exists prints the API error
# for that spec and continues (specs are keyed by entity+metadata per NRN).
set -euo pipefail

: "${NP_API_KEY:?set NP_API_KEY}"
: "${NP_ORGANIZATION_ID:?set NP_ORGANIZATION_ID}"
API="https://api.nullplatform.com"
NRN="organization=${NP_ORGANIZATION_ID}"

TOKEN=$(curl -sf -X POST "$API/token" -H 'content-type: application/json' \
  -d "{\"api_key\":\"$NP_API_KEY\"}" | jq -r .access_token)

create_spec() {
  local body="$1" name
  name=$(echo "$body" | jq -r '.entity + "/" + .metadata')
  echo "== $name"
  curl -s -X POST "$API/metadata/metadata_specification" \
    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "$body" | jq -c '{id: (.id // null), error: (.message // null)}'
}

# --- application/governance: criticality as a NAMED enum (renders as a
# select with explanations in the catalog UI via oneOf + title).
create_spec "$(jq -n --arg nrn "$NRN" '{
  nrn: $nrn, entity: "application", metadata: "governance",
  name: "Application governance",
  description: "Governance attributes: criticality drives the deploy risk matrix.",
  schema: {
    type: "object", additionalProperties: true,
    properties: {
      criticality: {
        type: "string",
        description: "How critical this application is for the business",
        oneOf: [
          { const: "mission_critical", title: "Mission critical - outage stops the business" },
          { const: "critical",         title: "Critical - customer-facing impact within minutes" },
          { const: "important",        title: "Important - degrades operations, no immediate customer impact" },
          { const: "standard",         title: "Standard - internal tooling with workarounds" },
          { const: "internal",         title: "Internal - non-productive or administrative" }
        ],
        visibleOn: ["create", "read", "update", "list"]
      }
    }
  }
}')"

# --- user/identity: GitHub handle mapping for participant extraction.
create_spec "$(jq -n --arg nrn "$NRN" '{
  nrn: $nrn, entity: "user", metadata: "identity",
  name: "User identity",
  description: "External identities of the user; github_username maps commit/PR authors to platform users.",
  schema: {
    type: "object", additionalProperties: true,
    properties: { github_username: { type: "string" } }
  }
}')"

# --- deployment/change: the per-deploy analysis document (open schema: the
# workflow owns the shape; see deploy-change-analysis.yaml).
create_spec "$(jq -n --arg nrn "$NRN" '{
  nrn: $nrn, entity: "deployment", metadata: "change",
  name: "Deployment change analysis",
  description: "Diff, participants, risk signals, LLM risk score and approval-matrix decision for a production deployment. Written by the deploy-change-analysis workflow.",
  schema: { type: "object", additionalProperties: true }
}')"

# --- deploy_summaries (app + namespace): rolling weekly summaries. The UI
# card renders only latest_summary (visibleOn); weeks is API/lake-only data.
weekly_schema() {
  local prs_schema="$1"
  jq -n --argjson prs "$prs_schema" '{
    type: "object", additionalProperties: true,
    properties: {
      latest_summary: {
        type: "string",
        description: "Functional summary of the latest week of production deploys",
        visibleOn: ["list", "read"]
      },
      weeks: {
        type: "array",
        description: "Weekly history (rolling 53 weeks, newest first)",
        visibleOn: [],
        items: {
          type: "object", additionalProperties: true,
          properties: {
            week_start: { type: "string" },
            week_end:   { type: "string" },
            deploys:    { type: "integer" },
            risk:       { type: "object", additionalProperties: true },
            summary_md: { type: "string" },
            prs: $prs,
            generated_at: { type: "string" }
          }
        }
      }
    }
  }'
}

create_spec "$(jq -n --arg nrn "$NRN" --argjson schema "$(weekly_schema '{ "type": "array", "items": { "type": "object", "additionalProperties": true } }')" '{
  nrn: $nrn, entity: "application", metadata: "deploy_summaries",
  name: "Application weekly deploy summaries",
  description: "Weekly functional summaries of production deploys (rolling 53 weeks). Written by the deploy-weekly-summary workflow.",
  schema: $schema
}')"

create_spec "$(jq -n --arg nrn "$NRN" --argjson schema "$(weekly_schema '{ "type": "integer" }')" '{
  nrn: $nrn, entity: "namespace", metadata: "deploy_summaries",
  name: "Namespace weekly deploy summaries",
  description: "Weekly functional roll-ups of production deploys per namespace (rolling 53 weeks). Written by the deploy-weekly-summary workflow.",
  schema: $schema
}')"

echo "Done. Remember: the metadata service VALIDATES writes against these"
echo "schemas — the app spec stores prs as an array of objects, the namespace"
echo "spec as a count. Keep the workflow write step and the specs in sync."
