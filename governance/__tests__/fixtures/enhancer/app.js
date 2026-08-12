const {AuditEnhancer, ENTITIES} = require("./audit_enhancer");
const {InMemoryCache,RedisCache} = require("./cache");
const axios = require("axios");
const {NullToken} = require("./null_token");
const {EntityEnhancer, ENTITY_TYPE} = require("./entity_enhancer");
const {EntityUtils} = require("./entity_utils");
const {dimensionIdFromUrl, nrnIdFromUrl, loginSuccessUserId, loginSuccessNrn} = require("./id_remappers");
const {processBatch} = require("./batch_handler");
const Tracer = require("@nullplatform/observability");

Tracer.init();
const TOPIC_ARN = process.env["TOPIC_ARN"];
const REDIS_URL = process.env["REDIS_URL"];
const NULL_APIKEY = process.env["NULL_APIKEY"];
const redisCache = REDIS_URL ? new RedisCache({redisUrl: REDIS_URL}) : undefined;
const cache = new InMemoryCache({l2Cache:redisCache});
const PARAMS_REGEX =  /\/parameter\/(\w+)($|\/.*)/;
const tokenGenerator = new NullToken(NULL_APIKEY, axios.create({
    baseURL:"https://authz.nullplatform.io",
    timeout: 10*1000
}));
const notificationApiClient = axios.create({
    baseURL:"https://notifications.nullplatform.io",
    timeout: 10*1000
});
const governanceApiClient = axios.create({
    baseURL:"https://governance-action-items-api-production-ufjmx.prod.nullapps.io",
    timeout: 10*1000
});
const approvalsApiClient = axios.create({
    baseURL:"https://approvals.nullplatform.io",
    timeout: 10*1000
});
const entityUtils = new EntityUtils({
    clients: {
        default: axios.create({
            baseURL:"https://api.nullplatform.io",
            timeout: 10*1000
        }),
        user: axios.create({
            baseURL:"https://users.nullplatform.io",
            timeout: 10*1000
        }),
        parameter: axios.create({
            baseURL:"https://params.nullplatform.io",
            timeout: 60*1000
        }),
        provider: axios.create({
            baseURL:"https://providers.nullplatform.io",
            timeout: 10*1000
        }),
        approval: approvalsApiClient,
        // entity_hook is served by the approvals service, not api.nullplatform.io
        // (default client) — routing it here fixes the systematic 404 on enrichment.
        entity_hook: approvalsApiClient,
        policy: axios.create({
            baseURL:"https://approvals.nullplatform.io/aproval",
            timeout: 10*1000
        }),
        approval_reply: axios.create({
            baseURL:"https://approvals.nullplatform.io/approval",
            timeout: 10*1000
        }),
        approval_action: axios.create({
            baseURL:"https://approvals.nullplatform.io/approval",
            timeout: 10*1000
        }),
        notification: notificationApiClient,
        channel: notificationApiClient,
        action_item: governanceApiClient,
        action_item_category: governanceApiClient,
    },
    tokenGenerator
});
// One instance serves every self-contained entity: the enhancer keeps no
// per-entity state (getEntityData receives the entity name on each call).
const selfContainedEnhancer = new EntityEnhancer({
    entityUtils,
    entityType: ENTITY_TYPE.SELF_CONTAINED,
    cache
});
const selfContained = (...entities) =>
    Object.fromEntries(entities.map((entity) => [entity, {entityClient: selfContainedEnhancer}]));
