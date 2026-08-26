# Análisis de costos NP en falabella — agosto 2026

Análisis manual completo hecho ANTES de automatizar (2026-08-25). Fuentes:
Finout API v2 (costos, ventanas 7-14 días), Datadog org US1 (reservas/uso,
ns `nullplatform`), providers API + lake de NP. Todos los números en USD.

## 1. El número total y su composición

| Bucket | USD/día | ~USD/mes |
|---|---:|---:|
| **NP estricto — prod** (21 clusters `-np-`/`banco-cl-null-platform`) | 1.035 | 31,0k |
| **NP estricto — preprod** (25 clusters) | 425 | 12,8k |
| Compute GKE no capturado por labels (pe prod, cl local ×2) | ~111 | ~3,3k |
| **Subtotal NP estricto** | ~1.571 | **~47k** |
| Plataforma asociada: `fif-cd-tools` | 234 | 7,0k |
| Plataforma: `*-cross-*` (11 clusters) | 276 | 8,3k |
| Plataforma: `fif-monitoring` | 158 | 4,7k |
| Plataforma: `*-chat-*`, `integracion-delta`, `mercurio` | 280 | 8,4k |
| **Total "relacionado a null" en k8s** | ~2.520 | **~75k** — ver §3bis: con vista por cuenta sube a ~87k |

Reconcilia con el análisis paralelo de ~65k/mes: la diferencia entre 47k y 65k
es la plataforma asociada que se incluya.

## 2. GCP: la cuenta (project) es el boundary correcto

Existen **18 projects dedicados a NP**, patrón `bfa-{cl,pe,co}|cmr-mx` ×
`null-platforms|np-local|np-services` × `prod|preprod`. Total ~$1.040/día
(~31k/mes) — 100% atribuible a NP sin heurísticas.

### Asociación cuenta ↔ clusters (validada cruzando Compute vs cost center K8s)

| Cuenta | $/día | Compute | k8s-cc | Δ | clusters |
|---|---:|---:|---:|---:|---|
| bfa-cl-null-platforms-prod | 207,1 | 178,9 | 184,1 | -5 | bfcl-gcp-alfa + beta |
| bfa-pe-null-platforms-prod | 277,2 | 189,1 | **3,6** | **+185** ⚠️ | bfpe-gcp-alfa + beta |
| bfa-co-null-platforms-prod | 96,8 | 87,9 | 95,6 | -8 | bfco-gcp-alfa |
| cmr-mx-null-platforms-prod | 96,1 | 81,7 | 90,8 | -9 | cmrmx-gcp-alfa + beta |
| bfa-cl-np-local-prod | 36,3 | 32,4 | **1,8** | **+31** ⚠️ | bfcl-gcp-local |
| (preprods) | 282 | 217 | 215 | ≈0 | (pe preprod SÍ capturado) |

⚠️ = nodos facturados como Compute Engine **sin label de cluster** → el cost
center K8s de Finout solo ve el fee de management. El costo por CUENTA es
inmune a ese hueco. Fix para falabella: habilitar GKE cost allocation en
`bfa-pe-null-platforms-prod` y `bfa-cl-np-local-*`.

### Qué contiene una cuenta NP además del compute

Detalle `bfa-pe-null-platforms-prod` ($277/día): Compute 189 · **Logging 70** ·
Monitoring 9,5 · Networking 5,1 · GKE fee 3 · DNS 0,5.
Detalle `bfa-cl-null-platforms-prod` ($207/día): Compute 179 · Networking 13 ·
Monitoring 8 · GKE fee 3 · SQL 2 · Logging 1,2.

→ El "networking declarado" + observabilidad + fees son el 5-30% del costo de
la cuenta y NO aparecen en ningún cost center de k8s. Solo el corte por cuenta
los captura.

### 🔥 Anomalía: Cloud Logging en Perú

| Cuenta | Logging $/día | % del total de la cuenta |
|---|---:|---:|
| bfa-**pe**-null-platforms-**prod** | **69,9** | 29% |
| bfa-**pe**-null-platforms-preprod | 14,5 | 23% |
| bfa-cl-null-platforms-prod | 1,2 | <1% |
| resto de cuentas | ≤1 | ≤5% |

Perú loguea ~60× Chile con menos workloads → **~USD 2.500/mes de ahorro
probable** ajustando log sinks/exclusions. Primer action item natural de la
suite.

### Los services null ya tienen cuenta propia

`*-np-services-*` = **Cloud Memorystore Redis** (~$34/día ≈ 1k/mes, 8 cuentas).
La fase "costos de services" (redis 95 / mongo 74 / postgres 37 activos en NP)
tiene su boundary de facturación listo en GCP.

