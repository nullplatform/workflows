# Config Entries: Secrets & Variables

Workflow-scoped and folder-scoped configuration — API tokens, base URLs,
shared constants — managed outside workflow definitions. Definitions in git
carry **references only**; values live in the Nullplatform storage API and
never touch the workflow-system database, logs, or the hosted runtime's history.

## Concepts

| | Secret (`secret: true`) | Variable (`secret: false`) |
|---|---|---|
| Expression | `${{ secrets.NAME }}` | `${{ vars.NAME }}` |
| Redaction | Always (`<redacted>` in logs, step outputs, execution record) | Never |
| Read-back via API/editor | **No** — write-only, replace-only | Yes |
| Backend | NP storage API | NP storage API (same mechanism) |

The two expression namespaces are disjoint on purpose: `secrets.*` always
implies redaction, so a secret can never leak by being referenced through
the wrong root.

### Scopes and precedence

An entry lives at exactly one **scope**: a workflow (`wf_…` id) or a folder
path (the workflow sidebar tree: `/`, `/jira`, `/jira/legacy`). Resolution
walks up, first match wins:

```
workflow  →  deepest folder  →  ancestor folders  →  /   (org-wide)
```

Example: `JIRA_TOKEN` set at `/jira` is visible to every workflow under
`/jira/**`; a workflow-scoped `JIRA_TOKEN` overrides it for that workflow
only. Moving a workflow to another folder changes what it sees — that is
the intended behavior.

The same name at two places is **shadowing, not merging**: both entries
keep existing, and each workflow sees exactly one winner (the most
specific place on its chain). The ancestors view
(`GET /workflows/config?workflow=…&ancestors=true` or the editor's secrets
panel) marks each row `effective: true|false`, so shadowing is never
guesswork.

### Names

`^[A-Za-z_][A-Za-z0-9_]{0,127}$` — e.g. `JIRA_TOKEN`, `BASE_URL`.

## Using entries in a workflow

```yaml
steps:
  create_issue:
    type: module
    pluginType: http-request
    config:
      url: "${{ vars.JIRA_BASE_URL }}/rest/api/3/issue"
      headers:
        authorization: "Bearer ${{ secrets.JIRA_TOKEN }}"
```

- Publishing a definition that references an entry not yet set at any
  visible scope succeeds with a **warning** (`CONFIG_ENTRY_UNRESOLVED`) on
  the publish response — set the value and re-run; no republish needed.
- At runtime a missing **referenced** entry fails the step (local) or the
  execution start (declared `secrets:`) with a clear error naming the entry.
  Never a silent `undefined`.

## Managing entries

Management calls authenticate against THIS API with your session bearer;
authorization happens at the engine's permission layer. The NP storage
calls themselves use the ENGINE credential (`WORKFLOW_NP_STORAGE_API_KEY`)
— the storage API is internal-only, so no per-user NP storage grants are
needed.

Entries are addressed by a server-minted opaque id (`cfg_…`); the pair
(name, place) is unique, where the place is a folder `path` XOR a
`workflow` ref.

### Set (create or rotate) — idempotent upsert

```bash
# a shared secret for everything under /jira
curl -sf -X POST "$ENGINE/workflows/config" \
  -H "Authorization: Bearer $NP_SESSION_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"JIRA_TOKEN","value":"'"$JIRA_TOKEN"'","secret":true,"path":"/jira"}'
# → 201 {"id":"cfg_x1y2z3…","name":"JIRA_TOKEN","path":"/jira","mode":"created"}

# a plain variable at the org root
curl -sf -X POST "$ENGINE/workflows/config" \
  -H "Authorization: Bearer $NP_SESSION_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"JIRA_BASE_URL","value":"https://acme.atlassian.net","secret":false,"path":"/"}'

# workflow-scoped override (accepts the wf_ id or the client key)
curl -sf -X POST "$ENGINE/workflows/config" \
  -H "Authorization: Bearer $NP_SESSION_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"JIRA_TOKEN","value":"'"$OTHER_TOKEN"'","secret":true,"workflow":"wf_abc123def456"}'
```

Re-running the same `POST` with a new value **rotates** in place (200,
`mode: "updated"`; the `id` never changes). You can also rotate by id:
`PATCH /workflows/config/:id {"value": "…"}`. The `secret` flag and the
`name` are immutable — changing them requires delete + recreate.

### List / inspect

Every listing takes exactly one place — and each GET has ONE semantic:

