const { SNSClient, PublishCommand }  = require("@aws-sdk/client-sns");
const snakecaseKeys = require('snakecase-keys')
const metrics = require('./metrics')
const ENTITIES = {
    USER: "user",
    PARAMETER:"parameter",
    AGENT:"agent",
    LOGIN_SUCCESS:"login_success",
    NOTIFICATION: "notification",
    TOKEN: "token",
    RUNTIME_CONFIGURATION: "runtime_configuration",
    APPROVAL_ACTION: "approval_action",
    LAKE: "lake",
    ACTION_ITEM: "action_item",
    ACTION_ITEM_CATEGORY: "action_item_category",
    WORKFLOW: "workflow",
    WORKFLOW_ALIAS: "workflow_alias",
    WORKFLOW_CONFIG_ENTRY: "workflow_config_entry",
    WORKFLOW_SECRET: "workflow_secret",
    WORKFLOW_EXECUTION: "workflow_execution",
    WORKFLOW_SIGNAL: "workflow_signal",
    WORKFLOW_WEBHOOK: "workflow_webhook",
    COMMIT: "commit",
    CODE_REPOSITORY: "code_repository",
    CODE_REPOSITORY_TAG: "code_repository_tag",
    ENTITY_HOOK_ACTION: "entity_hook_action",
    APPROVAL_DRY_RUN: "approval_dry_run",
    AUTHZ_ACTION: "authz_action",
    NOTIFICATION_CHANNEL: "notification/channel",
    // main-service-api. The entity name is derived from the URL, so it inherits how each route is
    // spelled: /packages and /artifacts are plural, while the package nested under a specification
    // (/service_specification/:id/package) is singular. All three arrive as distinct names.
    SERVICE: "service",
    SERVICE_SPECIFICATION: "service_specification",
    LINK: "link",
    LINK_SPECIFICATION: "link_specification",
    ACTION: "action",
    ACTION_SPECIFICATION: "action_specification",
    PACKAGES: "packages",
    PACKAGE: "package",
    ARTIFACTS: "artifacts",
}
// SNS caps a publish at 256 KiB, message plus attributes. The three attributes we set are short and
// bounded, so a flat reserve is cheaper and safer than measuring them on every event.
const SNS_BODY_BUDGET = 262144 - 1024;

const IGNORED_ENTITY_IDS= [
    "undefined",
    "null",
    "error_decoding",
    "missing_token",
    "empty/missing_token",
    "github-webhook"
];

const IGNORED_ENHANCED_ENTITY_TYPES = [
    ENTITIES.TOKEN,
    ENTITIES.LAKE,
    // Internal SCM entities: no cross-service read value; skip the fetch but
    // keep publishing the (degraded) audit so it still lands in the lake.
    ENTITIES.COMMIT,
    ENTITIES.CODE_REPOSITORY,
    ENTITIES.CODE_REPOSITORY_TAG,
    // POST /entity_hook/action/find on the approvals API: a search endpoint
    // (read via POST), so the audit has no entity_id and nothing to enrich.
    ENTITIES.ENTITY_HOOK_ACTION,
    // POST /approval/dry-run: a simulation ("would this action require
    // approval?") — creates nothing, so no entity_id. Split off from the
    // real "approval" audits by getEntityName.
    ENTITIES.APPROVAL_DRY_RUN,
]

// Producers often audit several operations under one entity name (np-api-js
// derives it from the first URL folder). When the distinction matters for
// enrichment, split the entity by URL here — first matching rule wins.
const ENTITY_NAME_REMAPS = [
    // Three APIs audit under the name "action": these two and main-service-api, which keeps the
    // bare name. Every rule here therefore decides which config an "action" audit lands on, so a
    // missing rule silently gives another producer's audit main-service-api's treatment. Ordered
    // before the approvals rule, whose pattern is a bare substring an /authz/ URL could contain.
    { entity: ENTITIES.ACTION, urlIncludes: "/authz/", to: ENTITIES.AUTHZ_ACTION },
    // Approval actions are served under /approval/* but audited as "action".
    { entity: ENTITIES.ACTION, urlIncludes: "approval", to: ENTITIES.APPROVAL_ACTION },
    // POST /approval/dry-run is a simulation (no entity behind it); split it
    // from the real "approval" writes so it can classify apart.
    { entity: "approval", urlIncludes: "/dry-run", to: ENTITIES.APPROVAL_DRY_RUN },
];

function isIgnoredEnhancedEntity(entityName) {
    return IGNORED_ENHANCED_ENTITY_TYPES.indexOf(entityName) >= 0;
}

// A 404 on the audited request means the target entity does not exist; a
// rejected write (4xx) without an entity_id means nothing was ever created.
// Note this only decides classification AFTER enrichment came back empty —
// a 404ed audit whose entity does exist still classifies as enriched.
function auditTargetsNonexistentEntity(audit) {
    const status = Number(audit?.status);
    if (status === 404) return true;
    return status >= 400 && status < 500 && !audit?.entity_id;
}

