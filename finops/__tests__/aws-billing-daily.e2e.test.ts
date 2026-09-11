/**
 * E2E for finops/wf1-aws-billing-daily.yaml + finops/wf-cost-fact-upsert.yaml.
 * The cloud-query child is stubbed at the `sub-workflow` plugin level with
 * realistic Cost Explorer / EC2 shapes; the fact writer child is captured so
 * the test asserts WHAT would be upserted (ids, dimensions, sum rule).
 */
import { resolve } from 'node:path';
import { runWorkflowE2E } from '@nullplatform/workflow-kit/test';
import { describe, expect, it } from 'vitest';

const DIR = resolve(__dirname, '..');
const COLLECTOR = resolve(DIR, 'wf1-aws-billing-daily.yaml');
const UPSERT = resolve(DIR, 'wf-cost-fact-upsert.yaml');

const passthroughTrigger = {
  handler: () => ({ status: 'success' as const, outputs: {}, activePorts: ['default'] }),
  registryType: 'trigger' as const,
};

const EC2 = 'Amazon Elastic Compute Cloud - Compute';
const EKS = 'Amazon Elastic Container Service for Kubernetes';
const ELB = 'Amazon Elastic Load Balancing';
const VPC = 'Amazon Virtual Private Cloud';
const EC2O = 'EC2 - Other';
const RDS = 'Amazon Relational Database Service';

function ceGroups(groups: Array<[string[], number, number?]>, unit = 'Hrs') {
  return {
    ResultsByTime: [
      {
        TimePeriod: { Start: '2026-09-09', End: '2026-09-10' },
        Groups: groups.map(([keys, cost, qty]) => ({
          Keys: keys,
          Metrics: {
            AmortizedCost: { Amount: String(cost), Unit: 'USD' },
            UnblendedCost: { Amount: String(cost * 0.5), Unit: 'USD' },
            ...(qty !== undefined ? { UsageQuantity: { Amount: String(qty), Unit: unit } } : {}),
          },
        })),
      },
    ],
  };
}

