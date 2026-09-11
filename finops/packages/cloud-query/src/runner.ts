/**
 * cloud-query runner — generic cloud SDK call executor.
 *
 * The package carries NO cost semantics. A request is a list of SDK calls
 * (`service` + `operation` + `params`); the runner executes each one with the
 * worker's ambient credentials (IRSA / pod identity in a cluster, NP_WORKER_ENV
 * locally), follows pagination, merges pages and returns the raw responses.
 * What to ask, and what the numbers mean, lives in the workflows.
 */

export interface CloudCall {
  /** Caller-chosen id echoed back in the result. */
  id: string;
  /** SDK service alias: ce | cost-explorer | cloudwatch | ec2 | sts | tagging | elbv2 | rds */
  service: string;
  /** SDK operation name in PascalCase, e.g. GetCostAndUsage. */
  operation: string;
  params?: Record<string, unknown>;
  /** Follow NextToken/NextPageToken and merge pages (default true). */
  paginate?: boolean;
  /** Safety cap on pages per call (default 20). */
  maxPages?: number;
}

export interface CloudQueryRequest {
  provider?: "aws";
  region?: string;
  /** Optional STS AssumeRole before running the calls. */
  assumeRole?: { roleArn: string; sessionName?: string; externalId?: string };
  calls: CloudCall[];
  /** Per-call serialized result cap in bytes (default 300 KB, see DEFAULT_MAX_RESULT_BYTES). */
  maxResultBytes?: number;
  /** Where to POST the response (engine per-execution callback). Optional. */
  callback?: { url: string; token?: string };
}

export interface CloudCallResult {
  id: string;
  ok: boolean;
  pages?: number;
  durationMs: number;
  result?: Record<string, unknown>;
  error?: string;
  errorCode?: string;
}

export interface CloudQueryResponse {
  provider: "aws";
  region: string;
  identity?: { account?: string; arn?: string };
  /** `callback.token` echoed back so the caller can verify provenance. */
  token?: string;
  callbackDelivered?: boolean;
  calls: CloudCallResult[];
}

/** Minimal shape of an AWS SDK v3 client. */
export interface SdkClient {
  send(command: unknown): Promise<Record<string, unknown>>;
}

/** Builds a client + command for a call. Injected so the runner is testable. */
export interface ClientFactory {
  client(service: string, region: string): SdkClient;
  command(service: string, operation: string, input: Record<string, unknown>): unknown;
}

const PAGE_TOKEN_KEYS = ["NextPageToken", "NextToken", "NextContinuationToken", "PaginationToken", "Marker"] as const;

/** Default per-call result cap: 300 KB (see runRequest for the measurement). */
export const DEFAULT_MAX_RESULT_BYTES = 300 * 1024;

/** Merge a page into the accumulator: arrays concat, scalars/objects take the last page. */
export function mergePage(acc: Record<string, unknown>, page: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(page)) {
    if (k === "$metadata" || (PAGE_TOKEN_KEYS as readonly string[]).includes(k)) continue;
    const prev = acc[k];
    if (Array.isArray(v) && Array.isArray(prev)) acc[k] = prev.concat(v);
    else acc[k] = v;
  }
  return acc;
}

function nextToken(page: Record<string, unknown>): { key: string; value: string } | undefined {
  for (const key of PAGE_TOKEN_KEYS) {
    const v = page[key];
    if (typeof v === "string" && v.length > 0) return { key, value: v };
  }
  return undefined;
}

