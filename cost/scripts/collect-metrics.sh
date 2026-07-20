#!/usr/bin/env bash
#
# collect-metrics.sh — Prometheus collector for the cost/right-sizing workflows.
#
# Runs ON THE AGENT HOST (dispatched via `POST /controlplane/agent_command`,
# command.type=exec). Prints ONE JSON document to stdout; anything diagnostic
# goes to stderr. Keep stdout small (<60KB): the agent channel truncates long
# lines on old guests.
#
# Requirements on the host: bash, curl, jq, and network access to Prometheus
# (default http://localhost:9090, override with --prom or PROM_URL env).
#
# Scope→pods mapping. Two ways to select the workload:
#   --scope <id> [--k8s-namespace <ns>] [--container application|all]
#       The script resolves the nullplatform scope to k8s objects itself.
#       It matches BOTH k8s scope styles by POD NAME, which is stable across
#       nullplatform deployments (each deploy recreates Deployment/Service,
#       so metric series come and go — but the scope id embedded in the pod
#       name survives, including for pods that no longer exist):
#         new style    : d-<scope_id>-<deployment_id>-<hashes>
#         legacy style : <slugs>-<scope_id>-d-<deployment_id><hashes>
#                        (names are truncated to 63 chars from the FRONT, so
#                        the "<scope_id>-d-" tail always survives)
#       Regex: pod=~"(d-<id>-|.*-<id>-d-).*"  — pod labels (scope_id etc.) are
#       NOT propagated to cAdvisor series, so name matching is the only join
#       that also covers dead pods.
#   --matchers '<raw label matchers>'
#       Explicit PromQL matchers (legacy interface; wins over --scope).
#
# Base64 twins (--matchers-b64, --promql-b64): the controlplane-agent exec
# validator rejects shell metacharacters like ( ) { } in the command line, and
# both PromQL and pod regexes need them. Callers going through that agent
# must base64-encode instead of quoting.
#
# --container (default: all for day/cost, application for range/right-sizing):
#   'application' = just the app container (what requested_spec sizes);
#   'all' = every container incl. the traffic sidecar (what the scope costs).
#
# Modes
#   --mode day   --date YYYY-MM-DD (--scope <id> | --matchers '...')
#       24 hourly buckets of avg cpu (millicores) and avg mem working set (MB)
#       for that UTC date, plus requests. Sums across ALL pods of the scope —
#       during a blue/green overlap both fleets count, which is correct for cost.
#
#   --mode range --days N (--scope <id> | --matchers '...') [--step 3600]
#       Hourly usage AND requests over the last N days (right-sizing input).
#       Adds per_pod stats (avg/p95/hottest pod), cpu throttling ratio,
#       container restarts and data coverage (retention here may be shorter
#       than the requested window — check coverage_pct before trusting avgs).
#
#   --mode pods  (--scope <id> | --matchers '...') [--start .. --end ..]
#       Pods that matched in the window (INCLUDING pods that no longer exist),
#       with first/last sample timestamps. Use to audit the scope→k8s mapping
#       and to see blue/green overlaps.
#
#   --mode metrics (--scope <id> | --matchers '...')
#       Metric names available for the scope's pods (discovery for the AI).
#
#   --mode query --promql '<expr>' [--start <unix|now-14d|-14d>] [--end <unix|now>] [--step 3600]
#       Free-form query_range passthrough for the AI analysis tool. Output is
#       Prometheus's result, capped: >2000 total samples → error asking for a
#       coarser step (keeps stdout bounded).
#
# Exit codes: 0 ok; 2 usage error; 3 Prometheus unreachable/query failed.

set -euo pipefail

PROM_URL="${PROM_URL:-http://localhost:9090}"
MODE="" DATE="" MATCHERS="" DAYS="14" STEP="3600" PROMQL="" START="" END=""
SCOPE="" K8S_NS="${COST_K8S_NAMESPACE:-default}" CONTAINER=""

