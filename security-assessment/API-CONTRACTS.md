# API Contracts — security-assessment v2

Pinned 2026-08-12 against `https://api.nullplatform.com`, org 4, app `1939881900`
("AuthZ API"). Consumed by Tasks 1-3 of the v2 plan. Every request below was
executed live and round-tripped; response bodies are reproduced with only the
bearer token redacted.

## 1. Application metadata

Application metadata lives in the `metadata.nullplatform.io` microservice,
reachable at the public API root under the `/metadata` prefix (**not** under
`/workflows`). It has two layers:

- **`metadata_specification`** — a per-org, per-entity, per-key JSON Schema
  that must exist before instance data can be written under that key. This is
  "Catalog" in current NP docs.
- **`/metadata/{entity}/{id}`** — the actual instance data for one entity,
  keyed by the spec's `metadata` field name.

### 1a. Read

**Preferred:** `GET /metadata/{entity}/{id}`

```bash
curl -sS "https://api.nullplatform.com/metadata/application/1939881900" \
  -H "Authorization: Bearer $TOKEN"
```

Response — top-level keys are the registered metadata-spec names for that
entity; data for a given type lives at `response[<metadata_type>]`:

```json
{
  "security_assessment_probe": { "probe": "1" },
  "additional_properties": {
    "entity": "application",
    "id": "1939881900",
    "nrn": "organization=4:account=17:namespace=36:application=1939881900"
  }
}
```

A type with no data yet is simply absent from the response (not a 404) — do
not treat a missing key as an error.

**Fallback A — embedded in the entity read**, confirmed working:
`GET /application/{id}?include=metadata` (the plain `GET /application/{id}`
without `include=metadata` does **not** embed it, contrary to some docs).
Response has a `metadata` object shaped exactly like the `/metadata/...` read:

```json
{
  "id": 1939881900,
  "name": "AuthZ API",
  "...": "...",
  "metadata": {
    "security_assessment_probe": { "probe": "2" },
    "additional_properties": {}
  }
}
```

**Fallback B — lake read**, confirmed working via `POST /data/lake/query`
(NerdGraph-style body key `"query"`). Table is `core_entities_metadata`; the
entity's id is column **`id`** (not `entity_id`), and `data` is a JSON string
column:

```sql
SELECT entity, id, metadata_type, nrn, data
FROM core_entities_metadata
WHERE id = '1939881900' AND entity = 'application' AND metadata_type = 'security_assessment'
LIMIT 5
```

Table schema (`DESCRIBE TABLE core_entities_metadata`): `pk, sk, id, entity,
metadata_type, specification_id, data (Nullable String, JSON-encoded),
nrn, created_at, updated_at, _deleted, _synced_at`.

### 1b. Write — spec must exist first

Writing an unregistered metadata key fails: `PATCH`/`POST` against a type with
no `metadata_specification` returns `400 body must NOT have additional
properties` (Catalog validates top-level keys against registered specs for
that entity+nrn). **Register the spec once per org** with:

```bash
curl -sS -X POST "https://api.nullplatform.com/metadata/metadata_specification" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "name": "Security assessment",
    "description": "Per-application security assessment state, maintained by the security-assessment workflows.",
    "nrn": "organization=4",
    "entity": "application",
    "metadata": "security_assessment",
    "schema": {
      "type": "object",
      "additionalProperties": true,
      "visibleOn": [],
      "properties": { "...": "the state fields written by wf2: last_commit, last_run_at, last_full_at" }
    }
  }'
```

Verified live (throwaway probe spec, `metadata: "security_assessment_probe"`,
id `1a39cfe1-d8b4-4a7c-af24-2e267921b31c`, created then deleted — see §3
"Round-trip evidence" below). This is the same pattern
`workflows/lib-inventory/setup/01-metadata-spec.sh` already uses in
production for `asset/dependencies` — idempotent create with a `400`/`409` →
`PATCH /metadata/metadata_specification/{id}` fallback if the spec already
exists. **Reuse that script's pattern verbatim** for the `security_assessment`
spec (Task 5/setup work — the v2 plan's setup task must add this registration
to `setup/`), scoped `nrn: organization=<org>`.

Spec cleanup (only needed for the throwaway probe, not for the real spec):
`DELETE /metadata/metadata_specification/{id}` — confirmed working, 200.

### 1c. Write — instance data: create-or-update, NOT a single verb

There is **no upsert** on the instance-data endpoint; which verb works
depends on whether a row already exists for that entity+key:

- **First write for a given entity+key**: `POST /metadata/{entity}/{id}`
  with body `{ "<metadata_type>": { ...data } }`. Confirmed live — a bare
  `PATCH` on a key with no existing row 404s (`Application metadata with ID
  "1939881900" not found`); `POST` on the same body succeeds (200) and
  creates it.
- **Subsequent writes** (row already exists): `PATCH /metadata/{entity}/{id}`
  with the same body shape. Confirmed live — 200, replaces the whole
  `<metadata_type>` value (not a deep merge — sending a partial object drops
  the omitted siblings).