// entity_context is real enrichment when it holds at least one populated value:
// a defined scalar or a non-empty object (an NRN part like {id,name,slug}). The
// `${entity}_name`/`_slug` keys are `undefined` when a fetch yields nothing, so a
// tolerated 401/404 (empty data + only-undefined context) does not count here.
function hasContext(entityContext) {
    if (!entityContext || typeof entityContext !== "object") return false;
    return Object.values(entityContext).some((v) => {
        if (v === undefined || v === null || v === "") return false;
        if (typeof v === "object") return Object.keys(v).length > 0;
        return true;
    });
}

class AuditEnhancer {
    constructor({cache = undefined, topicArn, entityConfig}) {
        this.cache = cache;
        this.topicArn = topicArn;
        this.snsClient = new SNSClient();
        this.entityConfig =  entityConfig;
    }

    getEntityConfig(entityName) {
        let config = this.entityConfig[entityName];
        return config || this.entityConfig["default"];
    }

    async enhanceEntity({entityName, entityId, audit}){
        //Remove cache to add entity data as part of audit
        //let enhanced = await this.cache?.getEntity(entityName, entityId);
        //if(!enhanced) {
        const entityConfig =  this.getEntityConfig(entityName);
        // Self-contained enrichment reads the audit event itself, so it does not
        // require an entity_id (e.g. signals or failed writes without a body id).
        const selfContained = entityConfig.entityClient?.entityType === "self_contained";
        let data;
        if (isIgnoredEnhancedEntity(entityName) ||
            (!selfContained && (!entityId || IGNORED_ENTITY_IDS.indexOf(entityId) >= 0))) {
            data = {};
        } else {
            data = await entityConfig.entityClient.getEntityData(entityName, entityId, audit);
        }
        await this.cache?.setEntity(entityName, entityId, data);
        return data;
        //}
        //return enhanced;
    }

    // SNS caps a publish at 256 KiB counting the message and its attributes. Only entity_data is
    // dropped when the total does not fit: it is derived (for self-contained entities it is a copy
    // of response_body), while the audited bodies are the record.
    fitToSnsBudget(message) {
        const body = JSON.stringify(message);
        if (Buffer.byteLength(body, "utf8") <= SNS_BODY_BUDGET) {
            return body;
        }
        const trimmed = JSON.stringify({
            ...message,
            entity_data: {truncated: true, description: "entity too large"}
        });
        if (Buffer.byteLength(trimmed, "utf8") > SNS_BODY_BUDGET) {
            // Nothing left to drop without losing the audited bodies: SNS will reject the publish and
            // the record goes to the DLQ. Say so, or it looks like an unexplained failure.
            console.error(`Message exceeds the SNS limit even without entity_data [entity: ${message.entity}] [entity_id: ${message.entity_id}]`);
        }
        return trimmed;
    }

    async publishMessage(message) {
        const messageAtributes = {};
        // SNS rejects an attribute with an empty StringValue and fails the whole publish.
        const putAttribute = (name, value) => {
            if (value === undefined || String(value) === "") return;
            messageAtributes[name] = {DataType: "String", StringValue: String(value)};
        };
        putAttribute("organization_id", message.organization_id);
        putAttribute("entity", message.entity);
        putAttribute("entity_id", message.entity_id);

        const body = this.fitToSnsBudget(message);
        console.log(`Publishing [${body}]`);
        const command = new PublishCommand({
            TopicArn: this.topicArn,
            Message: body,
            MessageAttributes: messageAtributes,
        });
        return await this.snsClient.send(command);
    }

    async shouldDiscard({audit}) {
        if(audit) {
            if((audit.user_id==='empty/missing_token' || audit.userId==='empty/missing_token') &&
                (audit.organization_id==='empty/missing_token' || audit.organizationId==='empty/missing_token')) {
                console.log("Discarding audit with empty/missing token and organization_id");
                return true;
            }
        }
        return false;
    }

    // Outcome reflects the PRIMARY entity. Reads the raw entityEnhanced, not the
    // merged audit, so the later _changed_fields injection can't fool it.
    //  - skipped:  entity type we deliberately don't enrich (SCM, login_success, …),
    //              or an audit with no entity behind it (junk/absent id, request 404ed).
    //  - enriched: entity_data carries real fields (beyond the injected `version`)
    //              OR entity_context was populated. A SELF_CONTAINED / NRN event
    //              enriches via context rather than a body fetch — still enriched.
    //  - degraded: enrichment ran but produced nothing usable (e.g. tolerated 401).
    classifyOutcome(entityName, entityEnhanced, audit) {
        if (isIgnoredEnhancedEntity(entityName)) return "skipped";
        if (IGNORED_ENTITY_IDS.indexOf(audit?.entity_id) >= 0) return "skipped";
        const ed = entityEnhanced?.entity_data;
        const hasRealData = ed && typeof ed === "object" && Object.keys(ed).some((k) => k !== "version");
        if (hasRealData || hasContext(entityEnhanced?.entity_context)) return "enriched";
        return auditTargetsNonexistentEntity(audit) ? "skipped" : "degraded";
    }