usage() { grep '^#' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

# base64 decode, GNU (-d) and BSD/macOS (-D) flavors
b64d() { printf '%s' "$1" | base64 -d 2>/dev/null || printf '%s' "$1" | base64 -D; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)          MODE="$2"; shift 2;;
    --date)          DATE="$2"; shift 2;;
    --matchers)      MATCHERS="$2"; shift 2;;
    --matchers-b64)  MATCHERS="$(b64d "$2")"; shift 2;;
    --promql-b64)    PROMQL="$(b64d "$2")"; shift 2;;
    --scope)         SCOPE="$2"; shift 2;;
    --k8s-namespace) K8S_NS="$2"; shift 2;;
    --container)     CONTAINER="$2"; shift 2;;
    --days)          DAYS="$2"; shift 2;;
    --step)          STEP="$2"; shift 2;;
    --promql)        PROMQL="$2"; shift 2;;
    --start)         START="$2"; shift 2;;
    --end)           END="$2"; shift 2;;
    --prom)          PROM_URL="$2"; shift 2;;
    -h|--help)       usage;;
    *) echo "unknown argument: $1" >&2; usage;;
  esac
done

[[ -n "$MODE" ]] || usage

fail() { echo "{\"error\":\"$1\"}"; exit 3; }

# Resolve --scope into raw matchers unless the caller passed them explicitly.
if [[ -z "$MATCHERS" && -n "$SCOPE" ]]; then
  MATCHERS="namespace=\"${K8S_NS}\",pod=~\"(d-${SCOPE}-|.*-${SCOPE}-d-).*\""
fi

# Container filter. Default depends on mode: cost (day) wants everything the
# scope consumes; right-sizing (range) wants the app container only, because
# that is what the scope's requested_spec sizes.
if [[ -z "$CONTAINER" ]]; then
  case "$MODE" in
    range) CONTAINER="application";;
    *)     CONTAINER="all";;
  esac
fi
if [[ "$CONTAINER" == "all" ]]; then
  CFILTER='container!=""'
else
  CFILTER="container=\"${CONTAINER}\""
fi

now=$(date -u +%s)
# Relative time specs: now | now-14d | -14d | now-6h | -6h | unix | YYYY-MM-DD.
resolve_time() {
  local v="$1"
  case "$v" in
    ""|now) echo "$now";;
    now-*d|-*d) local n="${v//[!0-9]/}"; echo $((now - n * 86400));;
    now-*h|-*h) local n="${v//[!0-9]/}"; echo $((now - n * 3600));;
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
      date -u -d "$v 00:00:00" +%s 2>/dev/null || date -u -j -f "%Y-%m-%d %H:%M:%S" "$v 00:00:00" +%s;;
    *) echo "$v";;
  esac
}

# query_range helper: $1 expr, $2 start, $3 end, $4 step → raw prometheus JSON
qrange() {
  local out
  out=$(curl -fsS --max-time 60 "$PROM_URL/api/v1/query_range" \
    --data-urlencode "query=$1" \
    --data-urlencode "start=$2" \
    --data-urlencode "end=$3" \
    --data-urlencode "step=$4") || fail "prometheus unreachable at $PROM_URL"
  [[ "$(jq -r .status <<<"$out")" == "success" ]] || fail "query failed: $(jq -r .error <<<"$out" | head -c 200)"
  printf '%s' "$out"
}

# instant query helper: $1 expr, $2 time → raw prometheus JSON
qinstant() {
  local out
  out=$(curl -fsS --max-time 60 "$PROM_URL/api/v1/query" \
    --data-urlencode "query=$1" \
    --data-urlencode "time=$2") || fail "prometheus unreachable at $PROM_URL"
  [[ "$(jq -r .status <<<"$out")" == "success" ]] || fail "query failed: $(jq -r .error <<<"$out" | head -c 200)"
  printf '%s' "$out"
}

# instant query → single scalar value ("0" when the result is empty)
qival() { qinstant "$1" "$2" | jq -r '.data.result[0].value[1] // "0"'; }

# Extract the single-series values array [[t, "v"], ...] (sum() yields one
# series; no series → empty array).
values() { jq -c '[.data.result[0].values[]?]'; }