const RESULTS = {
  identity: { Account: '688720756067' },
  by_service: ceGroups([[[EC2], 12.5], [[EKS], 2.4], [['Amazon Simple Storage Service'], 0.6], [[ELB], 2.0], [[VPC], 3.0], [[EC2O], 4.0], [[RDS], 1.0]]),
  by_usage_type: ceGroups([
    [[EC2, 'BoxUsage:c5a.xlarge'], 7.4, 24],
    [[EC2, 'BoxUsage:t3.micro'], 5.1, 72],
    [[EKS, 'AmazonEKS-Hours:perCluster'], 2.4, 24],
    [['Amazon Simple Storage Service', 'TimedStorage-ByteHrs'], 0.6, 10],
    [[ELB, 'LoadBalancerUsage'], 2.0, 96],
    [[VPC, 'USE1-VpcEndpoint-Hours'], 2.0, 144],
    [[VPC, 'USE1-PublicIPv4:InUseAddress'], 1.0, 312],
    [[EC2O, 'EBS:VolumeUsage.gp3'], 2.0, 20],
    [[EC2O, 'NatGateway-Hours'], 1.5, 24],
    [[EC2O, 'CPUCredits:t3'], 0.5, 5],
    [[RDS, 'Aurora:StorageUsage'], 1.0, 1],
  ]),
  ec2_by_resource: ceGroups([
    [['i-node1'], 3.7, 24],
    [['i-node2'], 3.7, 24],
    [['i-scope1'], 0.25, 24],
    [['i-loose'], 4.85, 24],
    [['NoResourceId'], 0, 0],
  ]),
  volumes: {
    Volumes: [
      { VolumeId: 'vol-n1', Size: 20, VolumeType: 'gp3', Attachments: [{ InstanceId: 'i-node1' }] },
      { VolumeId: 'vol-n2', Size: 20, VolumeType: 'gp3', Attachments: [{ InstanceId: 'i-node2' }] },
      { VolumeId: 'vol-s1', Size: 10, VolumeType: 'gp3', Attachments: [{ InstanceId: 'i-scope1' }] },
      { VolumeId: 'vol-x', Size: 30, VolumeType: 'gp3', Attachments: [] },
    ],
  },
  tagged: {
    ResourceTagMappingList: [
      { ResourceARN: 'arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/app/k8s-a/1', Tags: [{ Key: 'elbv2.k8s.aws/cluster', Value: 'developent' }] },
      { ResourceARN: 'arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/net/k8s-b/2', Tags: [{ Key: 'elbv2.k8s.aws/cluster', Value: 'developent' }] },
      { ResourceARN: 'arn:aws:rds:us-east-1:1:cluster:transactions', Tags: [{ Key: 'application_id', Value: '111' }, { Key: 'application', Value: 'payments' }] },
    ],
  },
  lbs: { LoadBalancers: [{ LoadBalancerName: 'k8s-a' }, { LoadBalancerName: 'k8s-b' }, { LoadBalancerName: 'null-main' }, { LoadBalancerName: 'other' }] },
  db_clusters: { DBClusters: [{ DBClusterIdentifier: 'transactions', DBClusterArn: 'arn:aws:rds:us-east-1:1:cluster:transactions', Engine: 'aurora-mysql', TagList: [], Endpoint: 'transactions.cluster-abc.us-east-1.rds.amazonaws.com',
    DBClusterMembers: [{ DBInstanceIdentifier: 'transactions-writer', IsClusterWriter: true }, { DBInstanceIdentifier: 'transactions-reader', IsClusterWriter: false }] }] },
  db_instances: { DBInstances: [
    { DBInstanceIdentifier: 'transactions-writer', DBClusterIdentifier: 'transactions', DbiResourceId: 'db-WRITER', PerformanceInsightsEnabled: true },
    { DBInstanceIdentifier: 'transactions-reader', DBClusterIdentifier: 'transactions', DbiResourceId: 'db-READER', PerformanceInsightsEnabled: true },
  ] },
  instances: {
    Reservations: [
      {
        Instances: [
          { InstanceId: 'i-node1', InstanceType: 'c5a.xlarge', Tags: [{ Key: 'eks:cluster-name', Value: 'developent' }] },
          { InstanceId: 'i-node2', InstanceType: 'c5a.xlarge', Tags: [{ Key: 'kubernetes.io/cluster/developent', Value: 'owned' }] },
          {
            InstanceId: 'i-scope1',
            InstanceType: 't3.micro',
            Tags: [
              { Key: 'scope_id', Value: '2001580306' },
              { Key: 'scope', Value: 'development-uruguay' },
              { Key: 'application_id', Value: '854932899' },
              { Key: 'application', Value: 'sebas-correa-ec-2-logs' },
              { Key: 'namespace_id', Value: '156896248' },
              { Key: 'namespace', Value: 'sebas-correa-ec-2' },
            ],
          },
          { InstanceId: 'i-loose', InstanceType: 't3.micro', Tags: [{ Key: 'Name', Value: 'jumper2' }] },
        ],
      },
    ],
  },
};

/** null services as returned by GET /service?show_descendants=true (the DB maps by host). */
const NP_SERVICES = {
  results: [
    { id: 'c80961c8', name: 'transactions', slug: 'transactions', type: 'dependency', entity_nrn: 'organization=1255165411:account=95118862:namespace=1649279267:application=1469122850',
      attributes: { host: 'TRANSACTIONS.cluster-abc.us-east-1.rds.amazonaws.com', port: 3306 }, dimensions: { environment: 'production' } },
    { id: 'other', name: 'Lending DB', type: 'dependency', entity_nrn: 'organization=1255165411:account=95118862:namespace=1:application=2', attributes: { hostname: '172.20.78.58' } },
  ],
};
const npApiStub = {
  handler: () => ({ status: 'success' as const, outputs: { status: 200, body: NP_SERVICES }, activePorts: ['default'] }),
  executeMode: 'all' as const,
};

