# Métricas: definiciones exactas

El dato base es el **hecho por scope y día** (spec `infrastructure_cost_daily`).
Todo lo demás se deriva **sumando** los hechos del corte que interese (app,
namespace, cuenta, rango de fechas) y dividiendo **al final**. Esa es la
propiedad que hace el modelo componible: no hay promedios de promedios.

## Campos del hecho (por scope, por día)

| Campo | Unidad | Cómo se construye |
|---|---|---|
| `cpu_req_core_h` | core-hora | Σ de las 24 medias horarias de `kubernetes.cpu.requests` del scope |
| `cpu_used_core_h` | core-hora | Σ de las 24 medias horarias de `kubernetes.cpu.usage.total` |
| `mem_req_gb_h` | GB-hora | ídem con `kubernetes.memory.requests` |
| `mem_used_gb_h` | GB-hora | ídem con `kubernetes.memory.working_set` |
| `cpu_p95_core` / `cpu_max_core` | cores | p95 y máximo de esas 24 medias horarias |
| `mem_p95_gb` / `mem_max_gb` | GB | ídem para memoria |
| `pods_min/max/avg` | pods | sobre las 24 medias horarias de `kubernetes.pods.running` |
| `requests_total` | requests | Σ del día de `nullplatform.scope.request_count` (tag `scope_id`) |
| `requests_source` | — | `nullplatform` cuando hay dato; `null` si el scope no reporta |

Las métricas de k8s se toman por `kube_deployment` y se atribuyen al scope
parseando el sufijo `-<scope_id>-d-<deployment_id>`; el cluster se deriva de
dónde aparecieron las series (mapping observado, detecta migraciones).

## Métricas derivadas

Con `H = 24 × días del período`:

| Métrica | Fórmula | Lectura |
|---|---|---|
| CPU reservada (cores prom.) | `Σ cpu_req_core_h / H` | cores simultáneos promedio, **no** acumulado |
| CPU usada (cores prom.) | `Σ cpu_used_core_h / H` | |
| CPU ociosa | `Σ (req − used) / H` | cores pagados y no usados |
| CPU % | `Σ used / Σ req` | utilización |
| **CPU alocada** | `Σ max(req, used) por scope-día / H` | lo que la app efectivamente le saca al cluster |
| **Req/día por core alocado** | `24 × Σ requests / Σ core-horas alocadas` | productividad; más alto = mejor |
| **Req/día por GB alocado** | `24 × Σ requests / Σ GB-horas alocadas` | ídem memoria |
| Req/día | `Σ requests / días` | |

`max(req, used)` es el mismo criterio que se usaba para chargeback: si un pod
"burstea" por encima de lo que pidió, igual ocupó ese recurso.

## Cuidados al leer

- **Promedios horarios**: un scope con picos de 3 cores y valles de 0,5 aparece
  con su media. Para dimensionar contra picos, mirar `p95` / `max`.
- **Scopes sin tráfico**: workers, batch y jobs no reciben requests. Las métricas
  de productividad se calculan **sólo sobre scopes con `requests_total > 0`**;
  el KPI *CPU sin tráfico HTTP* expone cuántos cores viven ahí.
- **Cobertura de requests**: `nullplatform.scope.request_count` cubre la flota,
  pero incluye scopes de todos los ambientes; los hechos son sólo prod.
- **Costos**: los campos `*_usd` existen en el hecho pero hoy se escriben `null`
  (los workflows de blended rate fueron dados de baja hasta afinar el rate).