    async enhanceAndPublish(message) {
        const messageParsed = JSON.parse(message.body);
        let audit = JSON.parse(messageParsed.Message)
        audit = snakecaseKeys(audit);
        // A write rejected for a missing path id is audited with entity_id "": nothing was created,
        // so treat it as absent.
        if(audit.entity_id === "") {
            audit.entity_id = undefined;
        }
        if(await this.shouldDiscard({audit})) {
            return;
        }
        if(audit?.headers?.["x-enhanced"] === undefined) {
            const entityName = this.getEntityName(audit);
            const method = audit?.method;
            // audit_outcome is only reported for non-GET audits.
            const dropOutcome = () => {
                if (method !== "GET") metrics.auditOutcome({outcome: "dropped", entity: entityName, method});
            };
            let entityEnhanced;
            if (method !== "GET") {
                try {
                    const entityConfig = this.getEntityConfig(entityName)
                    if(entityConfig.ignore !== undefined && entityConfig.ignore === true) {
                        return;
                    }
                    let entityId = audit.entity_id;
                    if(entityConfig.idRemapper) {
                        entityId = await entityConfig.idRemapper(audit);
                        audit.entity_id = entityId;
                    }
                    if(!entityId) {
                        const fallbackId = this.extractIdFromResponseBody(audit);
                        if(fallbackId !== undefined && fallbackId !== null) {
                            entityId = fallbackId;
                            audit.entity_id = entityId;
                        }
                    }
                    // Some producers know their entity's true nrn but don't
                    // send one (e.g. login_success). The resolver states it
                    // per entity; entities without one keep their honest
                    // empty context rather than a fabricated partial nrn.
                    if (!audit.nrn && entityConfig.nrnResolver) {
                        const resolvedNrn = await entityConfig.nrnResolver(audit);
                        if (resolvedNrn) audit.nrn = resolvedNrn;
                    }
                    entityEnhanced = await this.enhanceEntity({
                        entityName: entityName,
                        entityId: entityId,
                        audit
                    });
                }catch (e) {
                    dropOutcome();
                    console.error(`Error getting entity data [${e.message}] [${JSON.stringify(messageParsed)}] [${JSON.stringify(audit)}]`)
                    throw e;
                }
            }
            let userEnhanced;
            // Machine actors (user_type "service", e.g. the workflow worker reporting
            // step progress) carry an execution/trigger id in user_id, not a user id —
            // looking it up in the users service can only 404.
            if (audit?.user_type !== "service") {
                try {
                    // Some producers bury the actor inside the event body
                    // (e.g. login_success); recover it before the user lookup.
                    const userIdRemapper = this.getEntityConfig(entityName).userIdRemapper;
                    if (userIdRemapper) {
                        const userId = await userIdRemapper(audit);
                        if (userId !== undefined && userId !== null) audit.user_id = userId;
                    }
                    userEnhanced = await this.enhanceEntity({entityName: ENTITIES.USER, entityId: audit.user_id});
                }catch (e) {
                    dropOutcome();
                    console.error(`Error getting user data [${e.message}] [${JSON.stringify(messageParsed)}] [${JSON.stringify(audit)}]`);
                    throw e;
                }
            }
            const entityDefaults = { entity_data: {}, entity_context: {} };
            const auditEnhanced = {...userEnhanced, ...audit, ...entityDefaults, ...(entityEnhanced || {})};
            // Surface the producer-computed changed field-paths into entity_data,
            // only when the audit event actually carries them ([] = computed, no
            // changes; [...] = changed paths). Absent → no _changed_fields key.
            if (audit.changed_fields !== undefined) {
                auditEnhanced.entity_data = {
                    ...auditEnhanced.entity_data,
                    _changed_fields: audit.changed_fields,
                };
            }
            if (method !== "GET") {
                metrics.auditOutcome({outcome: this.classifyOutcome(entityName, entityEnhanced, audit), entity: entityName, method});
            }
            await this.publishMessage(auditEnhanced);
        } else {
            await this.publishMessage(audit);
        }

    }

    extractIdFromResponseBody(audit) {
        if(!audit.response_body) return undefined;
        try {
            const body = typeof audit.response_body === "string"
                ? JSON.parse(audit.response_body)
                : audit.response_body;
            return body?.id;
        } catch (e) {
            return undefined;
        }
    }

    getEntityName(audit) {
        const entityName = audit?.entity?.toLowerCase();
        const url = audit?.url?.toLowerCase();

        for (const rule of ENTITY_NAME_REMAPS) {
            if (entityName === rule.entity && url?.includes(rule.urlIncludes)) {
                return rule.to;
            }
        }
        return entityName;
    }
}


module.exports = {AuditEnhancer, ENTITIES};
