# Cost (Finout + Datadog) — suite catalog-first

Suite de costos para organizaciones cuyos costos viven en **Finout** (multi-cloud)
y cuyo uso vive en **Datadog** — sin Prometheus ni agente en el cluster (a
diferencia de [`../cost`](../cost), que es la suite Prometheus/np-agent).
Primer despliegue: org **falabella** (987889794). Alcance inicial: **solo prod**
(los clusters preprod de NP no reportan a Datadog).

## Modelo de datos (catalog entities, no metadata)

Dos specs de catálogo, **separados a propósito** — hechos vs precios:

| Spec | Qué guarda | Instancia |
|---|---|---|
| `infrastructure_cost` | HECHOS de costo asignado a una entidad null: sujeto (`entity_type`/`entity_id`/`nrn`), dimensiones (cloud/country/environment), `infrastructure_reference` genérica (kind + id + attributes — cluster k8s hoy; DBs/caches/statics mañana), costo del día (`total/usage/waste`), uso vs reserva, serie diaria FIFO 365d | una por sujeto: `scope-<id>`, `service-<uuid>`, `cluster-<nombre>`, `shared-<categoría>-<dim>` |
| `blended_rate` | PRECIOS unitarios blended por cluster: `$ / core-hora` y `$ / GB-hora`, con su base auditable (costo Finout del cluster + networking, capacidad reservada Datadog) y serie diaria | una por cluster (`level: cluster`); agregados ponderados opcionales (`level: dimension`, id `dim-<cloud>-<country>-<env>`) |

`infrastructure_cost.rate_ref` apunta al `blended_rate` aplicado (= nombre del
cluster). El sujeto `cluster` permite reconciliar: Σ scopes del cluster + no
asignado ≈ costo del cluster en Finout.

Los JSON de los specs viven en [`specs/`](./specs) — incluyen
`schema.authorization` (sin eso las API keys reciben 403 sobre las instancias).

### Diseño del sujeto (pedido explícito)

`infrastructure_cost` es genérico y expandible: hoy se puebla con scopes y
clusters; mañana entran **services** (redis 95 / mongo-atlas 74 / postgres 37
activos en falabella), links, o costos compartidos, sin tocar el spec — solo
más valores de `entity_type`.

## Fuentes y mecánica

| Dato | Fuente | Cómo |
|---|---|---|
| Costo por cluster GKE | Finout API v2 | cost center `Kubernetes`, key `k8s_cluster` |
| Costo por cluster AKS | Finout API v2 | cost center `Azure`, key `resourcegroup` = `mc_<cluster>` (billing_enrichment) |
| Networking (LB/NAT/bandwidth) | Finout API v2 | `cloud_service` por cloud, atribución al cluster/dimensión |
| Allocation directa por scope | Finout API v2 | pod labels `label_scope_id` etc. — hoy SOLO clusters `cmrmx-*` GCP; sirve de reconciliación del blended |
| Uso/reserva por scope | Datadog API v1 query (org US1) | `kubernetes.cpu.requests`, `kubernetes.cpu.usage.total`, `kubernetes.memory.requests`, `kubernetes.memory.working_set` agrupadas `by {kube_deployment}` |
| scope_id desde Datadog | tag `kube_deployment` | codifica `<app>-<scope-name>-<scope_id>-d-<deployment_id>` → regex `-(\d+)-d-\d+$` (labels NP NO están mapeados a tags DD) |
| Mapeo scope→cluster | NP providers API | `GET /provider?nrn=organization=<org>&show_descendants=true` + `GET /runtime_configuration/{data_source.key}` → `values.k8s.clusterId`, resuelto por nivel de NRN × dimensiones |

Finout v2 es asíncrona: `POST /v2/data/cost-usage/generate-query` → poll
`/status` → `/results` (50 req/min, máx. 60 días por query, `timeInterval`
obligatorio, un solo `sortDirection` por request).

### Modelo de costo (heredado de ../cost, mismo iron rule)

- `cost.total_usd` (chargeback) = `max(usage, request)` valuado al blended rate — las reservas atan nodos.
- `cost.usage_usd` = consumo real × rate; `waste = total - usage`.
- Blended rate del cluster = (costo diario Finout del cluster + networking atribuible) ÷ (core-horas y GB-horas **reservadas** — la capacidad ociosa del cluster la pagan los que reservan, mismo criterio que el loading factor de la suite org-4).

## Workflows (plan)

