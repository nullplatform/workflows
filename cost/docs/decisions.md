# Cost & Right-Sizing — Design Decisions

The reasoning behind the system's shape, including the decisions we
REVERSED and why. Read [architecture.md](./architecture.md) first for the
map. Dates are 2026-07; most were validated live on a production EKS cluster.

## D1 — Chargeback bills `max(used, requested)` per hour

A scope pays for what it RESERVED — requests bind cluster nodes whether
used or not (Karpenter sizes nodes from requests: we measured ~90% of
allocatable driven by requests, used or not) — or for usage when it bursts
above its request. Computed hour by hour because replica counts change
within a day (100 pods at noon, 2 at midnight must both bill correctly).
Usage cost is kept alongside; the difference is the scope's waste, and
showing developers "you asked for 5×, you used 1×" is the strongest lever
the system has.

## D2 — Unit prices come from the real bill (AmortizedCost), monthly

Hardcoded prices drift. wf6 derives $/millicore-hour and $/MB-hour monthly
from AWS Cost Explorer using **AmortizedCost** — with Savings Plans,
UnblendedCost shows only the overflow (measured: a ~7× understatement of
real compute cost) — split ~7.2:1 vCPU:GB over the fleet from Prometheus
(no EC2 API needed). A guardrail rejects derived prices outside [⅓×, 3×] of the current
entry. AWS credentials live on the agent host, never in workflows; IAM is
`ce:GetCostAndUsage` only.

## D3 — Prometheus is the fine-grain store; the catalog stores the SHAPE

We deliberately do NOT store per-minute data in the catalog (1440 pts/day ×
dozens of scopes explodes the instance and the lake). Prometheus keeps ~13 days at
scrape resolution for every zoom-in; the daily series keeps per-day
`p95/peak10m/valley/peak_hour` + pods envelope for 365 days — the load
shape survives retention at negligible size. An e-commerce noon spike stays
visible a year later.

## D4 — Everything meets on scope metadata; integration plugins get no storage

The `cost_tracking` catalog instance is the single data spine: tracker
writes cost, scanner writes verdicts, closer verifies, the lake mirrors it
for dashboards. No new tables, no new APIs — invariant #1 of the engine
(domain-agnostic) applied to a full product.

## D5 — provisioning_status is a CONSEQUENCE of the item lifecycle

The scanner owns the flag; the tracker only preserves it. A naive daily
utilization classification flip-flops with traffic and erodes trust; a flag
that means "there is/was an open, AI-validated finding" is stable and
actionable. `under_provisioned` is set both by real findings (hottest pod
≥90% of its request — throttling/OOM risk) and by closer regressions.

## D6 — Deterministic filter first, AI second, evidence always

The AI (Opus) only runs on scopes that survived: tracker prefilter (2 API
calls) → 14-day deterministic filter → per-env savings floor. Its verdict
is bound by a mandatory protocol: peaks at fine step over the full window,
data-coverage check, throttling/restarts, every number citing its query,
`data_sufficiency` honesty (insufficient → genuine=false). We tried a
cheaper model here first — it ran one empty discovery query and invented
numbers. The verdict CREATES tickets humans act on; trust is worth more
than the price difference. Measured cost: a fraction of a dollar per deep-dive.

## D7 — Rescan economy: 15-day window + tracker-only item validation

Usage profiles don't change weekly, and every full analysis costs an AI
run. Every conclusive verdict stamps `last_scan_at/status`; scopes with a
fresh stamp are skipped. Scopes with a LIVE item are validated on every run
but from tracker data alone (healthy 7-day average → cheap close; still
backed → keep). Full-org steady state dropped from dozens of AI runs to a
handful per week.

## D8 — Production sizes CPU on p95-10m, memory on the observed max

`peak10m` as the CPU basis was our first choice and it was WRONG: the
absolute peak of a 14-day window is usually a deployment/startup burst, and
sizing for it inflated requirements past the configured request — killing
genuine candidates and even auto-closing 3 valid items (live, 2026-07-19).
CPU is compressible: brief throttling during an exceptional burst is
acceptable, so production CPU uses the **p95 of 10-minute windows** under
the 50% ceiling. Memory is NOT compressible: OOM kills, so it keeps the
observed maximum working set under the 70% ceiling. Non-prod sizes on
averages (70/85). Configured per dimension via
`RIGHTSIZING_TARGET_UTIL_BY_ENV` (`cpu_basis` / `mem_basis`).

## D9 — PER-POD everywhere (the fleet-vs-pod hydra) {#d9}