```bash
# entries DEFINED at one folder (secret values are NEVER returned)
curl -s "$ENGINE/workflows/config?path=/jira" -H "Authorization: Bearer $NP_SESSION_TOKEN"

# entries DEFINED at one workflow
curl -s "$ENGINE/workflows/config?workflow=wf_abc123def456" -H "Authorization: Bearer $NP_SESSION_TOKEN"

# the whole chain a workflow sees (its scope + folder ancestors + /):
# every row carries its origin place and effective=true|false (winner vs shadowed)
curl -s "$ENGINE/workflows/config?workflow=wf_abc123def456&ancestors=true" \
  -H "Authorization: Bearer $NP_SESSION_TOKEN"
# → {"data":[{"id":"cfg_…","name":"JIRA_TOKEN","secret":true,"path":"/jira","effective":true}, …]}

# ancestors also works on the path axis (/jira/legacy → /jira → /)
curl -s "$ENGINE/workflows/config?path=/jira/legacy&ancestors=true" \
  -H "Authorization: Bearer $NP_SESSION_TOKEN"

# one entry by id
curl -s "$ENGINE/workflows/config/cfg_x1y2z3aaaa" -H "Authorization: Bearer $NP_SESSION_TOKEN"
```

### Delete

```bash
curl -sf -X DELETE "$ENGINE/workflows/config/cfg_x1y2z3aaaa" \
  -H "Authorization: Bearer $NP_SESSION_TOKEN"
```

## Where values actually live (storage & authorization)

Every entry is its own item in the NP storage API — an anonymous
`{id, nrn, value}` triple. NP items have **no name**: the mapping
`name + scope → item` lives exclusively in the engine's pointer table
(`config_entries`), which contains no values. Treat the engine database
backup as part of the secret-store DR story: without the pointers, items
are unidentifiable (though still readable).

Items are created under a **scoped NRN** matching the entry's scope:

| Entry scope | Storage item NRN |
|---|---|
| workflow `wf_abc` | `organization=<org>:workflow=wf_abc` |
| folder `/jira` | `organization=<org>:workflow_path=2f6a697261` (hex of the path) |
| root `/` | `organization=<org>:workflow_path=root` |

Consequences:

- The engine's org-level grant covers all items via NP's NRN hierarchy
  walk, and **finer grants are now possible** — a credential can be
  granted `storage:read` on a single workflow's or folder's NRN.
- `GET /storage?nrn=…` on the storage API lists exactly one scope's items.
- Folder paths are hex-encoded because NRN values must be plain
  alphanumeric tokens.
- Entries created before the scoped NRNs (bare `organization=<org>`) keep
  working and **migrate automatically on their next rotation**
  (upgrade-on-write: re-created under the scoped NRN, pointer repointed).

## IaC / GitOps

Definitions reference entries by name, so the existing
workflows-as-code flow (`PUT /workflows/definitions/<key>`) is untouched —
republishing never touches values. Provision the entries themselves with an
idempotent bootstrap script per environment; values come from your CI
secret store, never from the repo:

```bash
#!/usr/bin/env bash
# bootstrap-config.sh — safe to re-run; creates or rotates every entry.
set -euo pipefail
ENGINE="https://workflows.example.com"
put() { # name secret path value
  curl -sf -X POST "$ENGINE/workflows/config" \
    -H "Authorization: Bearer $NP_SESSION_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"$1\",\"value\":$(printf '%s' "$4" | jq -Rs .),\"secret\":$2,\"path\":\"$3\"}" > /dev/null
  echo "✓ $1 @ $3"
}

put JIRA_BASE_URL false /       "https://acme.atlassian.net"   # visible everywhere
put JIRA_TOKEN    true  /jira   "$CI_JIRA_TOKEN"               # only /jira/**
put SLACK_TOKEN   true  /alerts "$CI_SLACK_TOKEN"
```

Order does not matter relative to publishing: publish first ⇒ warnings on
the response; bootstrap first ⇒ clean publish. Execution requires the
entries to exist either way.

## Runtime plumbing (what runs where)

- **Local executor**: entries resolve in-process at execution start;
  secret values are registered with the redacting log store.
- **Hosted runtime**: the workflow sandbox NEVER sees values — `${{ secrets.X }}`
  templates pass through verbatim and each activity late-resolves them via
  `GET /workflows/executions/:id/config`, authenticated with the execution's service token
  (claims = workflow + org; capability `config:read`). Values are scrubbed
  from step logs and results before anything returns to execution history.
- **Tenant isolation** is enforced by the engine: every lookup is keyed by
  the execution's organization; the engine's NP apiKey never widens what a
  workflow can see.

### Deployment env

| Env var | Purpose |
|---|---|
| `WORKFLOW_NP_STORAGE_API_KEY` | Engine credential (management writes + data-plane reads). Unset ⇒ config entries disabled; routes 503. |
| `WORKFLOW_NP_STORAGE_BASE_URL` | Storage API base. Defaults to the production storage service (an ephemeral scope hostname — pin this in prod). |
| `WORKFLOW_NP_AUTH_BASE_URL` | Where the apiKey→token exchange happens. Defaults to the PUBLIC NP API — do not point it at an internal API base; in production auth and api are different services. |

Grants the engine key needs on the org NRN: `storage:read`, `storage:write`
(today), plus `storage:list` and `storage:delete` (pending — without
`delete`, rotations and NRN upgrades leave unreferenced orphan items that
must be cleaned up out-of-band).