const TYPES_RESULTS = {
  // Performance Insights db.load by database on the cluster WRITER (second round)
  pi_transactions: { MetricList: [
    { Key: { Metric: 'db.load.avg' }, DataPoints: [{ Value: 1.0 }] },
    { Key: { Metric: 'db.load.avg', Dimensions: { 'db.name': 'orders', 'db.id': 'x' } }, DataPoints: [{ Value: 0.75 }] },
    { Key: { Metric: 'db.load.avg', Dimensions: { 'db.name': 'ledger', 'db.id': 'y' } }, DataPoints: [{ Value: 0.25 }] },
  ] },
  instance_types: {
    InstanceTypes: [
      { InstanceType: 'c5a.xlarge', VCpuInfo: { DefaultVCpus: 4 }, MemoryInfo: { SizeInMiB: 8192 } },
      { InstanceType: 't3.micro', VCpuInfo: { DefaultVCpus: 2 }, MemoryInfo: { SizeInMiB: 1024 } },
    ],
  },
};

/** The two cloud-query calls of the collector, keyed by step id. */
function cloudQueryStub(seen: Array<Record<string, unknown>> = []) {
  return {
    handler: (ctx: { stepId: string; inputs: Record<string, unknown> }) => {
      seen.push({ ...ctx.inputs, __step: ctx.stepId });
      const results = ctx.stepId === 'query_types' ? TYPES_RESULTS : RESULTS;
      return {
        status: 'success' as const,
        outputs: { results, identity: { account: '688720756067' }, failed: [] },
        activePorts: ['default'],
      };
    },
    executeMode: 'all' as const,
  };
}

