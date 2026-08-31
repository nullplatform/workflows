# Querying the inventory

Every query here runs against the customer lake:

```bash
curl -s -X POST https://api.nullplatform.com/data/lake/query \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"query": "… FORMAT JSONEachRow"}'
```

Things that will bite you if nobody says them first:

- **The inventory lives in the CATALOG.** One `dependency-inventory` entity
  per asset; the document is in `data` (its `id` is the asset id), the table's
  `nrn` column carries the asset NRN for prefix scoping, and the spec is found
  by joining `catalog_entity_specifications` on `slug`.
- **A deleted ENTITY still looks present.** `catalog_entities` keeps deleted
  rows (`_deleted = 1`, `deleted_at` set), so any "has this asset been scanned"
  CTE needs `FINAL`, `AND m._deleted = 0` and `AND m.deleted_at IS NULL`.
  Without them, deleting an entity to force a rescan silently does nothing —
  the asset is skipped forever. The same trap on the old metadata store
  stranded 341 assets, every Java one among them (2026-07-26).
- **A deleted scope still looks deployed.** Its deployments keep
  `status_in_scope = 'active'` in the lake, so the "what is live" CTE has to
  carry `AND s.status != 'deleted'` or it reports on builds nothing runs — 37%
  of one organization's live assets, and every asset it had on a two-major-old
  library. `!= 'deleted'` and not `= 'active'`: a status added later must keep
  flowing in, since an asset wrongly INCLUDED costs one scan while one wrongly
  EXCLUDED is invisible.

- **`m.data` is `Nullable(String)`.** `JSONExtractArrayRaw` refuses a nullable
  argument (`Nested type Array(String) cannot be inside Nullable type`), so every
  extraction below wraps it in `assumeNotNull`.
- **A Go major version is a DIFFERENT module path.** `…/goala/utel` and
  `…/goala/utel/v2` are two distinct dependencies that can both be absent, both
  be present, or replace one another. "Does it have utel" is therefore never one
  `name =` comparison — it is the three-state question the queries below ask.

Every query is scoped by `m.nrn LIKE 'organization=<ORG_ID>%'`. Swap the module
name for whichever library you are chasing.

---

## 1. Which versions of a library are out there

```sql
WITH inv AS (
  SELECT JSONExtractArrayRaw(assumeNotNull(m.data), 'libraries') AS deps
  FROM customers_lake.catalog_entities AS m FINAL
  WHERE m.entity_specification_id IN (SELECT id FROM customers_lake.catalog_entity_specifications FINAL
                                  WHERE slug = 'dependency-inventory' AND _deleted = 0)
    AND m.nrn LIKE 'organization=<ORG_ID>%' AND m._deleted = 0 AND m.deleted_at IS NULL
)
SELECT JSONExtractString(d, 'name')    AS name,
       JSONExtractString(d, 'version') AS version,
       count()                         AS assets
FROM inv ARRAY JOIN deps AS d
WHERE name LIKE '%goala/utel%'
GROUP BY name, version
ORDER BY name, version
FORMAT JSONEachRow
```

`LIKE '%goala/utel%'` rather than an equality on purpose: it is what makes the
v1 and v2 module paths show up side by side, which is the shape of the
migration.

---

## 2. The migration in one line: who is on v2, who is on v1, who has neither

```sql
WITH inv AS (
  SELECT toInt64OrZero(JSONExtractString(assumeNotNull(m.data), 'id'))                                        AS asset_id,
         JSONExtractString(assumeNotNull(m.data), 'status')          AS status,
         JSONExtractArrayRaw(assumeNotNull(m.data), 'libraries')  AS deps,
         has(JSONExtractArrayRaw(assumeNotNull(m.data), 'languages'), '"go"') AS is_go
  FROM customers_lake.catalog_entities AS m FINAL
  WHERE m.entity_specification_id IN (SELECT id FROM customers_lake.catalog_entity_specifications FINAL
                                  WHERE slug = 'dependency-inventory' AND _deleted = 0)
    AND m.nrn LIKE 'organization=<ORG_ID>%' AND m._deleted = 0 AND m.deleted_at IS NULL
),
hit AS (
  SELECT asset_id,
         anyIf(JSONExtractString(d, 'version'),
               JSONExtractString(d, 'name') = 'github.com/acme/goala/utel/v2') AS v2,
         anyIf(JSONExtractString(d, 'version'),
               JSONExtractString(d, 'name') = 'github.com/acme/goala/utel')    AS v1
  FROM inv ARRAY JOIN deps AS d
  GROUP BY asset_id
)
SELECT multiIf(h.v2 != '', 'on v2', h.v1 != '', 'on v1', 'no utel') AS state,
       count() AS assets
FROM inv AS i
LEFT JOIN hit AS h ON h.asset_id = i.asset_id
WHERE i.is_go AND i.status = 'ok'
GROUP BY state
ORDER BY assets DESC
FORMAT JSONEachRow
```

