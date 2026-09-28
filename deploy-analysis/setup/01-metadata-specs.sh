#!/usr/bin/env bash
# Declares the deploy-analysis metadata specifications, SCOPED to the
# namespaces the suite will analyze (never organization-wide: application
# and namespace summaries are developer-visible, so entities outside the
# analyzed namespaces must not grow empty metadata blocks).
#
# Per namespace NRN this creates five specs:
#   deployment  / change                  — per-deployment analysis (risk, PRs, participants)
#   application / deploy_summaries        — weekly roll-up, PROD deploys
#   application / deploy_summaries_stage  — weekly roll-up, STAGE deploys
#   namespace   / deploy_summaries        — weekly roll-up, PROD deploys
#   namespace   / deploy_summaries_stage  — weekly roll-up, STAGE deploys
#
# Idempotent: existing (entity, metadata, nrn) specs get their schema PATCHed.
#
# Usage:
#   ./01-metadata-specs.sh [--env-file <file>] \
#     "organization=<org>:account=<acc>:namespace=<ns1>" \
#     "organization=<org>:account=<acc>:namespace=<ns2>" ...

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../cost/setup/lib.sh
source "$SCRIPT_DIR/../../cost/setup/lib.sh"
# shellcheck source=./specs.sh
source "$SCRIPT_DIR/specs.sh"

NRNS=()
ARGS=("$@")
i=0
while [[ $i -lt ${#ARGS[@]} ]]; do
  case "${ARGS[$i]}" in
    --env-file) set -a; source "${ARGS[$((i+1))]}"; set +a; i=$((i+2)) ;;
    organization=*) NRNS+=("${ARGS[$i]}"); i=$((i+1)) ;;
    *) i=$((i+1)) ;;
  esac
done
[[ ${#NRNS[@]} -gt 0 ]] || { echo "usage: $0 [--env-file f] <namespace-nrn> [...]" >&2; exit 1; }

mint_token

for nrn in "${NRNS[@]}"; do
  echo "namespace $nrn"
  upsert_spec "$nrn" deployment  change                 "$SCRIPT_DIR/schemas/deployment-change.json"
  upsert_spec "$nrn" application deploy_summaries       "$SCRIPT_DIR/schemas/application-deploy-summaries.json"
  upsert_spec "$nrn" application deploy_summaries_stage "$SCRIPT_DIR/schemas/application-deploy-summaries.json" "(staging)"
  upsert_spec "$nrn" namespace   deploy_summaries       "$SCRIPT_DIR/schemas/namespace-deploy-summaries.json"
  upsert_spec "$nrn" namespace   deploy_summaries_stage "$SCRIPT_DIR/schemas/namespace-deploy-summaries.json" "(staging)"
done
echo "done."
