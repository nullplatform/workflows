/**
 * What the worker returns to the AGENT in callback mode.
 *
 * The full response goes to the engine through the callback. The command
 * completion the agent posts to the control plane must stay SMALL: completions
 * above ~400 KB are dropped and the command is re-delivered (measured
 * 2026-09-10/11 — a 1.1 MB completion wedged the agent for minutes and every
 * other command on it timed out). So the completion carries a receipt only:
 * per-call status, sizes, identity and the callback outcome — never results.
 */
import type { CloudQueryResponse } from "./runner";

export interface CallbackReceipt {
  provider: string;
  region?: string;
  identity?: CloudQueryResponse["identity"];
  token?: string;
  callbackDelivered: boolean;
  callbackError?: string;
  callbackBytes: number;
  calls: Array<{ id: string; ok: boolean; pages?: number; durationMs?: number; errorCode?: string; error?: string }>;
}

export function buildReceipt(
  response: CloudQueryResponse,
  cb: { ok: true; status: number } | { ok: false; error: string },
  callbackBytes: number,
): CallbackReceipt {
  return {
    provider: response.provider,
    ...(response.region ? { region: response.region } : {}),
    ...(response.identity ? { identity: response.identity } : {}),
    ...(response.token ? { token: response.token } : {}),
    callbackDelivered: cb.ok,
    ...(cb.ok ? {} : { callbackError: cb.error }),
    callbackBytes,
    calls: response.calls.map((c) => ({
      id: c.id,
      ok: c.ok,
      ...(c.pages !== undefined ? { pages: c.pages } : {}),
      ...(c.durationMs !== undefined ? { durationMs: c.durationMs } : {}),
      ...(c.ok ? {} : { errorCode: c.errorCode, error: c.error }),
    })),
  };
}
