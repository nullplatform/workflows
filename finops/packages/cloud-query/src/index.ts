import pkg from "../package.json";
import { createPlugin, registerManifest } from "@nullplatform/plugin";
import { runRequest, validateRequest, type CloudQueryRequest } from "./runner";
import { assumeRole, callerIdentity, createAwsFactory } from "./aws-factory";
import { postCallback } from "./callback";

// The manifest declares identity + channel routing. This package is dispatched
// directly by workflows through `package-exec` (agent_command), so the channel
// sources are only a fallback for notification-driven use.
const manifest = {
  name: "cloud-query",
  version: pkg.version,
  command_types: ["custom"],
  agent: {
    selector: { package: "cloud-query" },
    sources: ["service"],
  },
};
registerManifest(manifest);

// `np package publish` runs the binary with --describe to read the manifest.
if (process.argv.includes("--describe")) {
  process.stdout.write(JSON.stringify(manifest));
  process.exit(0);
}

/**
 * The action context arrives as the gRPC payload. Two shapes are accepted:
 *   { cloud_query: { ...CloudQueryRequest } }   — what workflows send via package-exec
 *   { ...CloudQueryRequest }                      — bare (tests / direct dispatch)
 */
function extractRequest(payload: unknown): unknown {
  if (payload && typeof payload === "object" && "cloud_query" in (payload as Record<string, unknown>)) {
    return (payload as Record<string, unknown>).cloud_query;
  }
  return payload;
}

createPlugin({
  async execute(req) {
    let payload: unknown;
    try {
      payload = JSON.parse(req.payload.toString("utf-8"));
    } catch (err) {
      return { success: false, errorCode: "BAD_PAYLOAD", error: `payload is not JSON: ${(err as Error).message}` };
    }
    const request = extractRequest(payload);
    const invalid = validateRequest(request);
    if (invalid) return { success: false, errorCode: "INVALID_REQUEST", error: invalid };
    const cq = request as CloudQueryRequest;

    // Output contract: progress goes to STDERR, the final response JSON is the
    // ONLY thing on STDOUT. The control plane exposes a command's stdOut/stdErr
    // to callers but drops the gRPC `data` payload, so stdout IS the result
    // channel for workflows (`JSON.parse(results.stdOut)`).
    const log = (line: string) => {
      console.error(line);
      req.emit({ stderr: `${line}\n` });
    };

    log(`[cloud-query] request: ${cq.calls.length} call(s), region ${cq.region ?? "default"}, assumeRole ${cq.assumeRole?.roleArn ?? "no"}`);
    try {
      const creds = cq.assumeRole ? await assumeRole(cq.assumeRole.roleArn, cq.assumeRole.sessionName, cq.assumeRole.externalId) : undefined;
      // Identity is informational: a missing credential chain surfaces per call
      // with the SDK's own error instead of wedging the whole request.
      const identity = await Promise.race([
        callerIdentity(creds).catch((err: Error) => ({ error: `${err.name}: ${err.message}` })),
        new Promise<{ error: string }>((resolve) => setTimeout(() => resolve({ error: "GetCallerIdentity timed out after 15s" }), 15_000)),
      ]);
      log(`[cloud-query] identity ${"arn" in identity ? identity.arn : `unavailable (${identity.error})`}`);
      const factory = createAwsFactory(creds);
      const response = await runRequest(cq, factory, log);
      if ("arn" in identity) response.identity = identity;
      if (cq.callback?.token) response.token = cq.callback.token;
      if (cq.callback) {
        const cb = await postCallback(cq.callback.url, response);
        response.callbackDelivered = cb.ok;
        log(`[cloud-query] callback ${cb.ok ? `delivered (HTTP ${cb.status})` : `FAILED: ${cb.error}`}`);
        if (!cb.ok) {
          req.emit({ stdout: JSON.stringify(response) });
          return { success: false, errorCode: "CALLBACK_FAILED", error: cb.error, data: response };
        }
      }
      req.emit({ stdout: JSON.stringify(response) });
      const failed = response.calls.filter((c) => !c.ok);
      if (failed.length > 0) {
        return { success: false, errorCode: "CALLS_FAILED", error: failed.map((c) => `${c.id}: ${c.errorCode} ${c.error}`).join("; "), data: response };
      }
      return { success: true, data: response };
    } catch (err) {
      const e = err as { name?: string; message?: string };
      return { success: false, errorCode: e.name ?? "RUNNER_FAILED", error: e.message ?? String(err) };
    }
  },
}).start();
