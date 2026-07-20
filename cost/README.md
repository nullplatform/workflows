# Cost Tracker + Right Sizing

Workflow suite for K8s-backed scopes: daily per-scope cost from the cluster's
Prometheus (via the **np agent**), catalog + lake series for dashboards, weekly
right-sizing analysis with AI validation, action items with applyable
suggestions, and an AI-orchestrated progressive deploy. A monthly calibration
derives the unit prices from the cluster's real AWS bill.

This README is the operational source of truth — it reflects what is deployed
and what was learned bringing it up on two real clusters (a demo cluster and a
production cluster).

Companion docs:
- **[docs/architecture.md](./docs/architecture.md)** — component map, data
  flow, scan decision tree and item lifecycle, with diagrams. Start here for
  the mental model.
- **[docs/decisions.md](./docs/decisions.md)** — every design decision with
  its WHY, including the ones we reversed (fleet→per-pod, peak→p95) and the
  engine lessons the suite paid for.

**The iron rule of this suite**: every number that feeds a sizing comparison
is PER-POD (requests are per-pod config; fleet sums move with the autoscaler
and are only valid for pricing). See [decisions.md D9](./docs/decisions.md#d9).

## The cost model (read this first)

Every scope gets a `cost_tracking` catalog instance with THREE numbers per day:

| Field | Meaning | Basis |
|---|---|---|
| `cost_today` | **What the scope costs** (the headline devs see) | Chargeback: `max(usage, request)` **per hour**. Requests bind cluster nodes whether used or not — a scope's cost drops when it lowers requests, not when it idles. |
| `usage_cost_today` | What it actually consumed | Usage × unit prices |
| `waste_today` | `cost_today - usage_cost_today` | Reserved-but-unused — the number right-sizing attacks |

Billing is hourly against **that hour's** request (replica scaling within a day
is real: 100 pods at 10:00 and 2 at 11:00 bill differently), and the daily
series records the replica envelope (`pods_min/max/avg`) — the input for
future instance-count (min/max autoscaling) recommendations, not just cpu/mem.

Sanity property, verified live in production: `Σ cost_today` across
scopes (lake query below) equals the tracker's `org_cost_day` exactly, and
reconciles with the cluster's amortized compute bill minus platform overhead
(system namespaces, observability stacks, idle node headroom).

## Pieces

