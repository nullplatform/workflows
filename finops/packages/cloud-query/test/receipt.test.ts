import { describe, expect, test } from "bun:test";
import { buildReceipt } from "../src/receipt";
import type { CloudQueryResponse } from "../src/runner";

const big = "x".repeat(500_000);
const response = {
  provider: "aws",
  region: "us-east-1",
  identity: { account: "283477532906", arn: "arn:aws:sts::283477532906:assumed-role/k8s-np-finops-worker/s" },
  token: "tok",
  calls: [
    { id: "by_service", ok: true, pages: 1, durationMs: 400, result: { big } },
    { id: "lbs", ok: false, errorCode: "AccessDenied", error: "nope" },
  ],
} as unknown as CloudQueryResponse;

describe("callback receipt", () => {
  test("never carries results, keeps per-call status, identity, token and callback outcome", () => {
    const r = buildReceipt(response, { ok: true, status: 200 }, 512_000);
    expect(JSON.stringify(r)).not.toContain(big.slice(0, 50));
    expect(JSON.stringify(r).length).toBeLessThan(1_000);
    expect(r).toMatchObject({ provider: "aws", region: "us-east-1", token: "tok", callbackDelivered: true, callbackBytes: 512_000 });
    expect(r.identity?.account).toBe("283477532906");
    expect(r.calls).toEqual([
      { id: "by_service", ok: true, pages: 1, durationMs: 400 },
      { id: "lbs", ok: false, errorCode: "AccessDenied", error: "nope" },
    ]);
  });
  test("records a failed callback", () => {
    const r = buildReceipt(response, { ok: false, error: "host not allowed" }, 10);
    expect(r.callbackDelivered).toBe(false);
    expect(r.callbackError).toBe("host not allowed");
  });
});
