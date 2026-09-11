import { describe, expect, test } from "bun:test";
import { callbackAllowedHosts, checkCallbackUrl, postCallback } from "../src/callback";

function fakeFetch(responses: Array<number | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response("ok", { status: next ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const noSleep = async () => {};
const CB = ["cb"];

describe("postCallback", () => {
  test("POSTs JSON once on 2xx", async () => {
    const { fetchImpl, calls } = fakeFetch([200]);
    const r = await postCallback("http://cb/x", { a: 1 }, { fetchImpl, sleep: noSleep, allowedHosts: CB });
    expect(r).toEqual({ ok: true, status: 200 });
    expect(calls.length).toBe(1);
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(calls[0]!.init.body).toBe(JSON.stringify({ a: 1 }));
  });
  test("retries on 5xx and network errors, then succeeds", async () => {
    const { fetchImpl, calls } = fakeFetch([503, new Error("ECONNRESET"), 200]);
    const r = await postCallback("http://cb/x", {}, { fetchImpl, sleep: noSleep, attempts: 3, allowedHosts: CB });
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(3);
  });
  test("does not retry on 4xx", async () => {
    const { fetchImpl, calls } = fakeFetch([404]);
    const r = await postCallback("http://cb/x", {}, { fetchImpl, sleep: noSleep, allowedHosts: CB });
    expect(r).toEqual({ ok: false, error: "callback returned HTTP 404" });
    expect(calls.length).toBe(1);
  });
  test("gives up after attempts", async () => {
    const { fetchImpl, calls } = fakeFetch([500, 500, 500]);
    const r = await postCallback("http://cb/x", {}, { fetchImpl, sleep: noSleep, attempts: 3, allowedHosts: CB });
    expect(r.ok).toBe(false);
    expect(calls.length).toBe(3);
  });
  test("refuses hosts outside the allow-list without making a request", async () => {
    const { fetchImpl, calls } = fakeFetch([200]);
    const r = await postCallback("http://169.254.169.254/latest/meta-data", {}, { fetchImpl, sleep: noSleep, allowedHosts: CB });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("not allowed");
    expect(calls.length).toBe(0);
  });
});

describe("checkCallbackUrl", () => {
  const allowed = ["api.nullplatform.com", "host.docker.internal"];
  test("accepts allow-listed hosts case-insensitively", () => {
    expect(checkCallbackUrl("https://API.nullplatform.com/workflows/webhooks/callback/e/s", allowed)).toBeUndefined();
    expect(checkCallbackUrl("http://host.docker.internal:3000/x", allowed)).toBeUndefined();
  });
  test("rejects other hosts, non-http schemes, credentials and garbage", () => {
    expect(checkCallbackUrl("https://evil.example/x", allowed)).toContain("not allowed");
    expect(checkCallbackUrl("http://10.0.0.5/x", allowed)).toContain("not allowed");
    expect(checkCallbackUrl("ftp://api.nullplatform.com/x", allowed)).toContain("http(s)");
    expect(checkCallbackUrl("https://u:p@api.nullplatform.com/x", allowed)).toContain("credentials");
    expect(checkCallbackUrl("not a url", allowed)).toContain("not a valid URL");
  });
});

describe("callbackAllowedHosts", () => {
  test("defaults to api.nullplatform.com", () => {
    expect(callbackAllowedHosts(undefined, {})).toEqual(["api.nullplatform.com"]);
  });
  test("reads NP_CALLBACK_ALLOWED_HOSTS", () => {
    expect(callbackAllowedHosts(undefined, { NP_CALLBACK_ALLOWED_HOSTS: " Host.Docker.Internal, api.nullplatform.com ,, " })).toEqual([
      "host.docker.internal",
      "api.nullplatform.com",
    ]);
  });
  test("explicit list wins", () => {
    expect(callbackAllowedHosts(["cb"], { NP_CALLBACK_ALLOWED_HOSTS: "x" })).toEqual(["cb"]);
  });
});