# Standard cAdvisor / kube-state-metrics expressions. The container filter
# drops the pause/aggregate rows; adjust here if a cluster exposes different
# metric names (this file is the single place PromQL lives).
cpu_usage_expr()  { echo "sum(rate(container_cpu_usage_seconds_total{${MATCHERS},${CFILTER}}[5m])) * 1000"; }
mem_usage_expr()  { echo "sum(container_memory_working_set_bytes{${MATCHERS},${CFILTER}}) / 1048576"; }
cpu_req_expr()    { echo "sum(kube_pod_container_resource_requests{${MATCHERS},${CFILTER},resource=\"cpu\"}) * 1000"; }
mem_req_expr()    { echo "sum(kube_pod_container_resource_requests{${MATCHERS},${CFILTER},resource=\"memory\"}) / 1048576"; }
# Per-pod views (single series each — aggregated across pods per timestep):
pods_count_expr() { echo "count(count by (pod)(container_memory_working_set_bytes{${MATCHERS},${CFILTER}}))"; }
cpu_pod_avg_expr(){ echo "avg(sum by (pod)(rate(container_cpu_usage_seconds_total{${MATCHERS},${CFILTER}}[5m]))) * 1000"; }
cpu_pod_max_expr(){ echo "max(sum by (pod)(rate(container_cpu_usage_seconds_total{${MATCHERS},${CFILTER}}[5m]))) * 1000"; }
mem_pod_avg_expr(){ echo "avg(sum by (pod)(container_memory_working_set_bytes{${MATCHERS},${CFILTER}})) / 1048576"; }
mem_pod_max_expr(){ echo "max(sum by (pod)(container_memory_working_set_bytes{${MATCHERS},${CFILTER}})) / 1048576"; }
throttle_expr()   { echo "sum(rate(container_cpu_cfs_throttled_periods_total{${MATCHERS},${CFILTER}}[5m])) / sum(rate(container_cpu_cfs_periods_total{${MATCHERS},${CFILTER}}[5m]))"; }
# 10-minute-window twins for peak profiling: hourly averages dilute traffic
# peaks (an e-commerce noon spike vanishes in a daily avg), so peaks/p95 are
# computed over 10m rolling windows via subqueries and stored alongside the
# hourly rollups. Prometheus stays the fine-grain store (its retention);
# these summaries preserve the SHAPE of the load beyond retention.
cpu_usage10_expr()   { echo "sum(rate(container_cpu_usage_seconds_total{${MATCHERS},${CFILTER}}[10m])) * 1000"; }
cpu_pod_max10_expr() { echo "max(sum by (pod)(rate(container_cpu_usage_seconds_total{${MATCHERS},${CFILTER}}[10m]))) * 1000"; }
mem_pod_max_expr2()  { echo "max(sum by (pod)(container_memory_working_set_bytes{${MATCHERS},${CFILTER}})) / 1048576"; }
# PER-POD requests (current config): fleet request sums move with the
# autoscaler's replica count and poison any sizing math — requests are
# per-pod CONFIG, and this is their true current value.
cpu_req_pp_expr()    { echo "avg(avg by (pod)(kube_pod_container_resource_requests{${MATCHERS},${CFILTER},resource=\"cpu\"})) * 1000"; }
mem_req_pp_expr()    { echo "avg(avg by (pod)(kube_pod_container_resource_requests{${MATCHERS},${CFILTER},resource=\"memory\"})) / 1048576"; }