The single most repeated bug class of the build, found in FIVE places:
requests are per-pod config, but fleet sums (Σ across pods) move with the
autoscaler. Fleet-based math (a) made the closer read a 4→5 scale-up as
"1024MB → 1280MB, change applied!" and wrongly close 3 items; (b) made the
deterministic filter reject the top candidate because fleet peaks tracked
replica count (2→9 pods). Now: the collector exports the KSM per-pod
request and the hottest pod's p95-10m/peak; filter, recommendation,
min-change, item math and the closer's change detection all run per pod;
savings = per-pod delta × average replicas. Fleet sums survive only in the
pricing path, where they are correct. **Rule: if a number feeds a sizing
comparison, it is per-pod or it is a bug.**

## D10 — Ticket economics: per-env floors and a portfolio for the long tail

A ticket costs human attention: production items need ≥$5/month, others
≥$1 (`RIGHTSIZING_MIN_SAVINGS_BY_ENV`), plus a per-env minimum-change rule
(25% prod / 10% default). What falls below the floor is NOT discarded: it
accumulates in ONE org-level **portfolio item** (label
`rightsizing_portfolio`) with a per-scope table — individually invisible,
meaningful in aggregate, applied in batch during regular deploys.
Entries enter on `below_min_savings`, leave when the scope resolves any
other way, persist while skipped.

## D11 — Platform floors are per environment; quantization must reach them

Non-prod floors dropped to 50mc/64MB (prod keeps 100/128): dozens of tiny
idle scopes pinned at an oversized floor are real aggregate money (a
meaningful monthly total at the old floors). Recommendations quantize UP to multiples of 50
below 1000 (100 above) — with 100-quantization a 50mc floor is unreachable.
Caveat: verify the platform accepts sub-100mc specs before batch-applying.

## D12 — Production never auto-applies; apply is a spectrum elsewhere

Production items report only (no suggestion attached) — prod changes go
through the normal change process. Non-prod `web_pool_k8s` gets ONE
suggestion whose accept form offers `next-deploy` (config only) /
`scheduled` (nocturnal window) / `now`, executed by wf4 via the reusable
AI progressive deploy (baseline → 10/50/100% traffic with deterministic
degradation checks). Items close on VERIFIED outcomes only.

## D13 — Three closers, one rule: never close on missing data

wf4 closes what it deployed; the weekly closer closes what shipped through
regular deploys or manual edits — detecting the per-pod request change from
the tracker series (baseline anchored at the item's `detected_at`) and
commenting the REALIZED saving after ≥3 healthy days; the scanner
auto-closes findings that stopped being true. `no_data` and AI
"insufficient history" never close anything: unmonitored ≠ fixed.

## D14 — Comments are commands first, questions second

wf3 forwards every item comment as a `rightsizing-command` signal; if an
apply execution is waiting, the comment was a command (`deploy now` /
`abort`). The signal answering non-2xx (nobody waiting) is the
deterministic router to wf8: an Opus analyst with the item's recorded
numbers + the metrics tool answers questions on the thread, in the
question's language, every number grounded. Hard guards before any AI
spend: bot authors never get replies, the LAST comment must be human,
≤10 replies per item.

## D15 — Scanner verdicts are readable on the scope itself

`last_scan_note` + `last_scan_savings_usd_month` on the catalog instance
answer "why is/isn't there a ticket here?" without leaving the scope page:
"opportunity ~$<amount>/mo — see item <id>", "small opportunity below the ticket
floor — tracked in the portfolio", "AI discarded: insufficient metric
history", "hottest pod ≥90% of request — throttling risk".

## Engine lessons the suite paid for (fixed upstream)

- `case` decider: author-defined ports needed `dynamicOutputPorts` in graph
  validation AND in the Temporal sandbox's permissive lookup (two separate
  fixes; create-time passing while runtime fails is the trap signature).
- `case` config takes RAW expressions (no `${{ }}` — the engine resolves
  templates before the plugin sees them).
- Two edges from one decider into an any-join target run the target twice —
  converge through the case `default` port instead.
- A step with NO declared `inputs:` receives the upstream passthrough as
  `ctx.inputs`, and np-* plugins merge inputs OVER config: a set-variable's
  `path` output silently rewrote an np-api-call URL (`GET /result`) and the
  flag sync never ran in prod. **Every np-* step following set-variable /
  np-api-call declares at least one input (a "shield").**
- `refresh-sources` agent commands need `data: {}` — without it the agent
  errors internally but reports success, and sources silently never
  refresh.
- KSM series reset on pod recreation: request history is much shorter than
  cAdvisor history. Requests are config → `avgnz`/`lastnz` + coverage
  fields, and billing uses per-hour requests with graceful fallbacks.
