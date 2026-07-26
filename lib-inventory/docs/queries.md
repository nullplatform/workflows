# Querying the inventory

Every query here runs against the customer lake:

```bash
curl -s -X POST https://api.nullplatform.com/data/lake/query \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"query": "… FORMAT JSONEachRow"}'
```

Two things that will bite you if nobody says them first:

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
  SELECT JSONExtractArrayRaw(assumeNotNull(m.data), 'dependencies') AS deps
  FROM customers_lake.core_entities_metadata AS m FINAL
  WHERE m.entity = 'asset' AND m.metadata_type = 'dependencies'
    AND m.nrn LIKE 'organization=<ORG_ID>%' AND m._deleted = 0
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
  SELECT toInt64OrZero(m.id)                                        AS asset_id,
         JSONExtractString(assumeNotNull(m.data), 'status')          AS status,
         JSONExtractArrayRaw(assumeNotNull(m.data), 'dependencies')  AS deps,
         has(JSONExtractArrayRaw(assumeNotNull(m.data), 'languages'), '"go"') AS is_go
  FROM customers_lake.core_entities_metadata AS m FINAL
  WHERE m.entity = 'asset' AND m.metadata_type = 'dependencies'
    AND m.nrn LIKE 'organization=<ORG_ID>%' AND m._deleted = 0
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
  SELECT toInt64OrZero(m.id)                                         AS asset_id,
         JSONExtractString(assumeNotNull(m.data), 'status')           AS status,
         JSONExtractString(assumeNotNull(m.data), 'repository_path')  AS path,
         JSONExtractString(assumeNotNull(m.data), 'repository_url')   AS repo,
         JSONExtractArrayRaw(assumeNotNull(m.data), 'dependencies')   AS deps,
         has(JSONExtractArrayRaw(assumeNotNull(m.data), 'languages'), '"go"') AS is_go
  FROM customers_lake.core_entities_metadata AS m FINAL
  WHERE m.entity = 'asset' AND m.metadata_type = 'dependencies'
    AND m.nrn LIKE 'organization=<ORG_ID>%' AND m._deleted = 0
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
FROM customers_lake.core_entities_metadata AS m FINAL
WHERE m.entity = 'asset' AND m.metadata_type = 'dependencies'
  AND m.nrn LIKE 'organization=<ORG_ID>%' AND m._deleted = 0
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
),
existing AS (
  SELECT toInt32OrZero(m.id) AS asset_id
  FROM customers_lake.core_entities_metadata AS m
  WHERE m.entity = 'asset' AND m.metadata_type = 'dependencies' AND m.data IS NOT NULL
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
FROM customers_lake.core_entities_metadata AS m FINAL
WHERE m.entity = 'asset' AND m.metadata_type = 'dependencies'
  AND m.nrn LIKE 'organization=<ORG_ID>%' AND m._deleted = 0
  AND JSONExtractString(assumeNotNull(m.data), 'status') = 'ok'
GROUP BY cfg, node_engine, go_version
ORDER BY assets DESC
FORMAT JSONEachRow
```