| File | What it is |
|---|---|
| `wf1-cost-tracker.yaml` | Daily cron 04:00 UTC: list k8s-backed scopes (lake) → per-scope collector (fan-out ×5) → org summary |
| `wf1b-cost-scope-collect.yaml` | Per scope: agent command (day mode) → hourly chargeback pricing → 365-day FIFO series → catalog upsert. **Preserves** `provisioning_status` (scanner-owned). |
| `wf2-right-sizing-scanner.yaml` | Weekly cron Mon 05:00: scopes → per-scope analysis (fan-out ×3, each child may run an AI agent) |
| `wf2b-right-sizing-analyze-scope.yaml` | Phase 0 prefilter/router (tracker metadata + live-item check + **15-day rescan window**, no Prometheus) → deterministic **per-pod** usage-vs-request filter (14d, basis-aware) → AI deep-dive (Opus + metrics tool) → item create/refresh/**auto-close** + catalog flag sync + last-scan stamp |
| `wf2c-cost-metrics-tool.yaml` | AI-agent tool: bounded PromQL query_range via the agent (PromQL ships base64) |
| `wf3-right-sizing-events.yaml` | Action-item events (label `workflow_type=rightsizing`): suggestion accepted → wf4; comments → `rightsizing-command` signal; **unclaimed human comments → wf8 Q&A** |
| `wf4-apply-rightsizing.yaml` | Executes an accepted suggestion: patch `requested_spec` (approval/policy-aware) and, per timing (`next-deploy` / `scheduled` / `now`), delegate to the reusable progressive deploy |
| `wf6-cluster-cost-calibration.yaml` | Monthly cron (day 2): real bill (CE amortized) + fleet (Prometheus) → unit prices → config entries + account `cost_pricing` metadata. Guardrailed. |
| `wf7-rightsizing-closer.yaml` | Weekly cron Thu 06:00: walks scopes with a live item pointer and verifies **acted-on** changes from tracker data (no Prometheus, no AI) — fan-out to wf7b |
| `wf7b-rightsizing-verify-scope.yaml` | Per scope: did the request actually change (applied or by hand)? ≥3 post-change days healthy → comment realized before/after + close; running hot → warning close + `under_provisioned` flag; stale item pointer → cleanup |
| `wf8-rightsizing-qa.yaml` | AI Q&A on item threads: answers questions/objections about the analysis as comments (metrics tool available). Deterministic guards: no bot authors, last comment must be human, per-item reply cap |
| `../deploy/*` | Reusable AI progressive-deploy pack (own README) |
| `scripts/collect-metrics.sh` | Agent-side collector (bash+curl+jq). Canonical copy; deployed via the org's scope-overrides repo. v3 added the 10m peak profile; v4 adds PER-POD requests (KSM) + hottest-pod p95-10m. |
| `scripts/cluster-costing.sh` | Agent-side monthly calibration (CE + Prometheus) |
| `setup/*` | Configuration runbook (below) |

## What the suite expects from the cluster

### 1. Prometheus

Reachable from the agent (the workflows pass `--prom <url>` inside
`COST_AGENT_CMDLINE`; e.g.
`http://prometheus-server.default.svc.cluster.local`). Must scrape:

- **cAdvisor** (kubelet): `container_cpu_usage_seconds_total`,
  `container_memory_working_set_bytes`, `container_cpu_cfs_throttled_periods_total`,
  `container_cpu_cfs_periods_total` — the *usage* side.
- **kube-state-metrics**: `kube_pod_container_resource_requests`,
  `kube_pod_container_status_restarts_total` — the *requests* side.
- For wf6 also: `kube_node_status_allocatable`, `kube_node_info`.

Retention should cover `RIGHTSIZING_LOOKBACK_DAYS` (default 14) — note a
size-based retention cap (e.g. 28GiB) can trim earlier than the time cap. The
collector reports actual `coverage_pct`; short retention degrades honestly, it
does not break.

**KSM history caveat**: cAdvisor series live as long as retention, but
kube-state-metrics series restart when the KSM pod is recreated. Requests are
*configuration*, not behavior, so the collector averages them only over points
where the series exists and exposes `request_now_*` + `request_points`. Do not
"fix" this by averaging over the full window — that dilutes requests and blinds
the over-provision filter (this happened; see git history).

### 2. The nullplatform agent

Commands are dispatched via `POST /controlplane/agent_command` with
`{selector: tags, nrn}` — the **control plane** resolves the agent (requires
engine ≥ PR #84; older engines pre-resolved client-side and broke on orgs with
>100 registered agents).

- The agent must mount the org's **scope-overrides repo** as a command repo
  (`--command-executor-git-command-repos`); the collector scripts live there
  under `cost/` (e.g. a repo `<org>/scopes-override`, cmdline
  `<org>/scopes-override/cost/collect_metrics`). With a plain
  `np-agent --runtime=host` (demo setups) the cmdline is instead a path
  relative to the executor **basepath** (default `~/.np`), e.g.
  `cost/collect-metrics.sh`.
- After merging script changes, dispatch
  `{"command":{"type":"refresh-sources","data":{}}}` — the agent does NOT
  auto-pull its command repos, and the `data:{}` is MANDATORY: without it the
  agent's handler errors internally while still reporting success, and the
  sources silently never refresh (engine ≥ PR #101 sends it correctly).
- `COST_AGENT_NRN` may need to be **account-level** (e.g.
  `organization=<org>:account=<acct>`): agents register under the account their
  apikey belongs to, and an org-level NRN may not find them.
- **The agent's exec validator rejects shell metacharacters** (`( ) { }`) on
  command lines. This shapes the whole interface: pod-matcher regexes travel as
  `--scope <id>` (the script builds the regex itself) and free-form PromQL as
  `--promql-b64`. If you write new agent-side tooling, keep arguments to plain
  words or base64.
- `inject_workflow_env: false` is **mandatory** on every `np-agent-command`
  step: the control plane rejects `data.env` on exec commands. Anything the
  scripts need from the environment (AWS keys for wf6) is configured on the
  agent itself (`--command-executor-env`).
- The agent host needs `bash`, `curl` (≥7.75 for wf6's `--aws-sigv4`), `jq`.

### 3. Scope → pods mapping

The heart of the system. Nullplatform recreates the k8s Deployment/Service on
every deploy, so metric series come and go with pod names — but the **scope id
embedded in the pod name** is stable, including for pods that no longer exist.
The collector's `--scope <id>` mode matches BOTH k8s scope styles:

- new style: `d-<scope_id>-<deployment_id>-<hashes>`
- legacy: `<slugs>-<scope_id>-d-<deployment_id><hashes>` — names are truncated
  to 63 chars **from the front**, so the `<scope_id>-d-` tail always survives.

Pods DO carry nullplatform labels (`scope_id`, `deployment_id`, …) but cAdvisor
does **not** propagate pod labels to metric series and `kube_pod_labels` is
typically absent — name matching is the only join that also covers dead pods.

Containers: `application` (what `requested_spec` sizes — right-sizing analyzes
this one) and `http` (traffic sidecar — included in cost, excluded from
right-sizing).

**Adapting to a different cluster**: if pods follow another naming scheme, set
`COST_POD_MATCHERS_TEMPLATE` to a raw-matchers template with placeholders
`{scope_id} {scope_slug} {scope_name} {app_name}` (e.g.
`namespace="{app_name}",pod=~"{scope_slug}.*"`) instead of the `scope`
sentinel — but raw matchers only work with agents that allow regex characters
on the command line. The namespace comes from `COST_K8S_NAMESPACE`.
**Always verify the mapping** with the collector's audit mode before trusting
any number:

```bash
# via agent_command:
cost/collect_metrics --prom <url> --mode pods --scope <id> --start now-7d
# → every pod that EVER matched in the window, first/last seen, style, alive_now
```

### 4. Scope types

The lake query covers `web_pool_k8s`, `custom` and `web_pool` — any type that
can be k8s-backed (in practice most requested cores may belong to
`custom` scopes, not `web_pool_k8s`). Non-k8s scopes fall out naturally as
`no_data` (no pods match). **Auto-apply suggestions only attach to
`web_pool_k8s`** — the only type whose `requested_spec` wf4 knows how to patch;
other types get the action item (report + numbers) for manual action.

## Config entries (path `/cost`)

Created by `setup/02-config-entries.sh`. All plain vars except `NP_API_KEY`.
A `${{ vars.X }}` reference to a **non-existent** entry fails loudly
(`CONFIG_ENTRY_UNRESOLVED`) even with a `|| ''` fallback — create entries
before uploading revisions that reference them.

| Entry | Example | Meaning |
|---|---|---|
| `NP_API_KEY` (secret) | — | Credential for every NP API call and agent dispatch |
| `NP_ORGANIZATION_ID` | `<org-id>` | Org id for item searches |
| `COST_PER_MILLICORE_HOUR` | `0.0000335` | Unit price. **Calibrated from the real bill** (wf6 / setup 05) |
| `COST_PER_MB_RAM_HOUR` | `0.00000455` | idem memory |
| `COST_AGENT_CMDLINE` | `nullplatform/platform-scopes-override/cost/collect_metrics --prom http://prometheus-server.default.svc.cluster.local` | Base collector command (repo-relative on the agent) + prom URL |
| `COST_AGENT_NRN` | `organization=<org>:account=<acct>` | Agent search NRN (account-level!) |
| `COST_AGENT_CLUSTER` | `<cluster-name>` | Agent tag `cluster` (subset match) |
| `COST_POD_MATCHERS_TEMPLATE` | `scope` | `scope` = script resolves the mapping; else raw-matchers template |
| `COST_K8S_NAMESPACE` | `<namespace>` | Namespace for the AI's PromQL matchers |
| `COST_ACCOUNT_ID` | `<acct-id>` | Account whose `cost_pricing` metadata records calibrations |
| `RIGHTSIZING_DEVIATION_PCT` | `50` | Over-provisioned when request ≥ usage × (1+pct/100) |
| `RIGHTSIZING_LOOKBACK_DAYS` | `14` | Analysis window |
| `RIGHTSIZING_CATEGORY_SLUG` | `finops-1` | Action-item category (global slugs can be taken — 03 records the REAL one) |
| `RIGHTSIZING_RESCAN_DAYS` | `15` | A scope with a conclusive scanner verdict is not re-analyzed for this many days (live items are still validated on every run, from tracker data) |
| `RIGHTSIZING_QA_MAX_REPLIES` | `10` | Max AI replies per action item (wf8 runaway brake) |
| `RIGHTSIZING_MIN_SAVINGS_BY_ENV` | `{"default":1,"production":5}` | USD/month floor to open an item |
| `RIGHTSIZING_MIN_CHANGE_PCT_BY_ENV` | `{"default":10,"production":25}` | Change smaller than this % AND <100mc/100MB → not worth acting |
| `RIGHTSIZING_TARGET_UTIL_BY_ENV` | `{"default":{"cpu":70,"mem":85,"basis":"avg"},"production":{"cpu":50,"mem":70,"cpu_basis":"p95_10m","mem_basis":"peak10m"}}` | **Policy ceilings + per-dimension sizing basis**: production CPU sizes on the p95 of 10-minute windows (compressible — deployment bursts are throttling, not capacity), production MEMORY on the observed max working set (not compressible), non-prod on averages. Single `basis` key = back-compat for both dims |
| `RIGHTSIZING_FLOORS_BY_ENV` | `{"default":{"cpu":50,"mem":64},"production":{"cpu":100,"mem":128}}` | Platform floors per environment — non-prod goes lower (tiny idle scopes pinned at 100/128 are real aggregate money). Verify the platform accepts sub-100mc specs before batch-applying non-prod |
| `RIGHTSIZING_MIN_REPLICAS_BY_ENV` | `{"default":1,"production":2}` | Replica floor — flagged as a reliability note, never auto-changed |
| `CPU_MIN_MILLICORES` / `MEM_MIN_MB` | `100` / `128` | Platform floors for recommendations |
| `CLUSTER_COSTING_CMDLINE` | `nullplatform/platform-scopes-override/cost/cluster_costing --prom …` | wf6 costing command |
| `CLUSTER_COST_CPU_RAM_RATIO` | `7.2` | $/vCPU : $/GB split (AWS-ish) |
| `DEPLOY_*` | see `../deploy/README.md` | Progressive-deploy knobs |

## Price calibration (wf6)

Unit prices live in TWO layers: the config entries (what wf1b bills with) and
the account-level `cost_pricing` catalog metadata (auditable, lake-visible
record: prices, monthly cost, fleet snapshot, method, timestamp — spec created
by `setup/05-account-pricing.sh`).

`wf6-cluster-cost-calibration` (monthly cron, day 2; manual anytime): runs
`cluster_costing` on the agent →

- **AWS Cost Explorer, `AmortizedCost`** of last month's
  `Amazon Elastic Compute Cloud - Compute`. Amortized is non-negotiable: with
  Savings Plans/RIs, `UnblendedCost` shows only the overflow — we measured it
  understate real compute cost by roughly 7×.
- Fleet from Prometheus (`kube_node_status_allocatable` averaged over the
  window) — no EC2 API needed.
- Split by `CLUSTER_COST_CPU_RAM_RATIO`, derive $/mc-h and $/MB-h.
- Guardrail: a derived price outside **[⅓×, 3×]** of the current entry is
  reported (`out_of_bounds`) and NOT applied; broken payloads report
  `invalid_data`. Applied runs update both layers.

AWS credentials go in the **agent's environment** (helm secret +
`--command-executor-env AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=…`), never in
workflows. Required IAM (read-only):

```json
{ "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Action": ["ce:GetCostAndUsage"], "Resource": "*" }] }
```

Without AWS access, run wf6 manually with `monthly_cost_override: <USD>`.

## Peak profile (why hourly averages are not enough)

An e-commerce scope doing 10× traffic at noon and nothing at 3am looks
half-idle on daily averages — and a right-sizing built on averages would
starve its peak. The suite therefore keeps TWO resolutions:

- **Prometheus is the fine-grain store** (its native retention, typically
  ~13 days): every analysis that needs sub-hourly data (the deterministic
  filter's 10m peaks, the AI's zoom-ins, the Q&A) queries it live.
- **The catalog preserves the SHAPE beyond retention**: every daily series
  point carries `cpu_mc_p95`, `cpu_mc_pk10m` (max of the 10-minute rolling
  average), `mem_mb_pk`, `cpu_mc_valley` (quietest hour with data) and
  `peak_hour`, next to the hourly usage/request totals and the
  `pods_min/max/avg` envelope. Tiny per day, 365 days of load profile.

Do NOT store per-minute series in the catalog — 1440 points/day per scope
explodes the instance and the lake for data Prometheus already has.

Uses of the peak data:
- **Production sizing** (`basis: "peak10m"` in `RIGHTSIZING_TARGET_UTIL_BY_ENV`):
  the request must fit the window's 10-minute peak inside the utilization
  ceiling (50% cpu / 70% mem by default). Dev keeps `basis: "avg"`.
- **Descale finding**: pods flat across the window (`pod_count_min ==
  pod_count_max`) while peak-to-average ≥ 2× → the scope never scales down,
  the quiet hours pay for peak capacity. Reported as an *Autoscaling* section
  on the item (+ `flat_replicas` metadata) with an AI note recommending an
  HPA review; right-sizing never changes replica counts itself.

## Right-sizing lifecycle

1. **Prefilter/router (phase 0, cheap — two NP API calls, no Prometheus)**:
   - **Live item + tracker healthy (7d avg both dims above threshold)** →
     the item is stale: close it with a reasoned comment, flag `optimal`.
     The item lifecycle runs on tracker data alone — no AI.
   - **Live item still backed by the data** → `active_valid`, keep it, do
     nothing (re-running the AI would reshuffle the same numbers).
   - **No item + `last_scan_at` fresher than `RIGHTSIZING_RESCAN_DAYS`** →
     skip (`prefiltered`): profiles don't change weekly, every full analysis
     costs an AI run.
   - **No item + ≥3 days of tracker history with BOTH dims healthy** → skip.
   - Anything else (no data, thin history, stale stamp, visible headroom) →
     full analysis. `force: true` bypasses everything.
2. **Deterministic filter**: 14d usage vs requests, per-env floors, savings
   caps, min-change rules, and the per-env **sizing basis** (peak10m vs avg).
3. **AI deep-dive** (Opus + `query_metrics` tool): mandatory verification
   protocol (peaks at ≤300s step over the full window, data coverage,
   throttling/restarts), evidence rules (every number cites its query, empty
   results are never evidence), `data_sufficiency` honesty, **per-instance
   sizing** from the hottest pod (never fleet sums), per-env utilization
   ceilings measured on the env's basis, replica-floor reliability note,
   autoscaling note when replicas are flat.
4. **Item lifecycle**: create (with ONE suggestion carrying the accept-form
   `deploy_timing`/`deploy_at`) / refresh on changed recommendation /
   **auto-close with a reasoned comment when the scope no longer qualifies**
   (`no_data` never closes — unmonitored ≠ fixed).
5. **Catalog flag + last-scan stamp**: `provisioning_status` on
   `cost_tracking` is a CONSEQUENCE of the item lifecycle (scanner-owned):
   live item → `over_provisioned` + `rightsizing_item_id`; closed or
   no-finding → `optimal`. Every conclusive verdict also stamps
   `last_scan_at`/`last_scan_status` (the rescan window's clock) plus a
   human-readable `last_scan_note` + `last_scan_savings_usd_month` — the
   "why is/isn't there a ticket here?" answer, on the scope page; `no_data`
   stamps nothing. Scopes whose hottest pod runs at ≥90% of its request are
   flagged `under_provisioned` (throttling/OOM risk) even with nothing to
   reclaim. The tracker only preserves these fields.
5b. **Portfolio**: findings below the ticket floor accumulate in ONE
   org-level item (label `rightsizing_portfolio`) with a per-scope table —
   entries enter on `below_min_savings`, leave when the scope resolves any
   other way, persist while skipped. The long tail is invisible one by one
   and real money in aggregate.
6. **Closer (wf7, weekly)**: for every scope whose tracker points at a live
   item, detects request changes (suggestion applied via `next-deploy`, or a
   manual edit: today's request differs >5% from the request recorded at
   analysis time in `observed_cpu_request_mc`/`observed_mem_request_mb`) and,
   after ≥3 days of post-change data, closes the loop: healthy → comment the
   realized before/after + saving and close; running hot (>90% or above the
   env ceiling) → close with a warning and flag `under_provisioned`; item
   already closed elsewhere → clean the stale pointer. Tracker data only —
   no Prometheus, no AI.
7. **Q&A (wf8, on comment)**: wf3 forwards every comment as a
   `rightsizing-command` signal; when NO apply execution is waiting (the
   signal answers non-2xx) and the author is human, wf3 hands the item to
   wf8. Deterministic guards (bot authors never get replies, the LAST
   comment must be human, `RIGHTSIZING_QA_MAX_REPLIES` cap), then an Opus
   analyst with the item's recorded numbers + the metrics tool decides
   `should_reply` and answers on the thread as `agent:rightsizing-qa` — in
   the language of the question, every number grounded in the item metadata
   or a fresh query.

## Setup runbook (new org)

Prereqs: cluster per the expectations above; the org's scope-overrides repo
carrying `cost/collect_metrics` + `cost/cluster_costing` (copy from
`scripts/`); agent mounting that repo.

```bash
cd workflows/cost/setup
export NP_API_KEY='<org apikey>'

./00-preflight.sh              # grants + active agents (tags!) + metadata API probe
./01-catalog-spec.sh           # scope-entity `cost_tracking` spec
./05-account-pricing.sh \      # account-entity `cost_pricing` spec (+ first calibration)
  --account <id> --price-cpu … --price-mem … --monthly-cost … --vcpu … --gb … --method "…"
./02-config-entries.sh \
  --agent-nrn 'organization=<org>:account=<acct>' \
  --agent-cluster '<cluster-name>' \
  --cmdline '<repo-path>/cost/collect_metrics --prom <prom-url>' \
  --matchers scope \
  --account-id <acct> \
  --price-cpu <calibrated> --price-mem <calibrated>
./03-category.sh --name FinOps # creates the category, records the REAL slug
cd ../../..
NP_API_KEY=$NP_API_KEY pnpm tsx workflows/cost/setup/04-upload-workflows.mjs
```

**Verify before activating anything** (all read-only except catalog writes):

1. **Mapping audit**: `--mode pods --scope <id>` via agent_command must list
   this scope's pods including dead ones from past deployments.
2. **Bounded tracker smoke**: execute the tracker with
   `{"inputs":{"nrn":"<one app's nrn>","date":"YYYY-MM-DD"}}` — expect
   `priced == scopes` for that app and a sane cost.
3. **Full tracker** for yesterday, then reconcile against the lake:

   ```sql
   -- POST /data/lake/query {"query":"… FORMAT JSONEachRow"}
   SELECT count(), round(sum(JSONExtractFloat(data,'cost_today')),2) AS cost,
          round(sum(JSONExtractFloat(data,'usage_cost_today')),2) AS used,
          round(sum(JSONExtractFloat(data,'waste_today')),2) AS waste
   FROM core_entities_metadata FINAL
   WHERE metadata_type='cost_tracking' AND _deleted=0
   ```

   `cost` must equal the tracker's `org_cost_day` exactly.
4. **Backfill**: run the tracker once per past date within Prometheus
   retention. Days before KSM's first sample price as usage-only — honest.
5. **Scanner once, manually** (creates real action items). Then activate
   aliases (04 prints the curls); crons only run via alias activation —
   deliberate. Activating `right_sizing_events` creates the NP notification
   channel with the ACTIVATING ACTOR's bearer — an org apikey may 401 there;
   use a personal token or widen the grant.

## Exploration playbook (adapting to a new cluster)

Everything the suite assumes can be verified — and adapted — **without cluster
credentials**: the agent gives you read-only `kubectl get/logs`, and
`kubectl get --raw` proxies HTTP GETs to in-cluster services (Prometheus
included) through the kube-apiserver. All commands below are
`POST /controlplane/agent_command`
with your `{nrn, selector}`; URL-encode PromQL (the exec validator rejects
`(){}` — percent-encoded is fine for `--raw`, base64 for the collector). The
walkthrough below is exactly how a real production cluster was mapped.

### Step 0 — find the agent

```bash
GET /controlplane/agent?nrn=organization=<org>:account=<acct>&limit=100&offset=…
# → ids, tags, last_heartbeat. Orgs with lambdas register MANY agents — paginate.
# The k8s agent's startup logs show which command repos it mounts + its tags:
{"command":{"type":"exec","data":{"cmdline":"nullplatform/scopes/k8s/kubectl_logs",
 "arguments":["<agent-pod>","-n","<agent-ns>","--tail","200"]}}
# Look for the heartbeat payload: tags + capabilities.commandexecutor.tags
# (repo → commit hash). `refresh-sources` re-pulls them.
```

### Step 1 — where do scopes run, and what do their pods look like?

```bash
# namespaces + pod names (both naming styles jump out immediately):
kubectl_get: ["pods","-A","-l","nullplatform=true","--no-headers"]
# labels of a couple of pods per style — confirm scope_id/deployment_id exist:
kubectl_get: ["pods","-n","<ns>","--show-labels","--no-headers"]
# container names (application vs sidecar) live in the pod spec or, later,
# in the `container` label of cAdvisor series.
```

### Step 2 — which Prometheus, and does it have what we need?

```bash
kubectl_get: ["svc","-A"]                    # grep prom/mimir/thanos/victoria
# Then query THROUGH the apiserver proxy (GET only, read-only):
kubectl_get: ["--raw","/api/v1/namespaces/<ns>/services/<svc>:<port>/proxy/api/v1/query?query=<urlencoded>"]
```

Checklist of queries (all URL-encoded):

| Question | Query |
|---|---|
| cAdvisor present? | `count(container_cpu_usage_seconds_total{namespace="<ns>"})` |
| KSM requests present? | `count(kube_pod_container_resource_requests{namespace="<ns>"})` |
| Do metric series carry scope labels? (usually NO) | `count(container_memory_working_set_bytes{scope_id!=""})` |
| Container names per style | `count by (container)(container_cpu_usage_seconds_total{namespace="<ns>",pod=~"<one scope's regex>",container!=""})` |
| Retention (nominal) | `--raw …/proxy/api/v1/status/flags` → `storage.tsdb.retention.*` |
| Retention (REAL — size caps trim early) | `count(container_memory_working_set_bytes{namespace="<ns>"} offset 13d)` at several offsets |
| KSM history vs cAdvisor history | same probe on `kube_pod_container_resource_requests` — expect it shorter after any KSM redeploy |
| Does the candidate pod regex match? | `count(container_memory_working_set_bytes{namespace="<ns>",pod=~"(d-<id>-\|.*-<id>-d-).*"})` |

### Step 3 — validate the mapping end to end

Once the collector script is on the agent (merge + `refresh-sources`):

```bash
cost/collect_metrics --prom <url> --mode pods    --scope <id> --start now-7d   # dead pods included?
cost/collect_metrics --prom <url> --mode metrics --scope <id>                  # metric families visible
cost/collect_metrics --prom <url> --mode day     --scope <id> --date <yesterday>
cost/collect_metrics --prom <url> --mode range   --scope <id> --days 13        # check coverage + request_points!
```

### Step 4 — reconcile totals before trusting anything

Cross-check three independent views; they must tell one story:

```bash
# a) Prometheus, namespace-wide (independent of any scope list):
sum(kube_pod_container_resource_requests{namespace="<ns>",resource="cpu"})     # requested cores
sum(rate(container_cpu_usage_seconds_total{namespace="<ns>",container!=""}[5m]))  # used cores
sum by (namespace)(kube_pod_container_resource_requests{resource="cpu"})       # who else requests (platform overhead)
sum(kube_node_status_allocatable{resource="cpu"}) / count(kube_node_info)      # fleet
# b) Per-pod → grouped by scope-id regex OUTSIDE prometheus: catches scopes the
#    lake filter misses (this is how we found more scopes running than listed).
sum by (pod)(kube_pod_container_resource_requests{namespace="<ns>",resource="cpu",container="application"})
# c) The bill: Cost Explorer **AmortizedCost** grouped by SERVICE (monthly) +
#    EC2-Other by USAGE_TYPE (EBS/NAT/transfer). Unblended lies under Savings Plans.
```

If `Σ requests ≈ allocatable` (commonly ~90%), the autoscaler is sizing nodes
from requests and the chargeback model is sound. The residual chain is:
`bill = Σ scope chargeback + platform namespaces + idle headroom`.

### Step 5 — after adapting, prove it with the runbook

Run the verification steps of the setup runbook above (mapping audit → bounded
tracker → lake reconciliation). If any number disagrees, stop and find out why
— every mismatch we hit had a real cause (KSM history, missing scope types,
selector pagination, spec strictness).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `AGENT_SELECTOR_NO_MATCH` with the agent clearly up | `COST_AGENT_NRN` must be account-level; also requires engine ≥ PR #84 (control-plane-side selector resolution) |
| `command validation failed: … encountered (` | Agent exec validator — regex/PromQL on the cmdline. Use `--scope` / `--promql-b64` |
| `command … not found in any allowed paths` | Agent hasn't pulled the overrides repo — dispatch `refresh-sources` |
| `AGENT_VALIDATION_FAILED "data.env" is not allowed` | An `np-agent-command` step without `inject_workflow_env: false` |
| `CONFIG_ENTRY_UNRESOLVED` | `${{ vars.X }}` references a non-existent entry — `\|\| ''` does NOT save you (loud by design) |
| Catalog write 400 `must NOT have additional properties` | Instance field missing from the spec schema — the metadata API validates strictly; update `01`/`05` and re-run |
| Metadata key rejected | Keys must match `^[a-z]+(_[a-z]+)*$` — `cost_tracking`, never `cost-tracking` |
| Scanner finds nothing on a clearly over-provisioned org | Check `request_points`/`request_now_*` in a range payload: short KSM history + an old collector (pre-avgnz) dilutes requests |
| Tracker `no_data` for scopes that exist | Non-k8s scope types (expected), pods in another namespace, or wrong matchers — audit with `--mode pods` |
| `org_cost_day` ≪ the bill | Reading the usage basis, or placeholder prices — calibrate (wf6 / setup 05); `cost_today` is the chargeback basis |
| Engine session token 401s mid-automation | `POST /token` tokens last ~1h — re-mint from the apikey |
| Fan-out summaries see odd item shapes | Real engine wraps child results as `{outputs: {...}, _childExecutionId}` — unwrap `r.outputs \|\| r` |

## Data-honesty notes

- Days before KSM's first sample bill as usage-only (requests unknown) — the
  series is honest, not wrong.
- Blue/green overlaps double-count on purpose in cost (both fleets consume);
  right-sizing uses per-pod stats so overlaps don't skew sizing.
- The platform gap (bill − Σ scopes) is real overhead: system namespaces,
  observability stacks, unallocated node headroom. Reporting it per account is
  the natural extension of wf6.
