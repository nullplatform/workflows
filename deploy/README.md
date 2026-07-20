# Progressive Deploy (reutilizable)

Redeploy blue-green **narrado y verificado**, orquestado por un agente Opus.
Cualquier workflow que necesite re-desplegar un scope de forma segura
(right-sizing, cambios de config, rotación de AMI/base image…) invoca
`progressive_deploy` con un `scope_id` y un action item donde narrar.

## Diseño

- **Los tools definen qué PUEDE pasar; el agente decide CUÁNDO.** El agente
  solo tiene: `deploy_start`, `deploy_status`, `deploy_switch_traffic`,
  `deploy_finish` (finalize|cancel), `deploy_metrics` y `item_comment`.
  No hay passthrough genérico al API — el guardrail es duro.
- **El veredicto de degradación es determinístico**: `deploy_metrics`
  compara contra el baseline con los umbrales configurados y devuelve
  `degraded: true/false` + `problems[]` calculados en código. El agente
  narra y decide el momento; no juzga números.
- **Esperas sin microVM viva**: el agente termina su turno con
  `{action: "wait", wait_seconds}`; el grafo se estaciona en un
  `signal-wait` (timer de Temporal, señal `progressive-deploy-nudge` para
  empujarlo antes) y al despertar el paso del agente RE-ENTRA, retomando la
  MISMA conversación (`nodeContext` + `resumeSession`: la sandbox E2B queda
  pausada). Soaks de minutos u horas no cuestan cómputo.
- **Bloqueos narrados**: approvals, checklists y policies aparecen como
  rechazos HTTP o estados que no avanzan; los tools los interpretan
  (`blocked_reason`) y el agente los comenta textualmente y decide
  (esperar / abortar), dejando el item abierto.
- Cada tool call es una **ejecución hija** con nombre — trazabilidad
  completa en la UI de ejecuciones.

## Mecanismos verificados (auditados en producción)

- Crear: `POST /deployment {scope_id, release_id, description}` (release =
  la del último deployment finalizado — redeploy de LO QUE CORRE).
- Tráfico: `PATCH /deployment/:id {"strategy_data":{"desired_switched_traffic":N}}`
  → 204; `switched_traffic` se reconcilia async. Bajar el número NO revierte.
- Finalize: `PATCH {"status":"finalizing"}`; cancel/rollback:
  `PATCH {"status":"cancelling"}` (en este provider NO hay service actions;
  `instance_id` es null).
- Telemetría: `/telemetry/application/{app}/metric/http.rpm|error_rate|response_time`.

## Configuración (config entries en el folder `/deploy`)

| Entry | Default | Qué controla |
|---|---|---|
| `NP_API_KEY` (secret) | — | credencial de los tools |
| `DEPLOY_TRAFFIC_STEPS` | `10,50,100` | pasos de tráfico |
| `DEPLOY_STEP_WAIT_SECONDS` | `120` | soak entre pasos |
| `DEPLOY_MAX_ERROR_RATE_INCREASE` | `1` | pp de error rate sobre baseline |
| `DEPLOY_MAX_RESPONSE_TIME_RATIO` | `1.5` | ratio de response time vs baseline |
| `DEPLOY_PENDING_TIMEOUT_MINUTES` | `30` | presupuesto para estados gated/pending |

## Gotcha de engine (PR #81)

El `timeout` del `signal-wait` del loop usa `variables.*` a propósito: los
templates `vars.*`/`secrets.*` se difieren a la activity y un wait inline no
tiene activity — antes colgaba para siempre en silencio; desde PR #81 falla
con `PLUGIN_CONFIG_INVALID` explicando la alternativa.
