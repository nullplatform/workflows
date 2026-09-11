"""Generate the "FinOps — Costos por aplicación" report definition (nullplatform dynamic report).

Usage: python3 finops/setup/report-finops.py --spec-id <cost_daily spec uuid> [--out file.json]
Then: fetch_np_api_url.sh --method POST --data @file.json /report   (or PATCH /report/<id>)

Rules that matter (learned on nullplatform, org 4):
- catalog DELETEs never reach the Lake → every query keeps only the LATEST allocator run per day
  (`QUALIFY collected_at = max(collected_at) OVER (PARTITION BY day)`);
- `argMax(data, _version)` over the spec's rows instead of `FINAL` on the whole table (6–8 s → ~1 s);
- filter `params` keys MUST equal the schema property names or the frontend never re-runs the query;
- an area chart with a single day renders nothing → stacked bars;
- KPIs add up: total = applications + shared platform + Kubernetes overhead + unallocated.
"""
import argparse, json, sys
ap = argparse.ArgumentParser(); ap.add_argument('--spec-id', required=True, help='uuid of the cost_daily spec in the organization'); ap.add_argument('--out', default='np-report-finops.json'); ap.add_argument('--usage-spec-id', default='', help='uuid of the scope_usage_daily spec (adds the Kubernetes usage / right-sizing section)')
ARGS = ap.parse_args()
J="JSONExtractString(assumeNotNull(c.data),'%s')"
F="JSONExtractFloat(assumeNotNull(c.data),'%s')"
DATE="toDateOrNull(" + (J % 'day') + ") >= toDate(coalesce(parseDateTimeBestEffortOrNull({startDate:String}), now() - INTERVAL 30 DAY)) AND (parseDateTimeBestEffortOrNull({endDate:String}) IS NULL OR toDateOrNull(" + (J % 'day') + ") <= toDate(parseDateTimeBestEffortOrNull({endDate:String})))"
SPEC_ID=ARGS.spec_id  # literal uuid: the Lake has no index on the spec slug
INNER=f"SELECT id, argMax(data, _version) AS data FROM catalog_entities WHERE entity_specification_id = '{SPEC_ID}' GROUP BY id HAVING argMax(_deleted, _version) = 0"
# leaves = allocated rows that are not rollups (one row per source fact x owner)
BASE=f"""SELECT {J % 'day'} AS day, {J % 'application_id'} AS application_id, {J % 'application_slug'} AS application_slug, {J % 'charge_type'} AS charge_type, {J % 'scope_id'} AS scope_id, {J % 'scope_name'} AS scope_name, {J % 'scope_type'} AS scope_type, {J % 'service_id'} AS service_id, {J % 'service_name'} AS service_name, {J % 'environment'} AS environment, {J % 'category'} AS category, {J % 'cloud_service'} AS cloud_service, {J % 'subject_type'} AS subject_type, {J % 'subject_name'} AS subject_name, {J % 'allocation_method'} AS allocation_method, {J % 'rule_id'} AS rule_id, {J % 'bucket'} AS bucket, {J % 'cluster'} AS cluster, {F % 'cost_usd'} AS cost_usd, {J % 'collected_at'} AS collected_at FROM ({INNER}) AS c WHERE {J % 'stage'} = 'allocated' AND {J % 'allocation_method'} != 'rollup' AND {J % 'subject_type'} != 'unallocated' AND {DATE} QUALIFY collected_at = max(collected_at) OVER (PARTITION BY day)"""
# app join: application → namespace → account (names + account filter)
APPJ="LEFT JOIN core_entities_application AS a FINAL ON toString(a.app_id) = f.application_id AND a._deleted = 0 LEFT JOIN core_entities_namespace AS n FINAL ON n.namespace_id = a.namespace_id AND n._deleted = 0 LEFT JOIN core_entities_account AS ac FINAL ON ac.account_id = n.account_id AND ac._deleted = 0"
APPW="f.application_id != '' AND ({accountId:String} = '' OR toString(n.account_id) = {accountId:String}) AND ({applicationId:String} = '' OR f.application_id = {applicationId:String}) AND ({environment:String} = '' OR f.environment = {environment:String}) AND ({chargeType:String} = '' OR f.charge_type = {chargeType:String}) AND ({serviceId:String} = '' OR f.service_id = {serviceId:String}) AND ({scopeType:String} = '' OR f.scope_type = {scopeType:String})"
P_ALL={"startDate":{"scope":"#/properties/startDate"},"endDate":{"scope":"#/properties/endDate"},"accountId":{"scope":"#/properties/accountId"},"applicationId":{"scope":"#/properties/applicationId"},"environment":{"scope":"#/properties/environment"},"chargeType":{"scope":"#/properties/chargeType"},"serviceId":{"scope":"#/properties/serviceId"},"scopeType":{"scope":"#/properties/scopeType"}}
P_DATE={"startDate":{"scope":"#/properties/startDate"},"endDate":{"scope":"#/properties/endDate"}}
APPS=f"WITH f AS ({BASE}) SELECT round(sum(f.cost_usd), 2) AS appsUsd FROM f {APPJ} WHERE {APPW} FORMAT JSON"
TOTAL=f"WITH f AS ({BASE}) SELECT round(sum(f.cost_usd), 2) AS totalUsd, round(sumIf(f.cost_usd, f.allocation_method = 'kubernetes_overhead'), 2) AS overheadUsd, round(sumIf(f.cost_usd, f.allocation_method = 'unallocated'), 2) AS unallocatedUsd, round(sumIf(f.cost_usd, f.application_id = '' AND f.allocation_method NOT IN ('unallocated', 'kubernetes_overhead')), 2) AS sharedUsd, round(sumIf(f.cost_usd, f.application_id != '') * 100.0 / greatest(sum(f.cost_usd), 0.000001), 1) AS attributedPct FROM f FORMAT JSON"
TREND=f"WITH f AS ({BASE}) SELECT f.day AS day, round(sumIf(f.cost_usd, f.charge_type = 'scope'), 2) AS scopes, round(sumIf(f.cost_usd, f.charge_type = 'service'), 2) AS services, round(sumIf(f.cost_usd, f.charge_type = 'application'), 2) AS applications, round(sumIf(f.cost_usd, f.application_id = '' AND f.allocation_method != 'unallocated'), 2) AS shared, round(sumIf(f.cost_usd, f.allocation_method = 'unallocated'), 2) AS unallocated FROM f GROUP BY day ORDER BY day FORMAT JSON"
BYAPP=f"WITH f AS ({BASE}) SELECT coalesce(nullIf(a.application_slug, ''), f.application_slug, f.application_id) AS app, round(sum(f.cost_usd), 2) AS usd FROM f {APPJ} WHERE {APPW} GROUP BY app ORDER BY usd DESC LIMIT 15 FORMAT JSON"
BYENV=f"WITH f AS ({BASE}) SELECT if(f.environment = '', 'sin dimensión', f.environment) AS label, round(sum(f.cost_usd), 2) AS value FROM f {APPJ} WHERE {APPW} GROUP BY label ORDER BY value DESC FORMAT JSON"
BYSVC=f"WITH f AS ({BASE}) SELECT f.cloud_service AS label, round(sum(f.cost_usd), 2) AS value FROM f {APPJ} WHERE {APPW} GROUP BY label ORDER BY value DESC LIMIT 12 FORMAT JSON"
BYCAT=f"WITH f AS ({BASE}) SELECT if(f.category = '', 'other', f.category) AS label, round(sum(f.cost_usd), 2) AS value FROM f {APPJ} WHERE {APPW} GROUP BY label ORDER BY value DESC FORMAT JSON"
APPTABLE=f"WITH f AS ({BASE}) SELECT coalesce(nullIf(a.application_slug, ''), f.application_slug, f.application_id) AS app, coalesce(n.namespace_name, '') AS namespace, coalesce(ac.account_name, '') AS account, round(sum(f.cost_usd), 2) AS total, round(sumIf(f.cost_usd, f.charge_type = 'scope'), 2) AS scopes, round(sumIf(f.cost_usd, f.charge_type = 'service'), 2) AS services, round(sumIf(f.cost_usd, f.charge_type = 'application'), 2) AS applications, round(sumIf(f.cost_usd, f.environment = 'production'), 2) AS production, round(sumIf(f.cost_usd, f.environment != 'production'), 2) AS nonProduction, uniqExact(f.day) AS days, round(sum(f.cost_usd) / greatest(uniqExact(f.day), 1), 2) AS perDay FROM f {APPJ} WHERE {APPW} GROUP BY app, namespace, account ORDER BY total DESC FORMAT JSON"
OBJTABLE=f"WITH f AS ({BASE}) SELECT f.day AS day, coalesce(nullIf(a.application_slug, ''), f.application_slug, f.application_id) AS app, f.charge_type AS chargeType, multiIf(f.charge_type = 'scope', f.scope_name, f.charge_type = 'service', f.service_name, f.subject_name) AS object, if(f.charge_type = 'scope', f.scope_type, '') AS scopeType, if(f.environment = '', '-', f.environment) AS environment, f.category AS category, f.cloud_service AS cloudService, f.allocation_method AS method, f.rule_id AS rule, round(sum(f.cost_usd), 2) AS usd FROM f {APPJ} WHERE {APPW} GROUP BY day, app, chargeType, object, scopeType, environment, category, cloudService, method, rule ORDER BY day DESC, usd DESC LIMIT 1000 FORMAT JSON"
SHARED=f"WITH f AS ({BASE}) SELECT multiIf(f.allocation_method = 'unallocated', 'sin atribuir', f.allocation_method = 'kubernetes_overhead', concat('overhead k8s ', f.cluster), f.allocation_method = 'cluster_pending_consumption', concat('cluster pendiente ', f.cluster), f.bucket != '', concat('bucket ', f.bucket), f.allocation_method) AS kind, f.cloud_service AS cloudService, round(sum(f.cost_usd), 2) AS usd FROM f WHERE f.application_id = '' GROUP BY kind, cloudService ORDER BY usd DESC LIMIT 100 FORMAT JSON"
ENUM_ACC="SELECT toString(account_id) AS id, account_name AS name FROM core_entities_account FINAL WHERE _deleted = 0 AND status = 'active' ORDER BY name FORMAT JSON"
ENUM_APP="SELECT toString(a.app_id) AS id, a.application_slug AS name FROM core_entities_application AS a FINAL JOIN core_entities_namespace AS n FINAL ON n.namespace_id = a.namespace_id AND n._deleted = 0 WHERE a._deleted = 0 AND a.status = 'active' AND ({accountId:String} = '' OR toString(n.account_id) = {accountId:String}) ORDER BY name FORMAT JSON"
ENUM_SVC=f"WITH f AS ({BASE}) SELECT f.service_id AS id, anyLast(f.service_name) AS name FROM f WHERE f.charge_type = 'service' AND f.service_id != '' GROUP BY id ORDER BY name FORMAT JSON"
ENUM_ST=f"WITH f AS ({BASE}) SELECT DISTINCT f.scope_type AS id, f.scope_type AS name FROM f WHERE f.scope_type != '' ORDER BY name FORMAT JSON"
ENUM_ENV="SELECT dv.slug AS id, coalesce(dv.name, dv.slug) AS name FROM core_entities_runtime_configuration_dimension_value AS dv FINAL JOIN core_entities_runtime_configuration_dimension AS d FINAL ON dv.dimension_id = d.id AND d._deleted = 0 AND d.status = 'active' WHERE dv._deleted = 0 AND dv.status = 'active' AND d.slug = 'environment' ORDER BY name FORMAT JSON"
num=lambda: {"type":"number"}; st=lambda: {"type":"string"}
def arr(props): return {"type":"array","items":{"type":"object","properties":props}}
schema={"type":"object","properties":{
 "startDate":{"type":"string","format":"date-time","default":""},"endDate":{"type":"string","format":"date-time","default":""},
 "accountId":{"type":"string","default":""},"applicationId":{"type":"string","default":""},"environment":{"type":"string","default":""},
 "chargeType":{"type":"string","oneOf":[{"const":"","title":"Todos"},{"const":"scope","title":"Scope"},{"const":"service","title":"Servicio"},{"const":"application","title":"Aplicación"}],"default":""},
 "serviceId":{"type":"string","default":""},"scopeType":{"type":"string","default":""},
 "totalUsd":{"type":"number","title":"Costo total (USD)"},"appsUsd":{"type":"number","title":"Atribuido a aplicaciones (USD)"},"overheadUsd":{"type":"number","title":"Overhead Kubernetes (USD)"},"sharedUsd":{"type":"number","title":"Plataforma compartida (USD)"},"unallocatedUsd":{"type":"number","title":"Sin atribuir (USD)"},"attributedPct":{"type":"number","title":"% atribuido a apps"},
 "trend":arr({"day":st(),"scopes":num(),"services":num(),"applications":num(),"shared":num(),"unallocated":num()}),
 "byApp":arr({"app":st(),"usd":num()}),"byEnvironment":arr({"label":st(),"value":num()}),"byCloudService":arr({"label":st(),"value":num()}),"byCategory":arr({"label":st(),"value":num()}),
 "appsTable":arr({"app":st(),"namespace":st(),"account":st(),"total":num(),"scopes":num(),"services":num(),"applications":num(),"production":num(),"nonProduction":num(),"days":num(),"perDay":num()}),
 "objectsTable":arr({"day":st(),"app":st(),"chargeType":st(),"object":st(),"scopeType":st(),"environment":st(),"category":st(),"cloudService":st(),"method":st(),"rule":st(),"usd":num()}),
 "sharedTable":arr({"kind":st(),"cloudService":st(),"usd":num()})}}
