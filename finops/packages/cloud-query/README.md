# cloud-query

Generic cloud SDK call runner, shipped as a nullplatform **package** (`simple`
type). A workflow sends a list of SDK calls; the worker runs them with the
credentials of the pod/container it runs in (IAM role in a cluster) and returns
the raw responses. It carries no cost semantics.

## Request (`NP_ACTION_CONTEXT.cloud_query`)

| Field | Type | Notes |
|---|---|---|
| `provider` | `"aws"` | only AWS for now |
| `region` | string | default `AWS_REGION` of the worker, else `us-east-1` |
| `assumeRole` | `{ roleArn, sessionName?, externalId? }` | optional STS AssumeRole before the calls |
| `calls[]` | `{ id, service, operation, params?, paginate?, maxPages? }` | `service` in `ce`, `cost-explorer`, `cloudwatch`, `ec2`, `sts`, `tagging` (Resource Groups Tagging API), `elbv2`, `rds`; `operation` PascalCase SDK command |
| `maxResultBytes` | number | per-call cap, default 307200 |
| `callback` | `{ url, token? }` | POST the response here (engine callback); `token` is echoed. The host MUST be in `NP_CALLBACK_ALLOWED_HOSTS` (worker env, comma separated, default `api.nullplatform.com`) — SSRF guard, the worker runs inside the customer network |

## Response

`{ provider, region, identity?, token?, callbackDelivered?, calls: [{ id, ok, pages?, durationMs, result?, errorCode?, error? }] }`

Output contract: progress on **stderr**, the response JSON alone on **stdout**
(the control plane exposes a command's stdout, not the gRPC `data`). Keep
results under the cap: Cost Explorer daily grouped by SERVICE+USAGE_TYPE for
14 days is ~360 KB; larger windows must be split by the caller. Over the cap
the call fails with `RESULT_TOO_LARGE` instead of being truncated.

## Local run

```bash
export NP_API_KEY=...            # org API key (the agent registers with it)
export NP_WORKER_AWS_ACCESS_KEY_ID=... NP_WORKER_AWS_SECRET_ACCESS_KEY=...
mise run run                     # builds the image, starts the agent with tags package:cloud-query,local:$USER
docker logs -f np-cloud-query-agent
```

Dispatch by hand (sync, small):

```bash
curl -s -X POST https://api.nullplatform.com/controlplane/agent_command \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"selector":{"package":"cloud-query","local":"'$USER'"},"execution_config":{"retry":{"max_attempts":1}},
       "command":{"type":"package-exec","data":{"package":"cloud-query","environment":{"NP_ACTION_CONTEXT":"{\"cloud_query\":{\"calls\":[{\"id\":\"who\",\"service\":\"sts\",\"operation\":\"GetCallerIdentity\"}]}}"}}}}'
```

From a workflow, use the `np-package-call` plugin (async with callback) or the
`finops/tool-cloud-query.yaml` child.

## Release (registry owner only)

The worker image lives in nullplatform's public ECR:
`public.ecr.aws/nullplatform/agent-plugins/workflows/aws-cost-explorer`.
Pushing needs AWS credentials with write access to that repository, which most
people do not have; `scripts/release.sh` does the login, a multi-arch
(amd64 + arm64) buildx build from the Dockerfile, the push, and writes
`scripts/release.json` with the immutable `@sha256` reference:

```bash
export AWS_PROFILE=<profile-that-can-push>     # or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
scripts/release.sh            # version from package.json
scripts/release.sh 0.0.2      # explicit version
scripts/release.sh --dry-run  # local build only, no login/push
```

Then register the version on the platform and pin it on the customer agent:

```bash
np-preview package publish --nrn "$NRN" --image "$(jq -r .image scripts/release.json)"
# agent Helm values: worker.allowedRegistries: ["public.ecr.aws/nullplatform/*"]
#                    worker.pins: [{package: cloud-query, version: 0.0.1, image: <that ref>, serviceAccount: np-cloud-query}]
```

## Tests

`mise run test` (bun). No live AWS in tests.