| WF | Cron | Qué hace |
|---|---|---|
| `wf1-infra-map` | diario | lake (scopes activos + dimensiones) × providers API → upsert `infrastructure_cost` (sujeto+dimensiones+infra, sin montos) — el mapeo scope→cluster |
| `wf2-blended-rates` | diario | Finout (costo por cluster + networking) + Datadog (reservas del cluster) → upsert `blended_rate` por cluster |
| `wf3-scope-costs` | diario | Datadog por `kube_deployment` × `blended_rate` → montos+serie en `infrastructure_cost`; en clusters cmrmx reconcilia contra allocation directa Finout |
| `wf4-shared-costs` | semanal | LB/NAT/bandwidth/Datadog-cost no atribuible → sujetos `shared-*` por dimensión |

## Workflows desplegados (falabella, 2026-08-25)

| WF | id | alias | cron |
|---|---|---|---|
| wf1 `cost-finout-infra-map` | `wf_m6TkmEFyLvhh` | live | 03:10 UTC |
| wf1b `cost-finout-upsert-scope` (child) | `wf_2gSIis0J3QQz` | live | — |
| wf2 `cost-finout-blended-rates` | `wf_OHuzYdnOz1o-` | live | 04:10 UTC |
| wf2b `cost-finout-rate-cluster` (child) | `wf_UbxSTqKz9XS8` | live | — |

Specs de catálogo creados: `infrastructure_cost` (29cadade…), `blended_rate` (1ef46347…).

## Setup

```bash
# 1. Specs de catálogo — requiere principal admin (la API key de la suite NO
#    puede crear specs; sí escribe instancias una vez creados):
NP_TOKEN=<session bearer> ./setup/01-catalog-specs.sh

# 2. Config entries (secrets en path=/): COST_NP_API_KEY, FINOUT_CLIENT_ID,
#    FINOUT_SECRET_KEY, DD_API_KEY, DD_APPLICATION_KEY
#    (via /np-workflow config set NAME --path=/ --secret)
```

## Lecciones del engine pagadas por esta suite

- **Ids de step**: `^[A-Za-z_][A-Za-z0-9_]*$` — sin guiones.
- **`config.executionConfig.timeoutMs`** (máx 600000) — no `timeoutMs` a secas; el default de 60s mata cualquier code-exec con I/O real.
- **code-exec emite UN item** (`{result: array}` si devolvés array). Para fan-out los items tienen que venir de un plugin que emite filas: `np-lake-query` (una fila = un item) → `sub-workflow` (`iterateItems` default, `maxParallelism`). El `forEach:` de step está inerte en el engine desplegado; `metadata.fanOutPerItem` no aplica si el upstream emitió un solo item.
- **`sub-workflow.workflowId` necesita el `wf_…` id** (no resuelve client keys) y el alias del child tiene que EXISTIR: en este engine `PUT /aliases/:alias` NO crea (404) — crear con `POST /definitions/:id/aliases {name, revision}` + `activate`. El publish.sh del skill reporta "activated" sin haber creado el alias.
- **`conditional.config.expression`** va CRUDA (sin `${{ }}`): la resuelve el decider; si la interpolás llega un boolean y `validateConfig` la rechaza.
- **np-api-call**: credencial por config entry (`apiKey: "${{ secrets.X }}"`) — `apiKeySecretKey` va contra `ctx.secrets` legacy y falla en el worker. El query string va en `config.query`, NUNCA embebido en `path` (el `?` codificado da 502). `inputs` pisan `config` (por eso `path`/`body` dinámicos van por inputs).
- **Catálogo**: `PATCH /catalog/instances/{slug}/{id}?upsert=true` mergea A NIVEL TOP-LEVEL → cada workflow es dueño de sus campos top-level y no pisa los ajenos. El `{slug}` del path es el slug del spec (no el UUID).
- **Step reports >900KB se truncan** a `{__truncated, originalBytes}` en la API de estado — cosmético (el valor real sigue en el contexto), pero no cuentes con leer outputs grandes vía `/state`.

## Hechos verificados del entorno falabella (2026-08-25)

- ~40 clusters NP `<unidad>-np-<az|gcp>-<variante>-<región>-<prod|preprod>`; el cluster lo determina cuenta × cloud × country × environment.
- Gasto Finout total ~USD 2,1M/30d: Azure 824k / GCP 592k / OCI 470k / Datadog 206k.
- 353 clusters reportan al Datadog corporativo; **todos los NP prod están, ningún NP preprod**.
- Cobertura de parsing scope_id en DD: ~97-99% de las series (muestras: bfcl-gcp-beta 191 scopes, banco-cl AKS 277, cmrmx-az-alfa 97).
