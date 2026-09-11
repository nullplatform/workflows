import { describe, expect, test } from "bun:test";
import { coerceDates, mergePage, runCall, runRequest, validateRequest, type ClientFactory } from "../src/runner";

/** Fake factory: pages keyed by the token the caller passes back. */
function fakeFactory(pages: Record<string, Record<string, unknown>>, seen: Record<string, unknown>[] = []): ClientFactory {
  return {
    client() {
      return {
        async send(cmd: unknown) {
          const input = cmd as Record<string, unknown>;
          seen.push(input);
          const tok = (input.NextPageToken ?? input.NextToken ?? "") as string;
          const page = pages[tok];
          if (!page) throw Object.assign(new Error(`no page for token "${tok}"`), { name: "NoSuchPage" });
          return page;
        },
      };
    },
    command(_s, _op, input) {
      return input;
    },
  };
}

describe("mergePage", () => {
  test("concats arrays, keeps last scalar, drops tokens and metadata", () => {
    const acc = mergePage({}, { ResultsByTime: [1], Total: "a", NextPageToken: "x", $metadata: {} });
    mergePage(acc, { ResultsByTime: [2, 3], Total: "b" });
    expect(acc).toEqual({ ResultsByTime: [1, 2, 3], Total: "b" });
  });
});

describe("runCall", () => {
  test("follows NextPageToken and merges pages", async () => {
    const seen: Record<string, unknown>[] = [];
    const f = fakeFactory(
      {
        "": { ResultsByTime: [{ d: 1 }], NextPageToken: "p2" },
        p2: { ResultsByTime: [{ d: 2 }], NextPageToken: "p3" },
        p3: { ResultsByTime: [{ d: 3 }] },
      },
      seen,
    );
    const r = await runCall({ id: "c", service: "ce", operation: "GetCostAndUsage", params: { Granularity: "DAILY" } }, "us-east-1", f, 1 << 20);
    expect(r.ok).toBe(true);
    expect(r.pages).toBe(3);
    expect(r.result).toEqual({ ResultsByTime: [{ d: 1 }, { d: 2 }, { d: 3 }] });
    expect(seen[1]).toEqual({ Granularity: "DAILY", NextPageToken: "p2" });
  });

  test("respects maxPages and paginate=false", async () => {
    const f = fakeFactory({ "": { Items: [1], NextToken: "n" }, n: { Items: [2], NextToken: "n" } });
    const capped = await runCall({ id: "c", service: "ec2", operation: "DescribeInstances", maxPages: 2 }, "us-east-1", f, 1 << 20);
    expect(capped.pages).toBe(2);
    expect(capped.result?.Items).toEqual([1, 2]);
    const single = await runCall({ id: "c", service: "ec2", operation: "DescribeInstances", paginate: false }, "us-east-1", f, 1 << 20);
    expect(single.pages).toBe(1);
  });

  test("reports SDK errors per call without throwing", async () => {
    const f = fakeFactory({});
    const r = await runCall({ id: "bad", service: "ce", operation: "GetCostAndUsage" }, "us-east-1", f, 1 << 20);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("NoSuchPage");
  });

  test("caps oversized results", async () => {
    const f = fakeFactory({ "": { Blob: "x".repeat(2000) } });
    const r = await runCall({ id: "big", service: "ce", operation: "GetCostAndUsage" }, "us-east-1", f, 1000);
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("RESULT_TOO_LARGE");
  });
});

describe("runCall pagination keys", () => {
  test("follows PaginationToken (tagging API) and stops on the empty last-page token", async () => {
    const seen: Record<string, unknown>[] = [];
    const f: ClientFactory = {
      client() {
        return {
          async send(cmd: unknown) {
            const input = cmd as Record<string, unknown>; seen.push(input);
            const tok = (input.PaginationToken ?? "") as string;
            return tok === "" ? { ResourceTagMappingList: [1], PaginationToken: "p2" } : { ResourceTagMappingList: [2], PaginationToken: "" };
          },
        };
      },
      command(_s, _op, input) { return input; },
    };
    const r = await runCall({ id: "t", service: "tagging", operation: "GetResources" }, "us-east-1", f, 1 << 20);
    expect(r.pages).toBe(2);
    expect(r.result?.ResourceTagMappingList).toEqual([1, 2]);
    expect(seen[1]).toEqual({ PaginationToken: "p2" });
  });
});

describe("runRequest", () => {
  test("runs calls in order and keeps going after a failure", async () => {
    const f = fakeFactory({ "": { Ok: true } });
    const lines: string[] = [];
    const res = await runRequest(
      { region: "sa-east-1", calls: [{ id: "a", service: "ce", operation: "GetCostAndUsage" }, { id: "b", service: "ce", operation: "GetCostAndUsage", params: { NextPageToken: "missing" } }] },
      f,
      (l) => lines.push(l),
    );
    expect(res.region).toBe("sa-east-1");
    expect(res.calls.map((c) => [c.id, c.ok])).toEqual([["a", true], ["b", false]]);
    expect(lines.length).toBe(4);
  });
});

describe("validateRequest", () => {
  test("rejects malformed requests", () => {
    expect(validateRequest(null)).toContain("object");
    expect(validateRequest({ calls: [] })).toContain("non-empty");
    expect(validateRequest({ provider: "gcp", calls: [{ id: "a", service: "ce", operation: "X" }] })).toContain("unsupported provider");
    expect(validateRequest({ calls: [{ id: "a", service: "ce", operation: "getCostAndUsage" }] })).toContain("PascalCase");
    expect(validateRequest({ calls: [{ id: "a", service: "ce", operation: "GetCostAndUsage" }] })).toBeUndefined();
  });
  test("validates callback url", () => {
    const calls = [{ id: "a", service: "ce", operation: "GetCostAndUsage" }];
    expect(validateRequest({ calls, callback: { url: "ftp://x" } })).toContain("callback.url");
    expect(validateRequest({ calls, callback: { url: "http://host.docker.internal:3000/cb", token: "t" } })).toBeUndefined();
  });
});

describe("coerceDates", () => {
  test("turns ISO strings under *Time keys into Dates, leaves Cost Explorer periods alone", () => {
    const out = coerceDates({ StartTime: "2026-09-09T00:00:00Z", EndTime: "2026-09-10T00:00:00.000Z", TimePeriod: { Start: "2026-09-09", End: "2026-09-10" }, MetricQueries: [{ Metric: "db.load.avg" }], Name: "x" }) as Record<string, unknown>;
    expect(out.StartTime).toBeInstanceOf(Date);
    expect((out.EndTime as Date).toISOString()).toBe("2026-09-10T00:00:00.000Z");
    expect(out.TimePeriod).toEqual({ Start: "2026-09-09", End: "2026-09-10" });
    expect(out.MetricQueries).toEqual([{ Metric: "db.load.avg" }]);
    expect(out.Name).toBe("x");
  });
});
