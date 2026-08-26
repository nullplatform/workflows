#!/usr/bin/env python3
"""Migra infrastructure_cost (docs con daily[]) -> infrastructure_cost_daily (hechos planos).
Idempotente: PATCH upsert por id <entity>-<dia>. Corre con COST/NP_API_KEY (grants de instancias)."""
import json, os, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

NP = "https://api.nullplatform.com"
key = os.environ.get("COST_NP_API_KEY") or os.environ["NP_API_KEY"]
req = urllib.request.Request(NP + "/token", method="POST",
    headers={"Content-Type": "application/json"}, data=json.dumps({"apikey": key}).encode())
TOK = json.load(urllib.request.urlopen(req, timeout=30))["access_token"]
H = {"Authorization": "Bearer " + TOK, "Content-Type": "application/json"}

def get(path):
    with urllib.request.urlopen(urllib.request.Request(NP + path, headers=H), timeout=60) as r:
        return json.load(r)

# 1) bajar todas las instancias resumen
rows, off = [], 0
while True:
    res = get(f"/catalog/instances/infrastructure_cost?limit=100&offset={off}")["results"]
    rows += res
    if len(res) < 100: break
    off += 100
print(f"instancias resumen: {len(rows)}", flush=True)

def etype(iid):
    if iid.startswith("scope-"): return "scope"
    if iid.startswith("service-"): return "service"
    if iid.startswith("cluster-"): return "cluster"
    if iid.startswith("svc-pool-"): return "shared"
    return "shared"

def facts_of(inst):
    iid = str(inst.get("id"))
    dims = inst.get("dimensions") or {}
    ref = inst.get("infrastructure_reference") or {}
    base = {
        "entity_type": etype(iid),
        "entity_id": inst.get("entity_id"), "entity_name": inst.get("entity_name"),
        "application_id": inst.get("application_id"), "application_name": inst.get("application_name"),
        "namespace_id": inst.get("namespace_id"), "namespace_name": inst.get("namespace_name"),
        "account_id": inst.get("account_id"), "account_name": inst.get("account_name"),
        "nrn": inst.get("nrn"),
        "cluster": inst.get("rate_ref") or (ref.get("id") if ref.get("kind") == "k8s_cluster" else None),
        "cloud": dims.get("cloud"), "country": dims.get("country"), "environment": dims.get("environment"),
    }
    out = []
    for e in inst.get("daily") or []:
        if not e or not e.get("d"): continue
        r = e.get("resources") or {}
        cpu, mem, pods = r.get("cpu") or {}, r.get("mem") or {}, r.get("pods") or {}
        f = dict(base)
        f.update({
            "id": f"{iid}-{e['d']}", "d": e["d"],
            "allocation": e.get("allocation"),
            "cost_usd": e.get("cost_usd"), "usage_usd": e.get("usage_usd"), "waste_usd": e.get("waste_usd"),
            "cpu_cost_usd": cpu.get("billed_usd"), "mem_cost_usd": mem.get("billed_usd"),
            "cpu_usage_usd": cpu.get("usage_usd"), "mem_usage_usd": mem.get("usage_usd"),
            "cpu_req_core_h": cpu.get("reserved"), "cpu_used_core_h": cpu.get("used"),
            "cpu_p95_core": cpu.get("p95"), "cpu_max_core": cpu.get("max"),
            "mem_req_gb_h": mem.get("reserved"), "mem_used_gb_h": mem.get("used"),
            "mem_p95_gb": mem.get("p95"), "mem_max_gb": mem.get("max"),
            "pods_min": pods.get("min"), "pods_max": pods.get("max"), "pods_avg": pods.get("avg"),
            "rate_cpu_usd_core_h": cpu.get("rate_usd_per_unit"), "rate_mem_usd_gb_h": mem.get("rate_usd_per_unit"),
        })
        out.append(f)
    return out

facts = []
for inst in rows:
    facts += facts_of(inst)
print(f"hechos a migrar: {len(facts)}", flush=True)

ok = err = 0
errors = []
def upsert(f):
    global ok, err
    body = json.dumps(f).encode()
    for attempt in (1, 2):
        try:
            r = urllib.request.Request(f"{NP}/catalog/instances/infrastructure_cost_daily/{f['id']}?upsert=true",
                method="PATCH", headers=H, data=body)
            urllib.request.urlopen(r, timeout=30).read()
            ok += 1
            return
        except Exception as e:
            if attempt == 2:
                err += 1
                if len(errors) < 5: errors.append(f"{f['id']}: {e}")
            else:
                time.sleep(1)

t0 = time.time()
with ThreadPoolExecutor(max_workers=25) as ex:
    for i, _ in enumerate(ex.map(upsert, facts)):
        if (i + 1) % 5000 == 0:
            print(f"{i+1}/{len(facts)} ({ok} ok, {err} err, {int(time.time()-t0)}s)", flush=True)
print(f"FIN: {ok} ok, {err} err en {int(time.time()-t0)}s", flush=True)
for e in errors: print("  ", e, flush=True)