### Blended rate por pool de cuenta (prod, incluye TODO el costo de la cuenta)

| Pool | $/core-h | Nota |
|---|---:|---|
| bfa-cl (alfa+beta, 205 cores res.) | 0,042 | referencia |
| bfa-co (96 cores) | 0,042 | idéntico a CL |
| cmr-mx (51 cores) | 0,079 | baja densidad |
| bfa-pe (138 cores) | 0,084 | inflado por logging |
| bfa-cl-local (22 cores) | 0,069 | cluster chico |

vs ~0,027-0,032 que daba el cálculo solo-compute: el rate por cuenta es
~1,4-2× porque incluye el costo real total (headroom, observabilidad, red).
El spread entre pools (2×) confirma que un rate único org-wide mentiría.

## 3. Azure: el boundary es el resource group (verificado)

Las subscriptions son por unidad de negocio ("canales digitales bfcl
produccion", "seguros 2.0"…), NO por NP → el corte correcto es por
**resource group**. Tres familias NP:

| Familia | USD/día | ~USD/mes | Qué contiene |
|---|---:|---:|---|
| `mc_<cluster>` (46 rgs, prod+preprod) | 731 | 21,9k | Nodos + LBs + IPs + discos del cluster (AKS los agrupa ahí solo) |
| `*-null-platform-services-*` (16 rgs) | 129 | **3,9k** | **Los services null de Azure**: Redis cache + PostgreSQL + vnet, por unidad×env |
| `<cluster>` (rg propio del cluster) | ~40 | 1,2k | AKS fee ($1,5/día c/u) + Microsoft Defender + vnet |

- El "networking declarado" de Azure ya queda adentro: LBs/IPs en `mc_*`,
  vnets en el rg del cluster y en services.
- Espejo del hallazgo GCP: los **services** (redis/postgres) tienen rgs
  dedicados con naming limpio (`banco-cl-null-platform-services-eastus2-prod`:
  redis $20,5/día + postgres $0,8) — la fase services tiene boundary en ambos
  clouds, total services ≈ **$163/día ≈ 4,9k/mes** (Azure 3,9k + GCP 1k).

## 3bis. Total NP consolidado (con visión por cuenta/rg completa)

| | USD/día | ~USD/mes |
|---|---:|---:|
| GCP: 18 cuentas NP (compute+logging+monitoring+red+services) | 1.040 | 31,2k |
| Azure: rgs NP (nodos+LB+services+fees+defender) | 902 | 27,1k |
| **NP estricto TOTAL (prod+preprod, ambos clouds)** | **1.942** | **~58k** |
| + plataforma asociada k8s (cd-tools, cross, monitoring, chat…) | +953 | +28,6k |
| **Todo lo relacionado a null** | ~2.895 | **~87k** |

El ~65k del análisis paralelo ≈ NP estricto (58k) + monitoring (4,7k) ≈ 63k —
consistente; la vista por cuenta/rg le suma lo que ningún cost center de k8s
ve (logging, defender, fees, services, vnets).

## 4. Cobertura de señal (Datadog)

- 353 clusters reportan al DD corporativo; TODOS los clusters NP **prod**
  están; **ningún preprod NP** reporta (sin agente) → uso/allocation por scope
  solo es posible en prod; preprod queda a nivel cluster (12,8k/mes visibles
  solo por costo).
- ~475 scopes prod sin señal DD (clusters sin agente, fuera de NP k8s).
- `kube_deployment` codifica scope y deployment: `…-<scope_id>-d-<deploy_id>`
  (~97-99% parseable) — el cluster observado sale de la MISMA serie
  (`kube_cluster_name`), por eso el mapping scope→cluster es un side-effect
  gratis del pull de métricas.

## 5. Decisiones de diseño que salen de este análisis

1. **Fuente de costo GCP = cuenta (project)**, repartida entre sus clusters
   por reservas DD. Inmune a labels, incluye networking/logging/fees.
2. **Fuente de costo Azure = resource groups** (`mc_*` + los del cluster),
   sumados por cluster.
3. **Mapping scope→cluster = observado en Datadog** (decisión previa,
   reconfirmada: providers solo como descubrimiento).
4. **Guardrail de captura**: si el costo no cubre $0,005/core-h reservada,
   el rate no se emite (evita valuar con datos incompletos).
5. **Preprod y plataforma asociada**: registrarlos a nivel cluster
   (`entity_type: cluster` / `shared`) para que el total del catálogo cierre
   contra el número real (~65-75k), aunque no haya allocation por scope.
6. Logging/monitoring dentro del rate (parte del costo de la cuenta) — y
   además vigilados como anomalía propia (caso Perú).
