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

## 6. Alcance de Finout y ubicación de bases/caches (preguntas de Gabriel)

### Finout ve SOLO Falabella Financiero
- Azure: 41 subscriptions, todas financiero (canales digitales, seguros,
  payments, peinau PCI, fif networking). Cero Sodimac/Tottus/retail.
- GCP: 775/805 proyectos con prefijo financiero; los 29 "opacos" (`pr-…`)
  resultaron ser los proyectos-conducto del marketplace de **MongoDB Atlas**
  (~$1,7k/día) — también financiero.
- OCI: Flexcube / core bancario.
- ⚠️ A verificar con Falabella: la factura de **Datadog** dentro de Finout
  (206k/mes) — el org DD es corporativo cross-negocio (reportan clusters de
  Sodimac/Tottus), así que financiero podría estar pagando observabilidad de
  otros negocios.

### Las subscriptions tienen MUCHO más que k8s
Ejemplos (USD/día): "canales digitales regional prod" 4.698 = VMs 1.785 +
storage 942 + SQL 463 + **GitHub 447** + MySQL 250 + bandwidth 188. "bfcl
prod" 4.425 = VMs 2.458 + storage 740 + MySQL 327 + **foundry models (IA)
208** + redis 145. "bfcl-lift-and-shift" = specialized compute 508. Los
clusters NP son ~$200/día de los ~$6.700 de la subscription bfcl prod.

### Dónde viven las bases y caches
| Dónde | USD/día | Detalle |
|---|---:|---|
| Azure "canales digitales regional prod" | 814 | SQL 463 + MySQL 250 + redis/postgres |
| Azure "canales digitales bfcl prod" | 601 | MySQL 327 + redis 145 + postgres 126 |
| Azure "seguros 2.0" | 410 | SQL 229 + postgres 167 |
| GCP MongoDB Atlas (marketplace, proyectos `pr-…`) | ~1.700 | **~50k/mes** — private offer 587 + PAYG 545 + 244 + … |
| GCP Cloud SQL (proyectos por app) | ~400 | quadrature 155, cvd 40, loyalty-ldr 34, … |
| NP services (ya mapeado §2/§3) | 163 | Azure redis+postgres 129 + GCP Memorystore 34 |

### Implicancia para la fase services
- Redis/PostgreSQL de NP: boundary limpio (rgs/cuentas dedicadas) → directo.
- **MongoDB Atlas (el gordo, ~50k/mes)**: los proyectos marketplace son
  opacos — la atribución por service NP (74 mongos activos) va a requerir la
  API de Atlas (costo por cluster Atlas) o tags del lado Atlas, no sale de
  Finout solo.

## 7. MongoDB Atlas: quién lo usa (cruce parámetros + services, lake)

Dos vías de consumo, complementarias:

**a) Vía services NP (governed)** — 74 services `mongo-atlas` activos, 130
links activos resueltos a apps: **67 clusters** (el nombre del service ≈
nombre del cluster Atlas), **25 compartidos entre 2+ apps**. Por cuenta:
fif 47, AtencionDigital 12, seguros 8. Top compartidos:
`fif-bfcl-cross-uat-gcp` (9 apps), `fif-bfpe-cross-uat` (8),
`fif-bfcl-ffmm-prod` (8), `atendig-bfcl-nova-uat` (4).

**b) Vía parámetros (conexión directa, sin service)** — 1.125 valores de
parámetros con match mongo; hosts Atlas extraídos (sin credenciales):
**64 clusters** con su project-id Atlas (p.ej. `checkout.azure` usado por 5
apps de seguros; `leads-production` por 4), **28 compartidos**. Por cuenta:
**seguros 45 apps** (casi todo directo, sin services), fif 13, BFCL-Local 2.
Además 84 apps con params mongo sin host Atlas (self-hosted / Cosmos / hosts
en params separados).

**Conclusión de asignación**: la TABLA app↔cluster ya existe por ambas vías
(seguros vive en params; fif/AtencionDigital en services). Para ponerle plata
a cada cluster falta la otra punta: el costo por cluster/proyecto de Atlas —
los cargos de marketplace en GCP son opacos (proyectos `pr-…`). Se resuelve
con la **API de Atlas** (invoices por organización → proyecto → cluster) o
tags en Atlas. Con eso: costo por cluster × tabla de consumo (repartido entre
las apps que lo comparten) = allocation completa de los ~$50k/mes de Atlas.
Pendiente: pedir API key de la org Atlas de falabella (read-only billing).

## 8. Unblended vs amortizado: la medida oficial es AMORTIZADO

Verificado empíricamente (ventana 7d):

| Corte | Unblended $/día | Amortizado $/día | Δ |
|---|---:|---:|---|
| VMs Azure sin resource group | 4.900 (74% de las VMs) | **434 (8%)** | las reservas se redistribuyen a los rgs que las consumen |
| Clusters NP AKS (mc_*) | 869 | **1.079** | **+24%** — los nodos consumen reservas; estábamos subestimando |
| Cuentas NP GCP | 996 | **830** | **-17%** — los projects pagan commitments que amortizado reparte |

Consecuencias:
1. **Toda la suite (wf2, reportes) usa `amortizedCost`** — es el criterio
   FinOps correcto para chargeback: quien consume la reserva paga la reserva.
2. Los blended rates por pool cambian: AKS sube ~24%, GCP baja ~17% — el
   spread entre pools se achica pero sigue siendo real.
3. El "gasto sin atribución" (~$437k/mes en unblended) se reduce
   drásticamente en amortizado — la navegación por cuenta pasa a cubrir ~92%+.

## 9. Logs por app (Datadog): allocation probada

Mecanismo: métrica `datadog.estimated_usage.logs.ingested_bytes by {service}`
(24h, 3.168 services) × cruce del `service` DD contra los app-slugs de NP del
lake (normalizando separadores y sufijos -cl/-pe/-prod…).

- Total org: **1,70 TB/día** de logs ingeridos.
- Matcheado a apps NP: **801 services = 172,9 GB/día = 10,2%** del total.
- Porción NP de la factura de logs DD (~$2.323/día): **≈ $237/día ≈ $7,1k/mes**.
- Top apps NP: `api-any-customer-information` 9,7 GB/día, `api-any-authify`
  7,6, `api-any-riskify` 6,0, `kco-bfcl-credit-card-additional-purchase-…` 5,8.
  Por cuenta: fif ~168 GB/día, seguros 4, BFCL-Local 0,8.
- 🔎 Los top loggers del org son de RETAIL (falabella-bu-cart 853 GB/día,
  bu-authn 646, manage-orders 586…) — refuerza la pregunta del contrato DD:
  financiero no debería absorber esa factura completa.

Automatizable: mismo patrón que el resto de la suite (una query DD diaria por
service + cruce con lake) → campo de costo de observabilidad por app en
`infrastructure_cost` (sujeto `application`), y la misma familia de métricas
`datadog.estimated_usage.*` cubre APM, infra hosts, custom metrics, etc.