export async function runCall(call: CloudCall, region: string, factory: ClientFactory, maxResultBytes: number): Promise<CloudCallResult> {
  const started = Date.now();
  try {
    const client = factory.client(call.service, region);
    const paginate = call.paginate ?? true;
    const maxPages = call.maxPages ?? 20;
    let input: Record<string, unknown> = coerceDates({ ...(call.params ?? {}) }) as Record<string, unknown>;
    const merged: Record<string, unknown> = {};
    let pages = 0;
    for (;;) {
      const page = await client.send(factory.command(call.service, call.operation, input));
      pages += 1;
      mergePage(merged, page);
      const tok = paginate ? nextToken(page) : undefined;
      if (!tok || pages >= maxPages) break;
      input = { ...input, [tok.key]: tok.value };
    }
    const bytes = Buffer.byteLength(JSON.stringify(merged));
    if (bytes > maxResultBytes) {
      return { id: call.id, ok: false, pages, durationMs: Date.now() - started, errorCode: "RESULT_TOO_LARGE", error: `result is ${bytes} bytes, cap is ${maxResultBytes}; narrow the query or lower maxPages` };
    }
    return { id: call.id, ok: true, pages, durationMs: Date.now() - started, result: merged };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return { id: call.id, ok: false, durationMs: Date.now() - started, errorCode: e.name ?? "CALL_FAILED", error: e.message ?? String(err) };
  }
}

/**
 * JSON has no Date: SDK inputs that are timestamps (Performance Insights StartTime/EndTime,
 * CloudWatch GetMetricData StartTime/EndTime, …) arrive as ISO-8601 strings. Convert strings
 * under keys ending in `Time`/`Timestamp` that parse as a date. Cost Explorer's
 * TimePeriod.Start/End are plain YYYY-MM-DD strings under other keys and stay untouched.
 */
export function coerceDates(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((v) => coerceDates(v, key));
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = coerceDates(v, k);
    return out;
  }
  if (typeof value === "string" && /(Time|Timestamp)$/.test(key) && /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return value;
}

export async function runRequest(req: CloudQueryRequest, factory: ClientFactory, onProgress?: (line: string) => void): Promise<CloudQueryResponse> {
  const region = req.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
  // Measured 2026-09-10 against api.nullplatform.com: a ~360 KB stdout round-trips,
  // ~800 KB never returns (504 after 60 s) and the platform RE-DELIVERS the
  // command to the agent every ~60 s — an oversized answer is a poison pill,
  // not just a failure. Keep the default well under the observed ceiling.
  const maxResultBytes = req.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  const results: CloudCallResult[] = [];
  for (const call of req.calls) {
    onProgress?.(`[cloud-query] ${call.id}: ${call.service}.${call.operation}`);
    const r = await runCall(call, region, factory, maxResultBytes);
    onProgress?.(`[cloud-query] ${call.id}: ${r.ok ? `ok (${r.pages} page(s), ${r.durationMs} ms)` : `FAILED ${r.errorCode}: ${r.error}`}`);
    results.push(r);
  }
  return { provider: "aws", region, calls: results };
}

/** Validate the inbound request shape; returns an error string or undefined. */
export function validateRequest(x: unknown): string | undefined {
  if (!x || typeof x !== "object") return "request must be an object";
  const r = x as Partial<CloudQueryRequest>;
  if (r.provider && r.provider !== "aws") return `unsupported provider ${String(r.provider)} (only aws for now)`;
  if (!Array.isArray(r.calls) || r.calls.length === 0) return "calls must be a non-empty array";
  for (const [i, c] of r.calls.entries()) {
    if (!c || typeof c !== "object") return `calls[${i}] must be an object`;
    if (typeof c.id !== "string" || !c.id) return `calls[${i}].id is required`;
    if (typeof c.service !== "string" || !c.service) return `calls[${i}].service is required`;
    if (typeof c.operation !== "string" || !/^[A-Z][A-Za-z0-9]+$/.test(c.operation)) return `calls[${i}].operation must be PascalCase (e.g. GetCostAndUsage)`;
  }
  if (r.callback !== undefined) {
    const url = (r.callback as { url?: unknown } | null)?.url;
    if (typeof r.callback !== "object" || r.callback === null || typeof url !== "string" || !/^https?:\/\//.test(url)) {
      return "callback.url must be an http(s) URL";
    }
  }
  return undefined;
}