describe('finops/wf1-aws-billing-daily', () => {
  it('builds dimensioned facts whose cloud_service sum equals the daily total, and fans out one upsert per fact', async () => {
    const queries: Array<Record<string, unknown>> = [];
    const written: Array<Record<string, unknown>> = [];
    const result = await runWorkflowE2E({
      yamlPath: COLLECTOR,
      inputs: { date: '2026-09-09', agent_tags: { package: 'cloud-query', local: 'x' }, agent_nrn: 'organization=1255165411:account=95118862', assume_role_arn: 'arn:aws:iam::111122223333:role/np-finops', assume_role_external_id: 'kwik-ext', package_version: '0.0.1', expected_account: '688720756067', target_name: 'kwik' },
      pluginStubs: {
        manual: passthroughTrigger,
        cron: passthroughTrigger, // wf1 has no cron since the dispatcher schedules it; harmless
        'np-api-call': npApiStub,
        'sub-workflow': {
          handler: (ctx: { stepId: string; inputs: Record<string, unknown> }) => {
            if (ctx.stepId === 'query' || ctx.stepId === 'query_types') return cloudQueryStub(queries).handler(ctx);
            written.push(ctx.inputs.fact as Record<string, unknown>);
            return { status: 'success' as const, outputs: { id: (ctx.inputs.fact as { id: string }).id, status: 200 }, activePorts: ['default'] };
          },
          executeMode: 'all' as const,
        },
      },
    });
    const facts = result.outputs?.facts as Array<Record<string, unknown>>;
    const summary = result.outputs?.summary as Record<string, unknown>;

    // two cloud-query rounds: the day's calls, then the instance types seen
    expect(queries.map((q) => q.__step)).toEqual(['query', 'query_types']);
    const calls = queries[0]?.calls as Array<{ id: string; params?: { TimePeriod?: { Start: string; End: string } } }>;
    expect(calls.map((c) => c.id)).toEqual(['identity', 'by_service', 'by_usage_type', 'ec2_by_resource', 'instances', 'volumes', 'tagged', 'lbs', 'db_clusters', 'db_instances']);
    expect(calls[1]?.params?.TimePeriod).toEqual({ Start: '2026-09-09', End: '2026-09-10' });
    expect(queries[0]?.agent_tags).toEqual({ package: 'cloud-query', local: 'x' });
    expect(queries.map((q) => q.agent_nrn)).toEqual(['organization=1255165411:account=95118862', 'organization=1255165411:account=95118862']);
    for (const q of queries) {
      expect(q.assume_role_arn).toBe('arn:aws:iam::111122223333:role/np-finops');
      expect(q.assume_role_external_id).toBe('kwik-ext');
      expect(q.package_version).toBe('0.0.1');
    }
    expect(summary.target).toBe('kwik');
    const typeCalls = queries[1]?.calls as Array<{ id: string; params: { InstanceTypes: string[] } }>;
    expect(typeCalls[0]?.params.InstanceTypes).toEqual(['c5a.xlarge', 't3.micro']);

    // sum rule over cloud_service (7 services, 25.5 amortized)
    const svc = facts.filter((f) => f.subject_type === 'cloud_service');
    expect(svc).toHaveLength(7);
    expect(svc.reduce((a, f) => a + (f.cost_usd as number), 0)).toBeCloseTo(25.5, 6);
    expect(summary.daily_total_usd).toBeCloseTo(25.5, 6);

    // usage-type buckets are breakdowns of their service fact
    const utBuckets = facts.filter((f) => f.subject_type === 'bucket' && f.usage_type);
    expect(utBuckets).toHaveLength(11);
    expect(utBuckets.find((b) => b.usage_type === 'BoxUsage:c5a.xlarge')?.parent_id).toBe(`raw-cloud_service-amazon-elastic-compute-cloud-compute-2026-09-09`);

    // tagged scope: direct_tag with null dimensions from the instance tags
    const scope = facts.find((f) => f.subject_type === 'scope');
    expect(scope).toMatchObject({
      id: 'raw-scope-2001580306-2026-09-09',
      allocation_method: 'direct_tag',
      scope_id: '2001580306',
      scope_name: 'development-uruguay',
      application_id: '854932899',
      application_name: 'sebas-correa-ec-2-logs',
      namespace_id: '156896248',
      namespace_name: 'sebas-correa-ec-2',
      cloud_account: '688720756067',
      region: 'us-east-1',
      resource_id: 'i-scope1',
      resource_type: 'ec2:instance',
      cost_usd: 0.25,
      unblended_usd: 0.125,
      source: 'aws_ce',
    });

    // cluster nodes get NO row of their own: their cost is the cluster's `nodes` component
    expect(facts.filter((f) => f.subject_type === 'resource' && f.cluster === 'developent')).toEqual([]);
    expect(facts.filter((f) => f.subject_type === 'resource' && f.resource_type === 'ec2:instance')).toEqual([]);

    // cluster = nodes 7.4 + control plane 2.4 + LBs 2.0×(2/4)=1.0 + networking (VPC 3.0 + NAT 1.5)=4.5
    //         + storage EBS 2.0×(40/80)=1.0 + other CPUCredits 0.5×(2/4)=0.25 → 16.55
    const cluster = facts.find((f) => f.subject_type === 'cluster');
    expect(cluster).toMatchObject({ id: 'raw-cluster-developent-2026-09-09', cluster: 'developent', allocation_method: 'unallocated', quantity: 2, units: 'nodes' });
    expect(cluster?.cost_usd).toBeCloseTo(16.55, 6);
    const comps = Object.fromEntries(facts.filter((f) => f.subject_type === 'bucket' && f.component).map((b) => [b.component, b.cost_usd]));
    // networking is split by the cloud service it comes from (VPC 3.0 vs EC2-Other NAT 1.5) so the allocator can reconcile per service
    expect(comps).toEqual({ nodes: 7.4, control_plane: 2.4, load_balancers: 1.0, networking: 3.0, networking_ec2: 1.5, storage: 1.0, other: 0.25 });
    for (const b of facts.filter((f) => f.subject_type === 'bucket' && f.component)) {
      expect(b.parent_id).toBe(cluster?.id);
      expect(typeof b.cloud_service).toBe('string');
    }
    // every fact carries `day` (a filterable copy of `date`) and evidence for mapping rules where it exists
    for (const f of facts) expect(f.day).toBe('2026-09-09');
    expect(facts.find((f) => f.subject_type === 'scope')?.tags).toMatchObject({ scope_id: expect.any(String) });
    expect(facts.find((f) => f.subject_type === 'service' && f.subject_id === 'transactions')?.host).toMatch(/rds\.amazonaws\.com$/);
    // second round asked Performance Insights for the cluster WRITER, and the shares by database travel with the fact
    const round2 = queries[1]?.calls as Array<{ id: string; service: string; params: Record<string, unknown> }>;
    expect(round2.map((c) => c.id)).toEqual(['instance_types', 'pi_transactions']);
    expect(round2[1]).toMatchObject({ service: 'pi', params: { Identifier: 'db-WRITER', StartTime: '2026-09-09T00:00:00Z', EndTime: '2026-09-10T00:00:00Z', PeriodInSeconds: 86400 } });
    expect(facts.find((f) => f.subject_id === 'transactions')).toMatchObject({ metric: 'pi.db.load', metric_shares: { orders: 0.75, ledger: 0.25 } });

    // blended rates over reserved capacity: 2 × c5a.xlarge × 24 h = 192 core-h, 384 GiB-h; cpu_share 0.5
    expect(cluster?.cpu_capacity_core_h).toBe(192);
    expect(cluster?.mem_capacity_gb_h).toBe(384);
    expect(cluster?.cpu_share).toBe(0.5);
    expect(cluster?.rate_cpu_usd_core_h).toBeCloseTo((16.55 * 0.5) / 192, 6);
    expect(cluster?.rate_mem_usd_gb_h).toBeCloseTo((16.55 * 0.5) / 384, 6);
    expect((summary.clusters as Array<Record<string, unknown>>)[0]).toMatchObject({ cluster: 'developent', cost_usd: 16.55, nodes: 2, lbs: 2, ebs_gb: 40 });

    // the Aurora cluster becomes a service fact carrying the RDS cost, mapped to the null service by host
    // (case-insensitive) → owner application from the service NRN, allocation_method service_owner
    const db = facts.find((f) => f.subject_type === 'service');
    expect(db).toMatchObject({
      id: 'raw-service-transactions-2026-09-09', resource_type: 'rds:cluster', usage_type: 'aurora-mysql', cost_usd: 1.0,
      service_id: 'c80961c8', service_name: 'transactions', application_id: '1469122850', namespace_id: '1649279267', account_id: '95118862',
      environment: 'production', nrn: 'organization=1255165411:account=95118862:namespace=1649279267:application=1469122850', allocation_method: 'service_owner',
    });

    // instances that are neither nodes nor scopes (terminated before collection, untagged)
    // collapse into ONE bucket per day; NoResourceId is dropped
    const loose = facts.find((f) => f.subject_id === 'ec2-instances-unattributed');
    expect(loose).toMatchObject({ subject_type: 'bucket', cost_usd: 4.85, quantity: 1, units: 'instances', usage_hours: 24, allocation_method: 'unallocated', resource_type: 'ec2:instance' });
    expect(facts.some((f) => f.resource_id === 'i-loose')).toBe(false);
    expect(facts.some((f) => f.resource_id === 'NoResourceId')).toBe(false);

    // every fact carries the required keys and provenance
    for (const f of facts) {
      for (const k of ['id', 'date', 'stage', 'subject_type', 'subject_id', 'cloud', 'cost_usd', 'source', 'allocation_method', 'collected_at']) {
        expect(f[k], `${String(f.id)} missing ${k}`).toBeDefined();
      }
      expect(f.collector).toBe('finops_aws_billing_daily@0.2.0');
    }

    // one upsert per fact
    expect(written).toHaveLength(facts.length);
    expect(summary.written).toBe(facts.length);
  });

  it('dry_run builds the facts and writes nothing', async () => {
    const written: Array<Record<string, unknown>> = [];
    const result = await runWorkflowE2E({
      yamlPath: COLLECTOR,
      inputs: { date: '2026-09-09', dry_run: true },
      pluginStubs: {
        manual: passthroughTrigger,
        cron: passthroughTrigger, // wf1 has no cron since the dispatcher schedules it; harmless
        'np-api-call': npApiStub,
        'sub-workflow': {
          handler: (ctx: { stepId: string; inputs: Record<string, unknown> }) => {
            if (ctx.stepId === 'query' || ctx.stepId === 'query_types') return cloudQueryStub().handler(ctx);
            written.push(ctx.inputs);
            return { status: 'success' as const, outputs: {}, activePorts: ['default'] };
          },
          executeMode: 'all' as const,
        },
      },
    });
    expect((result.outputs?.facts as unknown[]).length).toBeGreaterThan(5);
    expect(written).toHaveLength(0);
    expect((result.outputs?.summary as { written: number; dry_run: boolean }).written).toBe(0);
    expect((result.outputs?.summary as { dry_run: boolean }).dry_run).toBe(true);
  });

  it('fails when the worker identity is not the expected account (wrong agent/role pairing)', async () => {
    await expect(
      runWorkflowE2E({
        yamlPath: COLLECTOR,
        inputs: { date: '2026-09-09', expected_account: '999999999999', target_name: 'other' },
        pluginStubs: {
          manual: passthroughTrigger,
          cron: passthroughTrigger,
          'np-api-call': npApiStub,
          'sub-workflow': {
            handler: (ctx: { stepId: string; inputs: Record<string, unknown> }) => cloudQueryStub().handler(ctx),
            executeMode: 'all' as const,
          },
        },
      }),
    ).rejects.toThrow(/worker identity is account 688720756067 but target other expects 999999999999/);
  });

  it('fails when a cloud-query call failed instead of writing partial facts', async () => {
    await expect(
      runWorkflowE2E({
        yamlPath: COLLECTOR,
        inputs: { date: '2026-09-09' },
        pluginStubs: {
          manual: passthroughTrigger,
          cron: passthroughTrigger,
          'np-api-call': npApiStub,
          'sub-workflow': {
            handler: () => ({ status: 'success' as const, outputs: { results: {}, identity: null, failed: ['by_service'] }, activePorts: ['default'] }),
            executeMode: 'all' as const,
          },
        },
      }),
    ).rejects.toThrow(/cloud-query calls failed: by_service/);
  });
});

