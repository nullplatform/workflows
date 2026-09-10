/**
 * AWS SDK v3 client factory. Services are a fixed allow-list (the worker is a
 * compiled binary, so nothing can be required dynamically). Credentials come
 * from the default provider chain — IRSA / pod identity in a cluster,
 * NP_WORKER_ENV or an explicit AssumeRole locally.
 */
import * as ce from "@aws-sdk/client-cost-explorer";
import * as cloudwatch from "@aws-sdk/client-cloudwatch";
import * as ec2 from "@aws-sdk/client-ec2";
import * as sts from "@aws-sdk/client-sts";
import * as tagging from "@aws-sdk/client-resource-groups-tagging-api";
import * as elbv2 from "@aws-sdk/client-elastic-load-balancing-v2";
import * as rds from "@aws-sdk/client-rds";
import type { ClientFactory, SdkClient } from "./runner";

type Ctor = new (cfg: Record<string, unknown>) => SdkClient;
type Module = Record<string, unknown>;

const SERVICES: Record<string, { module: Module; client: Ctor; region?: string }> = {
  "cost-explorer": { module: ce as Module, client: ce.CostExplorerClient as unknown as Ctor, region: "us-east-1" },
  ce: { module: ce as Module, client: ce.CostExplorerClient as unknown as Ctor, region: "us-east-1" },
  cloudwatch: { module: cloudwatch as Module, client: cloudwatch.CloudWatchClient as unknown as Ctor },
  ec2: { module: ec2 as Module, client: ec2.EC2Client as unknown as Ctor },
  sts: { module: sts as Module, client: sts.STSClient as unknown as Ctor },
  tagging: { module: tagging as Module, client: tagging.ResourceGroupsTaggingAPIClient as unknown as Ctor },
  elbv2: { module: elbv2 as Module, client: elbv2.ElasticLoadBalancingV2Client as unknown as Ctor },
  rds: { module: rds as Module, client: rds.RDSClient as unknown as Ctor },
};

export const SUPPORTED_SERVICES = Object.keys(SERVICES);

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export function createAwsFactory(credentials?: AwsCredentials): ClientFactory {
  const cache = new Map<string, SdkClient>();
  return {
    client(service, region) {
      const def = SERVICES[service];
      if (!def) throw Object.assign(new Error(`unsupported service "${service}" (supported: ${SUPPORTED_SERVICES.join(", ")})`), { name: "UNSUPPORTED_SERVICE" });
      const key = `${service}:${region}`;
      let c = cache.get(key);
      if (!c) {
        const cfg: Record<string, unknown> = { region: def.region ?? region };
        if (credentials) cfg.credentials = credentials;
        c = new def.client(cfg);
        cache.set(key, c);
      }
      return c;
    },
    command(service, operation, input) {
      const def = SERVICES[service];
      if (!def) throw Object.assign(new Error(`unsupported service "${service}"`), { name: "UNSUPPORTED_SERVICE" });
      const Cmd = def.module[`${operation}Command`] as (new (i: Record<string, unknown>) => unknown) | undefined;
      if (typeof Cmd !== "function") throw Object.assign(new Error(`unknown operation ${service}.${operation}`), { name: "UNKNOWN_OPERATION" });
      return new Cmd(input);
    },
  };
}

/** Exchange ambient credentials for a role session (optional per request). */
export async function assumeRole(roleArn: string, sessionName = "np-cloud-query", externalId?: string, region = "us-east-1"): Promise<AwsCredentials> {
  const client = new sts.STSClient({ region });
  const out = await client.send(new sts.AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: sessionName, ...(externalId ? { ExternalId: externalId } : {}) }));
  const c = out.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey) throw new Error(`AssumeRole ${roleArn} returned no credentials`);
  return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, ...(c.SessionToken ? { sessionToken: c.SessionToken } : {}) };
}

export async function callerIdentity(credentials?: AwsCredentials, region = "us-east-1"): Promise<{ account?: string; arn?: string }> {
  const client = new sts.STSClient({ region, ...(credentials ? { credentials } : {}) });
  const out = await client.send(new sts.GetCallerIdentityCommand({}));
  return { ...(out.Account ? { account: out.Account } : {}), ...(out.Arn ? { arn: out.Arn } : {}) };
}