- Both verbs are safe to call idempotently in that order: **`POST`, and on a
  `404`/`already exists` conflict fall back to `PATCH`** — mirrors the
  create-then-patch idiom already used for specs in
  `01-metadata-spec.sh`. (A workflow author writing this repeatedly for the
  same app should just always `PATCH` after a first bootstrap `POST`, or
  probe with a `GET` first and branch.)

> ### ⚠️ Unresolved: is the 404 per entity ROW or per metadata KEY?
>
> The `404` in §3 step 3 was produced on an application that had **no
> metadata of any type**. It therefore pins "no row at all → `PATCH` 404s"
> and nothing more. The common production case is *not* pinned: an
> application that already carries `deploy_summaries` / `governance`
> metadata but has never had a `security_assessment` key. Two readings are
> consistent with the evidence, and they fail in opposite directions:
>
> - **Per-key**: `PATCH` 404s there too, and `POST` is required.
> - **Per-row**: `PATCH` succeeds (adding our key), and `POST` — which
>   §1c shows *replacing* a value — may replace the **whole row**, wiping
>   another team's metadata.
>
> **wf2 therefore probes rather than guesses: `PATCH` first with
> `failOnHttpError: false`, and `POST` only when that returns `404`.** This is
> safe under both readings — a `PATCH` can only ever touch our own key, and
> the `404` is exactly the signal that the row must be created. Guessing
> `POST` first risks the destructive branch; guessing `PATCH`-only risks a
> permanent silent `state_not_persisted` on first write.
>
> **The pilot (Task 6) must settle this**: pick an app that already has other
> metadata, run the assessment, and verify with
> `GET /metadata/application/{id}` that its **sibling metadata types survived**
> and `security_assessment` was added. Record the answer here and simplify the
> chain if the per-row reading is confirmed.

Verified requests:

```bash
# First write (creates the row)
curl -sS -X POST "https://api.nullplatform.com/metadata/application/1939881900" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"security_assessment_probe":{"probe":"1"}}'
# -> 200 {"security_assessment_probe":{"probe":"1"},"additional_properties":{"entity":"application","id":"1939881900","nrn":"organization=4:account=17:namespace=36:application=1939881900"}}

# Subsequent write (row exists)
curl -sS -X PATCH "https://api.nullplatform.com/metadata/application/1939881900" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"security_assessment_probe":{"probe":"2"}}'
# -> 200 {"security_assessment_probe":{"probe":"2"},"additional_properties":{...}}
```

### 1d. As `np-api-call` config

`np-api-call` (`packages/core/src/plugins/built-in/np-api-call/descriptor.ts`)
takes `method`, `path`, `body`, `apiKey` — auth/base-URL resolution is
automatic (see `BASE_CONFIG_SCHEMA` / `resolveBaseConfig` in
`np-action-item-shared`), so `path` is relative to the API root, i.e. just
`/metadata/...`, not prefixed with `/workflows`.

```yaml
# Read
- id: read_assessment
  type: module
  plugin_type: np-api-call
  config:
    apiKey: "${{ secrets.NP_API_KEY }}"
    method: GET
    path: "/metadata/application/${{ workflow.inputs.applicationId }}"
  # steps.read_assessment.outputs.body.security_assessment -> the data (or undefined if never written)

# Write, step 1 of 2: PATCH first — it can only ever touch OUR key.
- id: write_state_patch
  type: module
  plugin_type: np-api-call
  config:
    apiKey: "${{ secrets.NP_API_KEY }}"
    method: PATCH
    path: "/metadata/application/${{ workflow.inputs.applicationId }}"
    body:
      security_assessment: "${{ variables.assessmentState }}"
    failOnHttpError: false   # so the 404-means-create case is inspectable, not a hard failure

# Write, step 2 of 2: POST only when the PATCH proved there is no row.
- id: patch_missing
  type: decider
  plugin_type: conditional
  config:
    expression: "steps.write_state_patch.outputs.status == 404"
# true → write_state_post (same body, method: POST, failOnHttpError: false)
```

**Use PATCH-first, not GET-then-branch.** Branching the verb on whether a
`GET` found the key looks simpler on the canvas, but the `GET` only tells you
about *your* key while the 404 evidence is about the *row* — see the warning
in §1c. PATCH-first is the only ordering that is safe under both readings,
and it costs one extra node on the first write per application (and nothing
on every run after that).

This is what `wf2-assess-deployment.yaml` implements
(`write_state_patch` → `patch_missing` → `write_state_post`), with
`failOnHttpError: false` on both writes and a dedicated resolver per write
node so a transport-level throw can never fail the assessment — the action
items are already reconciled by then; only the baseline is lost.

---

## 2. Action-item CLOSE contract

Source: `packages/core/src/plugins/built-in/np-action-item-update/{descriptor,plugin}.ts`,
`np-action-item-shared/`, and the production usage in
`workflows/ami-drift/wf2-ami-drift-closer.yaml`. Read only — no real action
item was mutated for this task, per the brief.

### Mechanism

`np-action-item-update` (module plugin) has two modes, selected by whether
`config.action` is set:

