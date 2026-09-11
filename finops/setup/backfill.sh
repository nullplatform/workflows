#!/usr/bin/env bash
# One day at a time: collection + Kubernetes through the dispatcher (no allocation), then the allocator
# alone (see docs/customer-onboarding.md §5.1 for why). Re-mints the token per day (60-minute tokens).
#   NP_API_KEY=… ./backfill.sh <wf0 id> <wf2 id> 2026-09-10 2026-09-09 …
set -euo pipefail
API="https://api.nullplatform.com"; WF0="$1"; WF2="$2"; shift 2
tok() { curl -s -X POST "$API/token" -H 'Content-Type: application/json' -d "{\"apikey\":\"${NP_API_KEY:?}\"}" | python3 -c "import sys,json;print(json.load(sys.stdin).get('access_token',''))"; }
run() { curl -s -X POST "$API/workflows/definitions/$1/execute" -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d "$2" | python3 -c "import sys,json;print(json.load(sys.stdin)['execution']['id'])"; }
wait_for() { for _ in $(seq 1 90); do sleep 20; s=$(curl -s -H "Authorization: Bearer $T" "$API/workflows/executions/$1" | python3 -c "import json,sys;d=json.load(sys.stdin);e=d.get('data',d);print(e.get('status'))"); case "$s" in completed|failed|cancelled) echo "$s"; return;; esac; done; echo timeout; }
summary() { curl -s -H "Authorization: Bearer $T" "$API/workflows/executions/$1/steps/summary" | python3 -c "
import json,sys;d=json.load(sys.stdin);e=d.get('data',d);s=(e.get('invocations') or [{}])[-1].get('outputs') or {}
tot=s.get('total_usd') or 0;apps=[a for a in s.get('applications',[]) if a.get('application_id')];ap=sum(a['cost_usd'] for a in apps)
print('total %.2f apps %.2f (%.1f%%) unallocated %.2f invoices %s'%(tot,ap,100*ap/tot if tot else 0,s.get('unallocated_usd') or 0,s.get('invoices')))"; }
for D in "$@"; do
  T=$(tok); E=$(run "$WF0" "{\"inputs\":{\"date\":\"$D\",\"allocate\":false}}"); echo "$(date -u +%T) $D collect+k8s $E"
  s=$(wait_for "$E"); echo "$(date -u +%T) $D collect+k8s -> $s"; [[ "$s" == completed ]] || continue
  T=$(tok); E2=$(run "$WF2" "{\"inputs\":{\"date\":\"$D\"}}"); echo "$(date -u +%T) $D allocate $E2"
  s=$(wait_for "$E2"); echo "$(date -u +%T) $D allocate -> $s | $(summary "$E2")"
done