kpi=lambda s,unit="USD",prec=2: {"type":"Control","scope":"#/properties/"+s,"options":{"widget":"kpi","showBackground":true,"unit":unit,"precision":prec}}
true=True
ui={"type":"VerticalLayout","elements":[
 {"type":"HorizontalLayout","elements":[
   {"type":"Control","scope":"#/properties/startDate","label":"Período","options":{"format":"date-range","endDateScope":"#/properties/endDate","initialPreset":"last30Days","allowedRanges":["yesterday","last7Days","last30Days","thisMonth","lastMonth"],"disableFuture":true}},
   {"type":"Control","scope":"#/properties/accountId","label":"Cuenta"},{"type":"Control","scope":"#/properties/applicationId","label":"Aplicación"},
   {"type":"Control","scope":"#/properties/environment","label":"Environment"},{"type":"Control","scope":"#/properties/chargeType","label":"Tipo de cargo"}]},
 {"type":"HorizontalLayout","elements":[{"type":"Control","scope":"#/properties/serviceId","label":"Servicio (null)"},{"type":"Control","scope":"#/properties/scopeType","label":"Tipo de scope"}]},
 {"type":"Label","text":"##### Resumen\nTotal = aplicaciones + plataforma compartida (reglas a buckets: seguridad, observabilidad) + overhead Kubernetes (cluster que ningún scope consumió) + sin atribuir. Total, compartido, overhead y sin atribuir son de toda la organización en el período; el resto de los widgets responde a los filtros de cuenta, aplicación, environment, tipo de cargo, servicio null y tipo de scope (por ejemplo `lambda` para ver solo las funciones).","options":{"format":"markdown"}},
 {"type":"HorizontalLayout","options":{"columns":[2,2,2,2,2,2]},"elements":[kpi("totalUsd"),kpi("appsUsd"),kpi("sharedUsd"),kpi("overheadUsd"),kpi("unallocatedUsd"),
   {"type":"Control","scope":"#/properties/attributedPct","options":{"widget":"kpi","showBackground":true,"unit":"%","precision":1,"thresholds":[{"value":80,"color":"success"},{"value":50,"color":"warning"},{"value":0,"color":"error"}]}}]},
 {"type":"Label","text":"##### Evolución diaria\nCosto por día según por dónde llegó a la aplicación: **scopes** (cualquier tipo, k8s o lambda), **servicios** null, o **aplicación** (recursos no modelados en null pero atribuidos por regla). *Compartido* = overhead del cluster y buckets de plataforma.","options":{"format":"markdown"}},
 {"type":"Control","scope":"#/properties/trend","label":"Costo diario por tipo de cargo","options":{"widget":"bar-chart","showBackground":true,"categoryKey":"day","series":[{"dataKey":"scopes","name":"Scopes"},{"dataKey":"services","name":"Servicios"},{"dataKey":"applications","name":"Aplicación"},{"dataKey":"shared","name":"Compartido"},{"dataKey":"unallocated","name":"Sin atribuir"}],"xAxisLabel":"Día","yAxisLabel":"USD","height":320,"stacked":true,"borderRadius":4,"showLegend":true,"colors":["#3b82f6","#8b5cf6","#f59e0b","#94a3b8","#ef4444"]}},
 {"type":"Label","text":"##### Por aplicación y por dimensión","options":{"format":"markdown"}},
 {"type":"HorizontalLayout","options":{"columns":[8,4]},"elements":[
   {"type":"Control","scope":"#/properties/byApp","label":"Top aplicaciones","options":{"widget":"bar-chart","showBackground":true,"categoryKey":"app","series":[{"dataKey":"usd","name":"USD"}],"xAxisLabel":"Aplicación","yAxisLabel":"USD","height":320,"borderRadius":4,"colors":["#3b82f6"]}},
   {"type":"Control","scope":"#/properties/byEnvironment","label":"Por environment","options":{"widget":"donut-chart","showBackground":true,"labelKey":"label","valueKey":"value","donutSize":"55%","showTotal":true,"totalLabel":"USD","height":320}}]},
 {"type":"HorizontalLayout","options":{"columns":[6,6]},"elements":[
   {"type":"Control","scope":"#/properties/byCloudService","label":"Por servicio de nube","options":{"widget":"donut-chart","showBackground":true,"labelKey":"label","valueKey":"value","donutSize":"55%","showTotal":true,"totalLabel":"USD","height":320}},
   {"type":"Control","scope":"#/properties/byCategory","label":"Por categoría","options":{"widget":"donut-chart","showBackground":true,"labelKey":"label","valueKey":"value","donutSize":"55%","showTotal":true,"totalLabel":"USD","height":320}}]},
 {"type":"Label","text":"##### Detalle por aplicación\nUna fila por aplicación con el desglose por tipo de cargo y por environment.","options":{"format":"markdown"}},
 {"type":"Control","scope":"#/properties/appsTable","label":"Aplicaciones","options":{"widget":"data-table","features":["sorting","pagination"],"pagination":{"pageSize":25,"pageSizeOptions":[10,25,50]},"emptyState":{"title":"Sin costos atribuidos","description":"Probá ampliar el período o quitar filtros."},"columns":[
   {"id":"app","header":"Aplicación","accessor":"app","fixed":{"position":"left"}},{"id":"namespace","header":"Namespace","accessor":"namespace"},{"id":"account","header":"Cuenta","accessor":"account"},
   {"id":"total","header":"Total (USD)","accessor":"total"},{"id":"scopes","header":"Scopes (USD)","accessor":"scopes"},{"id":"services","header":"Servicios (USD)","accessor":"services"},{"id":"applications","header":"Aplicación (USD)","accessor":"applications"},
   {"id":"production","header":"Production (USD)","accessor":"production"},{"id":"nonProduction","header":"No production (USD)","accessor":"nonProduction"},{"id":"days","header":"Días","accessor":"days"},{"id":"perDay","header":"USD/día","accessor":"perDay"}]}},
 {"type":"Label","text":"##### Detalle por scope y servicio\nLos ítems de la factura de cada aplicación: qué objeto null (scope o servicio) generó el cargo, con su environment, categoría, servicio de nube y la regla que lo atribuyó.","options":{"format":"markdown"}},
 {"type":"Control","scope":"#/properties/objectsTable","label":"Ítems","options":{"widget":"data-table","features":["sorting","pagination"],"pagination":{"pageSize":25,"pageSizeOptions":[25,50,100,250]},"emptyState":{"title":"Sin ítems","description":"Probá ampliar el período o quitar filtros."},"columns":[
   {"id":"day","header":"Día","accessor":"day"},{"id":"app","header":"Aplicación","accessor":"app","fixed":{"position":"left"}},{"id":"chargeType","header":"Tipo","accessor":"chargeType","formatter":{"type":"chip","config":{"size":"small","color":"info"}}},{"id":"object","header":"Scope / servicio","accessor":"object"},{"id":"scopeType","header":"Tipo de scope","accessor":"scopeType"},
   {"id":"environment","header":"Environment","accessor":"environment","formatter":{"type":"chip","config":{"size":"small"}}},{"id":"category","header":"Categoría","accessor":"category"},{"id":"cloudService","header":"Servicio de nube","accessor":"cloudService"},{"id":"method","header":"Método","accessor":"method"},{"id":"rule","header":"Regla","accessor":"rule","formatter":{"type":"text","typography":{"maxLines":1}}},{"id":"usd","header":"USD","accessor":"usd"}]}},
 {"type":"Label","text":"##### Compartido y sin atribuir\nLo que no llegó a ninguna aplicación (toda la organización): overhead del cluster, buckets de plataforma y servicios de nube sin regla. Es la lista de trabajo para nuevas reglas de mapeo.","options":{"format":"markdown"}},
 {"type":"Control","scope":"#/properties/sharedTable","label":"Compartido / sin atribuir","options":{"widget":"data-table","features":["sorting","pagination"],"pagination":{"pageSize":10,"pageSizeOptions":[10,25,50]},"emptyState":{"title":"Todo atribuido","description":"No hay costo compartido ni sin atribuir en el período."},"columns":[
   {"id":"kind","header":"Tipo","accessor":"kind","fixed":{"position":"left"}},{"id":"cloudService","header":"Servicio de nube","accessor":"cloudService"},{"id":"usd","header":"USD","accessor":"usd"}]}}
]}
queries={
 "enum-accounts":{"source":ENUM_ACC,"target":"#/properties/accountId","mapping":"enum"},
 "enum-applications":{"source":ENUM_APP,"params":{"accountId":{"scope":"#/properties/accountId"}},"target":"#/properties/applicationId","mapping":"enum"},
 "enum-environments":{"source":ENUM_ENV,"target":"#/properties/environment","mapping":"enum"},
 "enum-services":{"source":ENUM_SVC,"params":P_DATE,"target":"#/properties/serviceId","mapping":"enum"},
 "enum-scope-types":{"source":ENUM_ST,"params":P_DATE,"target":"#/properties/scopeType","mapping":"enum"},
 "kpi-total":{"source":TOTAL,"params":P_DATE,"target":"#/properties/totalUsd"},
 "kpi-overhead":{"source":TOTAL,"params":P_DATE,"target":"#/properties/overheadUsd"},
 "kpi-shared":{"source":TOTAL,"params":P_DATE,"target":"#/properties/sharedUsd"},
 "kpi-unallocated":{"source":TOTAL,"params":P_DATE,"target":"#/properties/unallocatedUsd"},
 "kpi-attributed-pct":{"source":TOTAL,"params":P_DATE,"target":"#/properties/attributedPct"},
 "kpi-apps":{"source":APPS,"params":P_ALL,"target":"#/properties/appsUsd"},
 "trend":{"source":TREND,"params":P_DATE,"target":"#/properties/trend"},
 "by-app":{"source":BYAPP,"params":P_ALL,"target":"#/properties/byApp"},
 "by-environment":{"source":BYENV,"params":P_ALL,"target":"#/properties/byEnvironment"},
 "by-cloud-service":{"source":BYSVC,"params":P_ALL,"target":"#/properties/byCloudService"},
 "by-category":{"source":BYCAT,"params":P_ALL,"target":"#/properties/byCategory"},
 "apps-table":{"source":APPTABLE,"params":P_ALL,"target":"#/properties/appsTable"},
 "objects-table":{"source":OBJTABLE,"params":P_ALL,"target":"#/properties/objectsTable"},
 "shared-table":{"source":SHARED,"params":P_DATE,"target":"#/properties/sharedTable"}}