case "$MODE" in
  day)
    [[ -n "$DATE" && -n "$MATCHERS" ]] || usage
    start=$(resolve_time "$DATE")
    end=$((start + 86400))
    cpu=$(qrange "$(cpu_usage_expr)" "$start" "$end" 3600 | values)
    mem=$(qrange "$(mem_usage_expr)" "$start" "$end" 3600 | values)
    # Requests too: usage vs requested is what makes the catalog series able
    # to answer both over- AND under-provisioning questions later.
    cpureq=$(qrange "$(cpu_req_expr)" "$start" "$end" 3600 | values)
    memreq=$(qrange "$(mem_req_expr)" "$start" "$end" 3600 | values)
    pods=$(qrange "$(pods_count_expr)" "$start" "$end" 3600 | values)
    # Peak profile of the day at 10m resolution (subqueries, instant at day
    # end): p95 + max of the fleet cpu 10m-avg, max memory working set.
    cpu_p95=$(qival "quantile_over_time(0.95, ($(cpu_usage10_expr))[1d:5m])" "$end")
    cpu_pk=$(qival "max_over_time(($(cpu_usage10_expr))[1d:5m])" "$end")
    mem_pk=$(qival "max_over_time(($(mem_usage_expr))[1d:5m])" "$end")
    jq -cn --argjson cpu "$cpu" --argjson mem "$mem" \
           --argjson cpureq "$cpureq" --argjson memreq "$memreq" \
           --argjson pods "$pods" \
           --arg cpu_p95 "$cpu_p95" --arg cpu_pk "$cpu_pk" --arg mem_pk "$mem_pk" \
           --arg date "$DATE" --argjson start "$start" '
      def byt: map({(.[0]|tostring): (.[1]|tonumber)}) | add // {};
      def r2: . * 100 | round / 100;
      def avgpos: map(select(. > 0)) | if length > 0 then (add / length | r2) else 0 end;
      ($cpu|byt) as $c | ($mem|byt) as $m | ($cpureq|byt) as $cr | ($memreq|byt) as $mr |
      ($pods|byt) as $pd |
      [range(0;24)] | map({
        h: .,
        cpu_mc: (($c[(($start + . * 3600)|tostring)] // 0) | r2),
        mem_mb: (($m[(($start + . * 3600)|tostring)] // 0) | r2),
        cpu_req_mc: (($cr[(($start + . * 3600)|tostring)] // 0) | r2),
        mem_req_mb: (($mr[(($start + . * 3600)|tostring)] // 0) | r2),
        pods: (($pd[(($start + . * 3600)|tostring)] // 0) | r2)
      }) as $hours |
      ([$hours[] | select(.pods > 0) | .pods]) as $podsnz |
      { mode: "day", date: $date,
        # Full hourly detail — usage AND requests AND pod count. Replica
        # scaling within the day is real data (100 pods one hour, 2 the
        # next): consumers bill/analyze hour by hour, never on daily
        # averages.
        hours: $hours,
        cpu_mc_hours: ([$hours[].cpu_mc] | add | r2),
        mem_mb_hours: ([$hours[].mem_mb] | add | r2),
        cpu_req_mc_hours: ([$hours[].cpu_req_mc] | add | r2),
        mem_req_mb_hours: ([$hours[].mem_req_mb] | add | r2),
        cpu_req_mc_avg: ([$hours[].cpu_req_mc] | avgpos),
        mem_req_mb_avg: ([$hours[].mem_req_mb] | avgpos),
        pods_min: ($podsnz | if length > 0 then min else 0 end),
        pods_max: ($podsnz | if length > 0 then max else 0 end),
        pods_avg: ($podsnz | avgpos),
        # 10m-resolution peak profile — daily averages hide traffic peaks;
        # this preserves the load SHAPE beyond Prometheus retention.
        cpu_mc_p95:    (($cpu_p95|tonumber) | r2),
        cpu_mc_pk10m:  (($cpu_pk|tonumber) | r2),
        mem_mb_pk:     (($mem_pk|tonumber) | r2),
        # Peak/valley hours of the day (hourly fleet cpu): the valley is the
        # quietest hour WITH data — pods flat while pk10m/valley is large
        # means the scope never scales down.
        peak_hour:     ([$hours[] | select(.cpu_mc > 0)] | if length > 0 then (max_by(.cpu_mc).h) else 0 end),
        cpu_mc_valley: ([$hours[] | select(.cpu_mc > 0) | .cpu_mc] | if length > 0 then (min | r2) else 0 end),
        samples: ([$hours[] | select(.cpu_mc > 0 or .mem_mb > 0)] | length) }'
    ;;

  range)
    [[ -n "$MATCHERS" ]] || usage
    end=$now
    start=$((end - DAYS * 86400))
    cpu=$(qrange "$(cpu_usage_expr)" "$start" "$end" "$STEP" | values)
    mem=$(qrange "$(mem_usage_expr)" "$start" "$end" "$STEP" | values)
    cpureq=$(qrange "$(cpu_req_expr)" "$start" "$end" "$STEP" | values)
    memreq=$(qrange "$(mem_req_expr)" "$start" "$end" "$STEP" | values)
    pods=$(qrange "$(pods_count_expr)" "$start" "$end" "$STEP" | values)
    cpupavg=$(qrange "$(cpu_pod_avg_expr)" "$start" "$end" "$STEP" | values)
    cpupmax=$(qrange "$(cpu_pod_max_expr)" "$start" "$end" "$STEP" | values)
    mempavg=$(qrange "$(mem_pod_avg_expr)" "$start" "$end" "$STEP" | values)
    mempmax=$(qrange "$(mem_pod_max_expr)" "$start" "$end" "$STEP" | values)
    thr=$(qrange "$(throttle_expr)" "$start" "$end" "$STEP" | values)
    restarts=$(qinstant "sum(increase(kube_pod_container_status_restarts_total{${MATCHERS}}[${DAYS}d]))" "$end" \
      | jq -c '[.data.result[0].value[1] // "0" | tonumber | floor] | .[0]')
    # 10m-resolution peaks over the whole window: production right-sizing is
    # sized against these (peak 10m avg within the utilization ceiling), not
    # against hourly averages that dilute traffic spikes.
    cpu_p95_10m=$(qival "quantile_over_time(0.95, ($(cpu_usage10_expr))[${DAYS}d:10m])" "$end")
    cpu_pk10m=$(qival "max_over_time(($(cpu_usage10_expr))[${DAYS}d:10m])" "$end")
    mem_pk=$(qival "max_over_time(($(mem_usage_expr))[${DAYS}d:10m])" "$end")
    hot_cpu_pk10m=$(qival "max_over_time(($(cpu_pod_max10_expr))[${DAYS}d:10m])" "$end")
    hot_cpu_p95_10m=$(qival "quantile_over_time(0.95, ($(cpu_pod_max10_expr))[${DAYS}d:10m])" "$end")
    hot_mem_pk=$(qival "max_over_time(($(mem_pod_max_expr2))[${DAYS}d:10m])" "$end")
    # Per-pod requests: current value (instant — requests are config).
    req_pp_cpu=$(qival "$(cpu_req_pp_expr)" "$end")
    req_pp_mem=$(qival "$(mem_req_pp_expr)" "$end")
    jq -cn --argjson cpu "$cpu" --argjson mem "$mem" \
           --argjson cpureq "$cpureq" --argjson memreq "$memreq" \
           --argjson pods "$pods" --argjson thr "$thr" \
           --argjson cpupavg "$cpupavg" --argjson cpupmax "$cpupmax" \
           --argjson mempavg "$mempavg" --argjson mempmax "$mempmax" \
           --argjson restarts "$restarts" \
           --arg cpu_p95_10m "$cpu_p95_10m" --arg cpu_pk10m "$cpu_pk10m" \
           --arg mem_pk "$mem_pk" \
           --arg hot_cpu_pk10m "$hot_cpu_pk10m" --arg hot_mem_pk "$hot_mem_pk" \
           --arg hot_cpu_p95_10m "$hot_cpu_p95_10m" \
           --arg req_pp_cpu "$req_pp_cpu" --arg req_pp_mem "$req_pp_mem" \
           --argjson days "$DAYS" --argjson step "$STEP" \
           --argjson start "$start" --argjson end "$end" '
      def byt: map({(.[0]|tostring): (.[1]|tonumber)}) | add // {};
      def r2: . * 100 | round / 100;
      def r4: . * 10000 | round / 10000;
      def p95: sort | if length == 0 then 0 else .[((length * 0.95)|floor) ] // .[-1] end;
      def avg: if length > 0 then (add / length) else 0 end;
      # Requests are config, not load: average only the points where the
      # series EXISTS. kube-state-metrics history can be much shorter than
      # cAdvisor history (e.g. after a KSM redeploy), and averaging the gaps
      # as zero understates requests and hides over-provisioning.
      def avgnz: map(select(. > 0)) | avg;
      def lastnz: map(select(. > 0)) | if length > 0 then .[-1] else 0 end;
      ($cpu|byt) as $c | ($mem|byt) as $m | ($cpureq|byt) as $cr | ($memreq|byt) as $mr |
      ([$cpu[][0]] | unique) as $ts |
      ($ts | map({ t: .,
        cpu_mc:     (($c[(.|tostring)] // 0) | r2),
        cpu_req_mc: (($cr[(.|tostring)] // 0) | r2),
        mem_mb:     (($m[(.|tostring)] // 0) | r2),
        mem_req_mb: (($mr[(.|tostring)] // 0) | r2) })) as $points |
      ([$cpupavg[] | .[1]|tonumber] ) as $cpa |
      ([$cpupmax[] | .[1]|tonumber] ) as $cpm |
      ([$mempavg[] | .[1]|tonumber] ) as $mpa |
      ([$mempmax[] | .[1]|tonumber] ) as $mpm |
      ([$pods[]    | .[1]|tonumber] ) as $pc |
      ([$thr[]     | .[1]|tonumber] ) as $th |
      { mode: "range", days: $days, step: $step, points: $points,
        summary: {
          cpu: { avg_usage_mc:   ([$points[].cpu_mc]     | avg | r2),
                 avg_request_mc: ([$points[].cpu_req_mc] | avgnz | r2),
                 request_now_mc: ([$points[].cpu_req_mc] | lastnz | r2),
                 p95_usage_mc:   ([$points[].cpu_mc]     | p95 | r2),
                 # Fleet peaks at 10m resolution over the window — the
                 # capacity numbers production sizing works from.
                 p95_10m_mc:     (($cpu_p95_10m|tonumber) | r2),
                 peak10m_mc:     (($cpu_pk10m|tonumber) | r2) },
          mem: { avg_usage_mb:   ([$points[].mem_mb]     | avg | r2),
                 avg_request_mb: ([$points[].mem_req_mb] | avgnz | r2),
                 request_now_mb: ([$points[].mem_req_mb] | lastnz | r2),
                 p95_usage_mb:   ([$points[].mem_mb]     | p95 | r2),
                 peak_mb:        (($mem_pk|tonumber) | r2) } },
        per_pod: {
          pod_count_avg: ($pc | avg | r2),
          pod_count_min: ([$pc[] | select(. > 0)] | if length > 0 then min else 0 end),
          pod_count_max: ($pc | if length > 0 then max else 0 end),
          # Current PER-POD requests (config truth — fleet sums move with
          # the autoscaler and poison sizing math).
          req_cpu_mc: (($req_pp_cpu|tonumber) | r2),
          req_mem_mb: (($req_pp_mem|tonumber) | r2),
          cpu: { avg_mc: ($cpa | avg | r2), p95_mc: ($cpa | p95 | r2),
                 hot_avg_mc: ($cpm | avg | r2), hot_p95_mc: ($cpm | p95 | r2),
                 hot_peak10m_mc: (($hot_cpu_pk10m|tonumber) | r2),
                 hot_p95_10m_mc: (($hot_cpu_p95_10m|tonumber) | r2) },
          mem: { avg_mb: ($mpa | avg | r2), p95_mb: ($mpa | p95 | r2),
                 hot_avg_mb: ($mpm | avg | r2), hot_p95_mb: ($mpm | p95 | r2),
                 hot_peak_mb: (($hot_mem_pk|tonumber) | r2) } },
        health: {
          cpu_throttle_ratio_avg: ($th | avg | r4),
          restarts_in_window: $restarts },
        coverage: {
          window_start: $start, window_end: $end,
          first_sample: (if ($points|length) > 0 then $points[0].t else null end),
          last_sample:  (if ($points|length) > 0 then $points[-1].t else null end),
          expected_points: ((($end - $start) / $step) | floor),
          actual_points: ($points | length),
          request_points: ([$points[].cpu_req_mc, $points[].mem_req_mb] | map(select(. > 0)) | length),
          coverage_pct: (if ($end - $start) > 0
            then (($points|length) * 100 / ((($end - $start) / $step))) | r2
            else 0 end) } }'
    ;;

  pods)
    [[ -n "$MATCHERS" ]] || usage
    s=$(resolve_time "${START:-now-14d}")
    e=$(resolve_time "${END:-now}")
    # count by(pod) over the window: one series per pod that EVER matched,
    # including pods whose objects are long gone. Bounded to 300 pods.
    out=$(qrange "count by (pod)(container_memory_working_set_bytes{${MATCHERS},${CFILTER}})" "$s" "$e" 3600)
    jq -c --argjson s "$s" --argjson e "$e" '
      def style: if (.|test("^d-[0-9]+-")) then "new" else "legacy" end;
      [.data.result[] | {
        pod: .metric.pod,
        style: (.metric.pod | style),
        first_seen: (.values | first | .[0]),
        last_seen:  (.values | last  | .[0]),
        alive_now:  ((.values | last | .[0]) >= ($e - 7200))
      }] | sort_by(.first_seen) | .[0:300] as $pods |
      { mode: "pods", window_start: $s, window_end: $e,
        pod_count: ($pods|length), pods: $pods }' <<<"$out"
    ;;

  metrics)
    [[ -n "$MATCHERS" ]] || usage
    out=$(curl -fsS --max-time 60 -G "$PROM_URL/api/v1/label/__name__/values" \
      --data-urlencode "match[]={${MATCHERS}}") || fail "prometheus unreachable at $PROM_URL"
    [[ "$(jq -r .status <<<"$out")" == "success" ]] || fail "label query failed"
    jq -c '{mode: "metrics", count: (.data|length), metrics: .data[0:500]}' <<<"$out"
    ;;

  query)
    [[ -n "$PROMQL" ]] || usage
    s=$(resolve_time "${START:--24h}")
    e=$(resolve_time "${END:-now}")
    out=$(qrange "$PROMQL" "$s" "$e" "$STEP")
    samples=$(jq '[.data.result[].values | length] | add // 0' <<<"$out")
    if [[ "$samples" -gt 2000 ]]; then
      fail "result too large ($samples samples) — use a coarser --step or shorter range"
    fi
    jq -c '{mode: "query", result: .data.result}' <<<"$out"
    ;;

  *) usage;;
esac