describe('finops/wf-cost-fact-upsert', () => {
  it('PATCHes the catalog instance with upsert=true and the fact as body', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fact = {
      id: 'raw-cloud_service-amazon-s3-2026-09-09', date: '2026-09-09', stage: 'raw', subject_type: 'cloud_service', subject_id: 'amazon-s3',
      cloud: 'aws', cost_usd: 0.6, source: 'aws_ce', allocation_method: 'unallocated', collected_at: '2026-09-10T00:00:00Z',
    };
    const result = await runWorkflowE2E({
      yamlPath: UPSERT,
      inputs: { fact },
      pluginStubs: {
        manual: passthroughTrigger,
        'np-api-call': {
          handler: (ctx: { inputs: Record<string, unknown> }) => {
            calls.push(ctx.inputs);
            return { status: 'success' as const, outputs: { status: 200, body: { id: fact.id } }, activePorts: ['default'] };
          },
          executeMode: 'all' as const,
        },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/catalog/instances/cost_daily/raw-cloud_service-amazon-s3-2026-09-09');
    expect(calls[0]?.body).toEqual(fact);
    expect(result.outputs?.id).toBe(fact.id);
  });

  it('rejects a fact missing required keys before calling the API', async () => {
    const calls: unknown[] = [];
    await expect(
      runWorkflowE2E({
        yamlPath: UPSERT,
        inputs: { fact: { id: 'x', date: '2026-09-09' } },
        pluginStubs: {
          manual: passthroughTrigger,
          'np-api-call': { handler: () => { calls.push(1); return { status: 'success' as const, outputs: {}, activePorts: ['default'] }; }, executeMode: 'all' as const },
        },
      }),
    ).rejects.toThrow(/fact is missing/);
    expect(calls).toHaveLength(0);
  });
});