const dimensionConfig = {
    entityClient: new EntityEnhancer({
        entityUtils,
        expandNRN: true,
        entityType: ENTITY_TYPE.STANDARD,
        ignoreStatusCodes: [404, 401],
        cache
    }),
    idRemapper: dimensionIdFromUrl
};
const auditEnhancer = new AuditEnhancer({
    topicArn: TOPIC_ARN,
    cache,
    entityConfig: {
        [ENTITIES.USER] : {
            entityClient:new EntityEnhancer({
                entityUtils,
                expandNRN: false,
                definedEntity: "user",
                fields:[
                    {name:"user_email", key:"email"},
                    {name:"user_type", key:"type"}
                ],
                entityType: ENTITY_TYPE.STANDARD,
                cache
            })
        },
        [ENTITIES.PARAMETER] : {
            entityClient:new EntityEnhancer({
                entityUtils,
                expandNRN: true,
                definedEntity: "parameter",
                entityType: ENTITY_TYPE.STANDARD,
                queryString: "hide_values=true",
                cache
            }),
            idRemapper: async (audit) => {
                /*
                 * We use parameter id as entity_id ever, even if value or value_id is modified
                 */
                const match = audit.url.match(PARAMS_REGEX);
                if(match) {
                    return match[1];
                }
                return audit.entity_id;
            }
        },
        [ENTITIES.RUNTIME_CONFIGURATION]: {
            entityClient:new EntityEnhancer({
                entityUtils,
                expandNRN: true,
                tokenGenerator,
                entityType: ENTITY_TYPE.STANDARD,
                ignoreStatusCodes: [404,401],
                cache
            })
        },
        // Dimensions are served under two routes and therefore audited under two entity names;
        // both share one config. The API answers 401 (not 404) for deleted ones, so tolerate it,
        // and a value-id in entity_id is remapped to its parent dimension.
        "runtime_configuration/dimension": dimensionConfig,
        "dimension": dimensionConfig,
        // The API echoes the entity on every write, including DELETE
        // (governance-action-items-api#28) — enriching from the event
        // avoids the post-delete fetch that can only 404. The nrn
        // travels inside the echoed body.
        [ENTITIES.ACTION_ITEM]: {
            entityClient: selfContainedEnhancer
        },
        [ENTITIES.ACTION_ITEM_CATEGORY]: {
            entityClient: new EntityEnhancer({
                entityUtils,
                expandNRN: true,
                entityType: ENTITY_TYPE.STANDARD,
                cache
            })
        },
        // The authz permission catalog has no read endpoint (GET /authz/action 404s at the
        // router), but its writes echo the whole entity.
        [ENTITIES.AUTHZ_ACTION]: {
            entityClient: selfContainedEnhancer
        },
        // Everything main-service-api audits. Its writes echo the entity through the same schema
        // the GET serializes with, so the fetch adds nothing the event does not already carry, and
        // on a delete it can only race the removal — deletes answer 204 and travel as an
        // entity_snapshot instead (main-service-api#332). Two of these could never be fetched at
        // all: a specification with an empty visible_to is readable by nobody (its authz check has
        // no nrn to evaluate, so it 403s for every caller), and no client maps the plural names.
        ...selfContained(
            ENTITIES.SERVICE,
            ENTITIES.SERVICE_SPECIFICATION,
            ENTITIES.LINK,
            ENTITIES.LINK_SPECIFICATION,
            ENTITIES.ACTION,
            ENTITIES.ACTION_SPECIFICATION,
            ENTITIES.PACKAGES,
            ENTITIES.PACKAGE,
            ENTITIES.ARTIFACTS,
        ),
        [ENTITIES.AGENT] : {
            ignore: true
        },
        // There is no /login_success resource to fetch: entity_data comes
        // from the Cognito payload in request_body and entity_context from
        // the resolved nrn (the producer sends organization_id but no nrn).
        [ENTITIES.LOGIN_SUCCESS]: {
            entityClient: selfContainedEnhancer,
            userIdRemapper: async (audit) => loginSuccessUserId(audit),
            nrnResolver: async (audit) => loginSuccessNrn(audit)
        },
        // The notifications service can't be fetched back (it 401s the
        // enhancer's token) and it redacts its audited bodies; instead, its
        // write routes emit an allowlisted entity_snapshot (np-api-js route
        // audit extras) that extractEventEntityData prefers. Events without a
        // snapshot (e.g. produced before the service adopted it) still get
        // entity_context from the top-level nrn.
        [ENTITIES.NOTIFICATION]: {
            entityClient: selfContainedEnhancer
        },
        [ENTITIES.NOTIFICATION_CHANNEL]: {
            entityClient: selfContainedEnhancer
        },
        "nrn": {
            entityClient: new EntityEnhancer({
                entityUtils,
                entityType: ENTITY_TYPE.NRN,
                cache
            }),
            // metadata-api's POST /nrn/<nrn> audits arrive with entity_id
            // "undefined"; the NRN to parse lives in the URL path.
            idRemapper: async (audit) => nrnIdFromUrl(audit)
        },
        // Workflow-engine entities: the engine enforces absolute org isolation
        // (no cross-org token exists), so entities are never fetched back from
        // its API. Events are self-contained: entity_context comes from the
        // event's top-level nrn, entity_data from its (already redacted)
        // response_body.
        ...selfContained(
            ENTITIES.WORKFLOW,
            ENTITIES.WORKFLOW_ALIAS,
            ENTITIES.WORKFLOW_CONFIG_ENTRY,
            ENTITIES.WORKFLOW_SECRET,
            ENTITIES.WORKFLOW_EXECUTION,
            ENTITIES.WORKFLOW_SIGNAL,
            ENTITIES.WORKFLOW_WEBHOOK,
        ),
        "default": {
            entityClient:new EntityEnhancer({
                entityUtils,
                expandNRN: true,
                tokenGenerator,
                entityType: ENTITY_TYPE.STANDARD,
                cache
            })
        }
    }
});



exports.handler = async (event) => {
    return await processBatch(event.Records, (record) => auditEnhancer.enhanceAndPublish(record));
}