The `LEFT JOIN` is what makes "does not have the library" answerable at all: an
asset with no matching dependency never appears in `hit`, so an inner join would
silently return only the assets that DO have it — the exact question this
inventory exists to stop guessing at.

`status = 'ok'` matters just as much. An asset the scanner could not read has no
dependency list, and counting it as "does not have utel" would be a lie. See
query 4 for what that filter excludes.

---

## 3. Name the laggards, with somewhere to send the ticket

```sql
WITH inv AS (
  SELECT toInt64OrZero(JSONExtractString(assumeNotNull(m.data), 'id'))                                         AS asset_id,
         JSONExtractString(assumeNotNull(m.data), 'status')           AS status,
         JSONExtractString(assumeNotNull(m.data), 'repository_path')  AS path,
         JSONExtractString(assumeNotNull(m.data), 'repository_url')   AS repo,
         JSONExtractArrayRaw(assumeNotNull(m.data), 'libraries')   AS deps,
         has(JSONExtractArrayRaw(assumeNotNull(m.data), 'languages'), '"go"') AS is_go
  FROM customers_lake.catalog_entities AS m FINAL
  WHERE m.entity_specification_id IN (SELECT id FROM customers_lake.catalog_entity_specifications FINAL
                                  WHERE slug = 'dependency-inventory' AND _deleted = 0)
    AND m.nrn LIKE 'organization=<ORG_ID>%' AND m._deleted = 0 AND m.deleted_at IS NULL
),
hit AS (
  SELECT asset_id,
         anyIf(JSONExtractString(d, 'version'),
               JSONExtractString(d, 'name') = 'github.com/acme/goala/utel/v2') AS v2,
         anyIf(JSONExtractString(d, 'version'),
               JSONExtractString(d, 'name') = 'github.com/acme/goala/utel')    AS v1,
         -- `direct` separates "you declared this" from "this reached you
         -- through something else". Only the first is a bump the owning team
         -- can make on its own.
         anyIf(JSONExtractBool(d, 'direct'),
               JSONExtractString(d, 'name') = 'github.com/acme/goala/utel')    AS v1_direct
  FROM inv ARRAY JOIN deps AS d
  GROUP BY asset_id
)
SELECT a.app_name AS app,
       x.name     AS asset,
       multiIf(h.v2 != '', 'on v2', h.v1 != '', 'on v1', 'no utel') AS state,
       h.v1       AS v1_version,
       h.v1_direct AS v1_is_direct,
       i.repo     AS repository,
       i.path     AS path
FROM inv AS i
LEFT JOIN hit AS h ON h.asset_id = i.asset_id
INNER JOIN customers_lake.core_entities_asset       AS x FINAL ON x.id = i.asset_id
INNER JOIN customers_lake.core_entities_build       AS b FINAL ON b.id = x.build_id
INNER JOIN customers_lake.core_entities_application AS a FINAL ON a.app_id = b.app_id
WHERE i.is_go AND i.status = 'ok' AND state = 'on v1'
ORDER BY app, asset
FORMAT JSONEachRow
```

Change `state = 'on v1'` to `state = 'no utel'` for the assets that never
adopted the library at all.

---

## 4. What the numbers above are NOT telling you

Coverage is a query, not an act of faith — that is the whole reason a failed
scan still writes a record.

```sql
SELECT JSONExtractString(assumeNotNull(m.data), 'status') AS status, count() AS assets
FROM customers_lake.catalog_entities AS m FINAL
WHERE m.entity_specification_id IN (SELECT id FROM customers_lake.catalog_entity_specifications FINAL
                                  WHERE slug = 'dependency-inventory' AND _deleted = 0)
  AND m.nrn LIKE 'organization=<ORG_ID>%' AND m._deleted = 0 AND m.deleted_at IS NULL
GROUP BY status ORDER BY assets DESC
FORMAT JSONEachRow
```