- **Patch mode** (no `action`): `PATCH /governance/action_item/:id` with
  whatever subset of `{title, priority, description, metadata, user_metadata,
  labels, due_date, value}` is provided.
- **Transition mode** (`action` set): `POST
  /governance/action_item/:id/:action` where `:action` is one of `defer |
  resolve | reject | close | reopen`. Body is `{actor, until?, reason?}`
  (`until` required for `defer`; `reason` optional, used by `defer`/`reject`).

**Close** is a transition-mode call:

```yaml
config:
  apiKey: "${{ secrets.NP_API_KEY }}"
  actionItemId: "${{ ... }}"
  action: close
  actor: "workflow:security-assessment"
  ignoreInvalidTransition: true   # see below
```

`ignoreInvalidTransition: true` makes a `400 "Invalid action item status
transition"` (item already closed) a no-op success
(`outputs.skipped: true`, `outputs.actionItem: null`) instead of failing the
step — required for an idempotent closer that may re-run over an
already-closed item (`plugin.ts` lines ~170-196). Any other error still
fails normally. This is the exact flag the ami-drift closer added after a
2026-07-28 incident where re-issuing `close` on already-closed items crashed
the whole page (see that YAML's header for the incident writeup).

Output on success: `{ actionItem, status, skipped }`. Attribute a
successful transition by `outputs.actionItem.id`, matching what was
requested — the ami-drift closer does NOT trust index/positional
correspondence unless the response and request-id arrays are the same
length (`select_closed` step in that YAML).

### Comment-before/after-close

`np-action-item-add-comment`
(`packages/core/src/plugins/built-in/np-action-item-add-comment/descriptor.ts`)
config: `{ apiKey, actionItemId, author, content }` (all three of
`actionItemId`/`author`/`content` required). **Comment AFTER a confirmed
close, not before** — the ami-drift closer's v2.2 fix (see that YAML's
header, "v2.2 FIX") moved the comment to fire only for ids that the close
response actually confirmed transitioned, specifically to avoid posting a
"closing automatically" comment on an item whose close failed or no-op'd.
Reuse that ordering for security-assessment's closer: `close` (with
`ignoreInvalidTransition: true`) → branch on `steps.<close>.status ==
'completed'` → comment only the ids with `skipped !== true`.

```yaml
config:
  apiKey: "${{ secrets.NP_API_KEY }}"
  actionItemId: "${{ ... }}"
  author: "workflow:security-assessment"
  content: "Closed automatically: <reason>."
```

---

## 3. Round-trip evidence (metadata write contract)

Executed against org 4 / app `1939881900`. Bearer token redacted throughout
(`$TOKEN` = value from `POST /token` with `NP_API_KEY` from `.env.null`).

1. Confirmed no pre-existing `security_assessment*` spec for `application` in
   org 4 (`GET /metadata/metadata_specification?entity=application&nrn=organization%3D4&limit=200`
   listed only `deploy_summaries` and `governance`).
2. `POST /metadata/metadata_specification` with a throwaway
   `security_assessment_probe` spec (schema above) → `200`, spec id
   `1a39cfe1-d8b4-4a7c-af24-2e267921b31c`.
3. `PATCH /metadata/application/1939881900` with
   `{"security_assessment_probe":{"probe":"1"}}` **before** any instance row
   existed → `404 {"statusCode":404,"code":"FST_ERR_NOT_FOUND","error":"Not Found","message":"Application metadata with ID \"1939881900\" not found"}`.
   This is what establishes the create-vs-update verb split in §1c.
4. `POST /metadata/application/1939881900` with the same body → `200`,
   echoed the value back.
5. `GET /metadata/application/1939881900` → `200`,
   `{"security_assessment_probe":{"probe":"1"},"additional_properties":{"entity":"application","id":"1939881900","nrn":"organization=4:account=17:namespace=36:application=1939881900"}}`.
6. `PATCH /metadata/application/1939881900` with `{"probe":"2"}` (row now
   exists) → `200`, value updated.
7. `GET /application/1939881900?include=metadata` → `200`, confirmed the
   `metadata` field embeds the same `security_assessment_probe` value
   (fallback read path A).
8. Lake fallback (`POST /data/lake/query`) against `core_entities_metadata`
   confirmed the same data visible with `id = '1939881900'`.
9. **Cleanup**: `PATCH .../1939881900` with `{"security_assessment_probe":{}}`
   → emptied the instance value; `DELETE
   /metadata/metadata_specification/1a39cfe1-d8b4-4a7c-af24-2e267921b31c` →
   `200`, spec removed (re-listed specs afterward: only `deploy_summaries`
   and `governance` remain, confirming the throwaway spec is gone). No real
   action item was touched.

**Conclusion: NOT blocked.** Application metadata is readable and writable
with the available credentials (`NP_API_KEY` from `.env.null`, org 4). The
only wrinkle versus the brief's assumed single write verb is the
create-(`POST`)-then-update-(`PATCH`) split documented in §1c, and the
spec-must-exist-first requirement in §1b — both are now pinned with working
requests.