# ── Kubernetes usage per scope (scope_usage_daily): the right-sizing view next to the cost ──
if ARGS.usage_spec_id:
    UI_=f"SELECT id, argMax(data, _version) AS data FROM catalog_entities WHERE entity_specification_id = '{ARGS.usage_spec_id}' GROUP BY id HAVING argMax(_deleted, _version) = 0"
    UBASE=f"""SELECT {J % 'day'} AS day, {J % 'scope_id'} AS scope_id, {J % 'scope_name'} AS scope_name, {J % 'scope_type'} AS scope_type, {J % 'application_id'} AS application_id, {J % 'application_slug'} AS application_slug, {J % 'environment'} AS environment, {J % 'cluster'} AS cluster, {J % 'source'} AS source, {F % 'core_h_used'} AS core_h_used, {F % 'core_h_requested'} AS core_h_requested, {F % 'core_h_chargeable'} AS core_h_chargeable, {F % 'gb_h_used'} AS gb_h_used, {F % 'gb_h_requested'} AS gb_h_requested, {F % 'gb_h_chargeable'} AS gb_h_chargeable, {F % 'cpu_waste_core_h'} AS cpu_waste_core_h, {F % 'mem_waste_gb_h'} AS mem_waste_gb_h, {F % 'pods_avg'} AS pods_avg, {J % 'collected_at'} AS collected_at FROM ({UI_}) AS c WHERE {DATE} QUALIFY collected_at = max(collected_at) OVER (PARTITION BY day, scope_id)"""
    UW="({accountId:String} = '' OR toString(n.account_id) = {accountId:String}) AND ({applicationId:String} = '' OR u.application_id = {applicationId:String}) AND ({environment:String} = '' OR u.environment = {environment:String}) AND ({scopeType:String} = '' OR u.scope_type = {scopeType:String})"
    UJ="LEFT JOIN core_entities_application AS a FINAL ON toString(a.app_id) = u.application_id AND a._deleted = 0 LEFT JOIN core_entities_namespace AS n FINAL ON n.namespace_id = a.namespace_id AND n._deleted = 0"
    P_USAGE={"startDate":{"scope":"#/properties/startDate"},"endDate":{"scope":"#/properties/endDate"},"accountId":{"scope":"#/properties/accountId"},"applicationId":{"scope":"#/properties/applicationId"},"environment":{"scope":"#/properties/environment"},"scopeType":{"scope":"#/properties/scopeType"}}
    UKPI=f"WITH u AS ({UBASE}) SELECT round(sum(u.core_h_used) * 100.0 / greatest(sum(u.core_h_requested), 0.000001), 1) AS cpuUtilPct, round(sum(u.gb_h_used) * 100.0 / greatest(sum(u.gb_h_requested), 0.000001), 1) AS memUtilPct, round(sum(u.cpu_waste_core_h), 1) AS cpuWasteCoreH, round(sum(u.mem_waste_gb_h), 1) AS memWasteGbH, uniqExact(u.scope_id) AS scopesWithUsage FROM u {UJ} WHERE {UW} FORMAT JSON"
    UTREND=f"WITH u AS ({UBASE}) SELECT u.day AS day, round(sum(u.core_h_used), 1) AS coreHUsed, round(sum(u.core_h_requested), 1) AS coreHRequested, round(sum(u.gb_h_used), 1) AS gbHUsed, round(sum(u.gb_h_requested), 1) AS gbHRequested FROM u {UJ} WHERE {UW} GROUP BY day ORDER BY day FORMAT JSON"
    UTABLE=f"WITH u AS ({UBASE}) SELECT coalesce(nullIf(a.application_slug, ''), u.application_slug, u.application_id) AS app, u.scope_name AS scope, u.scope_type AS scopeType, if(u.environment = '', '-', u.environment) AS environment, u.cluster AS cluster, uniqExact(u.day) AS days, round(avg(u.pods_avg), 1) AS pods, round(sum(u.core_h_used) / greatest(uniqExact(u.day), 1), 2) AS coreHUsedPerDay, round(sum(u.core_h_requested) / greatest(uniqExact(u.day), 1), 2) AS coreHRequestedPerDay, round(sum(u.core_h_used) * 100.0 / greatest(sum(u.core_h_requested), 0.000001), 1) AS cpuUtilPct, round(sum(u.gb_h_used) / greatest(uniqExact(u.day), 1), 2) AS gbHUsedPerDay, round(sum(u.gb_h_requested) / greatest(uniqExact(u.day), 1), 2) AS gbHRequestedPerDay, round(sum(u.gb_h_used) * 100.0 / greatest(sum(u.gb_h_requested), 0.000001), 1) AS memUtilPct, round(sum(u.cpu_waste_core_h), 1) AS cpuWasteCoreH, round(sum(u.mem_waste_gb_h), 1) AS memWasteGbH FROM u {UJ} WHERE {UW} GROUP BY app, scope, scopeType, environment, cluster ORDER BY cpuWasteCoreH DESC LIMIT 500 FORMAT JSON"
    schema["properties"].update({
      "cpuUtilPct":{"type":"number","title":"Utilización CPU (usado/pedido)"},"memUtilPct":{"type":"number","title":"Utilización memoria (usado/pedido)"},
      "cpuWasteCoreH":{"type":"number","title":"CPU pedida y no usada (core-h)"},"memWasteGbH":{"type":"number","title":"Memoria pedida y no usada (GiB-h)"},"scopesWithUsage":{"type":"number","title":"Scopes con consumo"},
      "usageTrend":arr({"day":st(),"coreHUsed":num(),"coreHRequested":num(),"gbHUsed":num(),"gbHRequested":num()}),
      "usageTable":arr({"app":st(),"scope":st(),"scopeType":st(),"environment":st(),"cluster":st(),"days":num(),"pods":num(),"coreHUsedPerDay":num(),"coreHRequestedPerDay":num(),"cpuUtilPct":num(),"gbHUsedPerDay":num(),"gbHRequestedPerDay":num(),"memUtilPct":num(),"cpuWasteCoreH":num(),"memWasteGbH":num()})})
    ui["elements"] += [
      {"type":"Label","text":"##### Uso de Kubernetes por scope (right-sizing)\nConsumo real vs pedido (requests) de cada scope en el cluster, la base con la que se reparte el costo del cluster. **Utilización** = usado / pedido; lo pedido y no usado es capacidad que la aplicación bloquea en los nodos sin usarla. Filtros: período, cuenta, aplicación, environment y tipo de scope.","options":{"format":"markdown"}},
      {"type":"HorizontalLayout","options":{"columns":[2.4,2.4,2.4,2.4,2.4]},"elements":[
        {"type":"Control","scope":"#/properties/cpuUtilPct","options":{"widget":"kpi","showBackground":true,"unit":"%","precision":1,"thresholds":[{"value":60,"color":"success"},{"value":30,"color":"warning"},{"value":0,"color":"error"}]}},
        {"type":"Control","scope":"#/properties/memUtilPct","options":{"widget":"kpi","showBackground":true,"unit":"%","precision":1,"thresholds":[{"value":60,"color":"success"},{"value":30,"color":"warning"},{"value":0,"color":"error"}]}},
        kpi("cpuWasteCoreH","core-h",1),kpi("memWasteGbH","GiB-h",1),kpi("scopesWithUsage","",0)]},
      {"type":"Control","scope":"#/properties/usageTrend","label":"CPU y memoria: usado vs pedido por día","options":{"widget":"bar-chart","showBackground":true,"categoryKey":"day","series":[{"dataKey":"coreHUsed","name":"CPU usada (core-h)"},{"dataKey":"coreHRequested","name":"CPU pedida (core-h)"},{"dataKey":"gbHUsed","name":"Memoria usada (GiB-h)"},{"dataKey":"gbHRequested","name":"Memoria pedida (GiB-h)"}],"xAxisLabel":"Día","yAxisLabel":"core-h / GiB-h","height":300,"borderRadius":4}},
      {"type":"Control","scope":"#/properties/usageTable","label":"Scopes: uso vs pedido","options":{"widget":"data-table","features":["sorting","pagination"],"pagination":{"pageSize":25,"pageSizeOptions":[10,25,50,100]},"emptyState":{"title":"Sin datos de uso","description":"Todavía no hay filas de scope_usage_daily para el período."},"columns":[
        {"id":"app","header":"Aplicación","accessor":"app","fixed":{"position":"left"}},{"id":"scope","header":"Scope","accessor":"scope"},{"id":"scopeType","header":"Tipo","accessor":"scopeType"},{"id":"environment","header":"Environment","accessor":"environment","formatter":{"type":"chip","config":{"size":"small"}}},{"id":"cluster","header":"Cluster","accessor":"cluster"},
        {"id":"days","header":"Días","accessor":"days"},{"id":"pods","header":"Pods (prom.)","accessor":"pods"},
        {"id":"coreHUsedPerDay","header":"CPU usada (core-h/día)","accessor":"coreHUsedPerDay"},{"id":"coreHRequestedPerDay","header":"CPU pedida (core-h/día)","accessor":"coreHRequestedPerDay"},{"id":"cpuUtilPct","header":"Util. CPU %","accessor":"cpuUtilPct"},
        {"id":"gbHUsedPerDay","header":"Mem usada (GiB-h/día)","accessor":"gbHUsedPerDay"},{"id":"gbHRequestedPerDay","header":"Mem pedida (GiB-h/día)","accessor":"gbHRequestedPerDay"},{"id":"memUtilPct","header":"Util. mem %","accessor":"memUtilPct"},
        {"id":"cpuWasteCoreH","header":"CPU no usada (core-h)","accessor":"cpuWasteCoreH"},{"id":"memWasteGbH","header":"Mem no usada (GiB-h)","accessor":"memWasteGbH"}]}}]
    queries.update({
      "usage-kpi-cpu":{"source":UKPI,"params":P_USAGE,"target":"#/properties/cpuUtilPct"},"usage-kpi-mem":{"source":UKPI,"params":P_USAGE,"target":"#/properties/memUtilPct"},
      "usage-kpi-cpu-waste":{"source":UKPI,"params":P_USAGE,"target":"#/properties/cpuWasteCoreH"},"usage-kpi-mem-waste":{"source":UKPI,"params":P_USAGE,"target":"#/properties/memWasteGbH"},"usage-kpi-scopes":{"source":UKPI,"params":P_USAGE,"target":"#/properties/scopesWithUsage"},
      "usage-trend":{"source":UTREND,"params":P_USAGE,"target":"#/properties/usageTrend"},"usage-table":{"source":UTABLE,"params":P_USAGE,"target":"#/properties/usageTable"}})
report={"name":"FinOps — Costos por aplicación","slug":"finops-costos-por-aplicacion","description":"Costo diario de la nube atribuido a cada aplicación null: por scope, servicio y aplicación, con dimensiones (environment), cuenta, categoría y servicio de nube. Fuente: catálogo cost_daily (hechos alocados) en el Lake.","schema":schema,"ui_schema":ui,"queries":queries,"visibility":"user","category_id":None,"nrn_level":"organization"}
json.dump(report,open(ARGS.out,'w'),ensure_ascii=False,indent=1)
# binding check
props=schema['properties']
for k,q in queries.items():
    t=q['target'].split('/')[-1]; assert t in props, (k,t)
for el in json.dumps(ui).split('"scope": "#/properties/')[1:]:
    p=el.split('"')[0]; assert p in props, p
print("report written to", ARGS.out, "queries:", len(queries))