And the assets with NO record at all — never visited, which is different from
"scanned and found nothing":

```sql
WITH live AS (
  SELECT DISTINCT r.build_id AS build_id, s.asset_name AS asset_name
  FROM customers_lake.core_entities_deployment AS d FINAL
  INNER JOIN customers_lake.core_entities_release AS r FINAL ON r.id = d.release_id
  INNER JOIN customers_lake.core_entities_scope   AS s FINAL ON s.id = d.scope_id
  WHERE d.status_in_scope = 'active' AND s.asset_name != ''
    AND s.status != 'deleted'
),
existing AS (
  SELECT toInt64OrZero(JSONExtractString(assumeNotNull(m.data), 'id')) AS asset_id
  FROM customers_lake.catalog_entities AS m FINAL
  WHERE m.entity_specification_id IN (SELECT id FROM customers_lake.catalog_entity_specifications FINAL
                                  WHERE slug = 'dependency-inventory' AND _deleted = 0)
    AND m.data IS NOT NULL AND m._deleted = 0 AND m.deleted_at IS NULL
)
SELECT count(DISTINCT x.id)                                              AS live_assets,
       countDistinctIf(x.id, x.id IN (SELECT asset_id FROM existing))    AS scanned
FROM customers_lake.core_entities_asset       AS x FINAL
INNER JOIN customers_lake.core_entities_build AS b FINAL ON b.id = x.build_id
INNER JOIN customers_lake.core_entities_application AS a FINAL ON a.app_id = b.app_id
INNER JOIN live AS l ON l.build_id = x.build_id AND l.asset_name = x.name
WHERE a.nrn LIKE 'organization=<ORG_ID>%'
FORMAT JSONEachRow
```

---

## 5. Runtime, not libraries

`manifest_config` is what each manifest declares about ITSELF, so the
runtime-deprecation question is a query too — and an asset that declares nothing
is as interesting as one declaring an old version.

```sql
SELECT JSONExtractString(assumeNotNull(m.data), 'manifest_config') AS cfg,
       JSONExtractString(cfg, 'node.engines.node')                 AS node_engine,
       JSONExtractString(cfg, 'go.go')                             AS go_version,
       count() AS assets
FROM customers_lake.catalog_entities AS m FINAL
WHERE m.entity_specification_id IN (SELECT id FROM customers_lake.catalog_entity_specifications FINAL
                                  WHERE slug = 'dependency-inventory' AND _deleted = 0)
  AND m.nrn LIKE 'organization=<ORG_ID>%' AND m._deleted = 0 AND m.deleted_at IS NULL
  AND JSONExtractString(assumeNotNull(m.data), 'status') = 'ok'
GROUP BY cfg, node_engine, go_version
ORDER BY assets DESC
FORMAT JSONEachRow
```

---

## 6. Namespace → application → scope → version of one library

The question a platform team actually asks. **The scope is the unit, not the
asset**: a scope points at ONE asset of ONE build, so `dev` and `prod` of the
same application legitimately run different commits and therefore different
library versions — collapsing to the asset would hide exactly that.

`namespace` is not a column anywhere; it is a segment of the scope's NRN, so it
has to be pulled out of the string and joined to `core_entities_namespace`.

```sql
WITH
live AS (
  SELECT s.name AS scope_name, s.nrn AS scope_nrn, s.application_id AS app_id,
         s.asset_name AS asset_name, r.build_id AS build_id
  FROM customers_lake.core_entities_deployment AS d FINAL
  INNER JOIN customers_lake.core_entities_release AS r FINAL ON r.id = d.release_id
  INNER JOIN customers_lake.core_entities_scope   AS s FINAL ON s.id = d.scope_id
  WHERE d.status_in_scope = 'active' AND s.asset_name != ''
    AND s.status != 'deleted'
),
inv AS (
  SELECT toInt64OrZero(JSONExtractString(assumeNotNull(m.data), 'id'))                                       AS asset_id,
         JSONExtractString(assumeNotNull(m.data), 'status')         AS status,
         JSONExtractArrayRaw(assumeNotNull(m.data), 'libraries') AS deps
  FROM customers_lake.catalog_entities AS m FINAL
  WHERE m.entity_specification_id IN (SELECT id FROM customers_lake.catalog_entity_specifications FINAL
                                  WHERE slug = 'dependency-inventory' AND _deleted = 0)
    AND m.nrn LIKE 'organization=<ORG_ID>%' AND m._deleted = 0 AND m.deleted_at IS NULL
),
hit AS (
  SELECT asset_id,
    anyIf(JSONExtractString(d, 'version'),
          JSONExtractString(d, 'name') = 'github.com/acme/goala/utel/v2') AS v2,
    anyIf(JSONExtractString(d, 'version'),
          JSONExtractString(d, 'name') = 'github.com/acme/goala/utel')    AS v1,
    anyIf(JSONExtractBool(d, 'direct'),
          JSONExtractString(d, 'name') LIKE 'github.com/acme/goala/utel%') AS is_direct
  FROM inv ARRAY JOIN deps AS d
  GROUP BY asset_id
)
SELECT ns.namespace_name AS namespace,
       a.app_name        AS application,
       l.scope_name      AS scope,
       multiIf(h.v2 != '', 'v2', h.v1 != '', 'v1', '-')                   AS major,
       coalesce(nullIf(h.v2, ''), nullIf(h.v1, ''), 'no usa la lib')      AS version,
       h.is_direct       AS direct
FROM live AS l
INNER JOIN customers_lake.core_entities_asset AS x FINAL
        ON x.build_id = l.build_id AND x.name = l.asset_name
INNER JOIN inv AS i ON i.asset_id = x.id
LEFT  JOIN hit AS h ON h.asset_id = x.id
INNER JOIN customers_lake.core_entities_application AS a FINAL ON a.app_id = l.app_id
-- `namespace=<id>` lives inside the NRN string; there is no namespace column.
LEFT  JOIN customers_lake.core_entities_namespace AS ns FINAL
       ON toString(ns.namespace_id) =
          splitByChar('=', arrayFilter(p -> p LIKE 'namespace=%',
                                       splitByChar(':', l.scope_nrn))[1])[2]
WHERE i.status = 'ok' AND major = 'v1'
ORDER BY namespace, application, scope
FORMAT JSONEachRow
```

Drop the `major = 'v1'` filter for the full picture, or set it to `'-'` for the
scopes that do not use the library at all.

---

## 7. Everything one scope depends on

```sql
WITH
live AS (
  SELECT s.asset_name AS asset_name, r.build_id AS build_id
  FROM customers_lake.core_entities_deployment AS d FINAL
  INNER JOIN customers_lake.core_entities_release AS r FINAL ON r.id = d.release_id
  INNER JOIN customers_lake.core_entities_scope   AS s FINAL ON s.id = d.scope_id
  WHERE d.status_in_scope = 'active' AND s.asset_name != ''
    AND s.status != 'deleted'
    AND s.name = '<SCOPE_NAME>'
),
inv AS (
  SELECT toInt64OrZero(JSONExtractString(assumeNotNull(m.data), 'id'))                                       AS asset_id,
         JSONExtractArrayRaw(assumeNotNull(m.data), 'libraries') AS deps
  FROM customers_lake.catalog_entities AS m FINAL
  WHERE m.entity_specification_id IN (SELECT id FROM customers_lake.catalog_entity_specifications FINAL
                                  WHERE slug = 'dependency-inventory' AND _deleted = 0)
    AND m.nrn LIKE 'organization=<ORG_ID>%' AND m._deleted = 0 AND m.deleted_at IS NULL
)
SELECT JSONExtractString(d, 'name')    AS library,
       JSONExtractString(d, 'version') AS version,
       JSONExtractBool(d, 'internal')  AS internal,
       JSONExtractBool(d, 'direct')    AS direct
FROM live AS l
INNER JOIN customers_lake.core_entities_asset AS x FINAL
        ON x.build_id = l.build_id AND x.name = l.asset_name
INNER JOIN inv AS i ON i.asset_id = x.id
ARRAY JOIN i.deps AS d
ORDER BY internal DESC, direct DESC, library
FORMAT JSONEachRow
```

This list is SHORT on purpose and it is not a bill of materials. Transitive
EXTERNAL dependencies are deliberately not stored — they were 87% of the volume
and nobody chose them. What is here is what somebody declared, plus every
internal library however it arrived. `transitive_external_dropped` on the record
says how many were left out.
