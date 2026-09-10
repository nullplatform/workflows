/**
 * Push the runner response to the workflow engine's per-execution callback.
 * The URL is an unguessable capability minted by the engine; the body carries
 * the `token` the plugin issued so a forged POST cannot be mistaken for ours.
 *
 * SSRF guard: the callback URL comes from the caller's action context, and the
 * worker runs INSIDE the customer's network with an IAM role. It may only POST
 * to hosts the operator allow-listed (`NP_CALLBACK_ALLOWED_HOSTS`, comma
 * separated, default `api.nullplatform.com`). Anything else — internal
 * services, the instance metadata endpoint, arbitrary internet hosts — is
 * refused before any request is made.
 */
export interface PostCallbackOptions {
  fetchImpl?: typeof fetch;
  attempts?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Allowed callback hostnames (exact, case-insensitive). Default from env. */
  allowedHosts?: string[];
}

export type PostCallbackResult = { ok: true; status: number } | { ok: false; error: string };

export const DEFAULT_CALLBACK_ALLOWED_HOSTS = ["api.nullplatform.com"];

/** Resolve the allow-list: explicit option → NP_CALLBACK_ALLOWED_HOSTS env → default. */
export function callbackAllowedHosts(explicit?: string[], env: Record<string, string | undefined> = process.env): string[] {
  if (explicit && explicit.length > 0) return explicit.map((h) => h.trim().toLowerCase()).filter(Boolean);
  const fromEnv = (env.NP_CALLBACK_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return fromEnv.length > 0 ? fromEnv : DEFAULT_CALLBACK_ALLOWED_HOSTS;
}

/** Returns an error string when the URL must not be called, else undefined. */
export function checkCallbackUrl(url: string, allowedHosts: string[]): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `callback url is not a valid URL: ${url}`;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return `callback url must be http(s), got ${parsed.protocol}`;
  }
  if (parsed.username || parsed.password) return "callback url must not carry credentials";
  const host = parsed.hostname.toLowerCase();
  if (!allowedHosts.includes(host)) {
    return `callback host "${host}" is not allowed (NP_CALLBACK_ALLOWED_HOSTS: ${allowedHosts.join(", ")})`;
  }
  return undefined;
}

export async function postCallback(url: string, body: unknown, opts: PostCallbackOptions = {}): Promise<PostCallbackResult> {
  const denied = checkCallbackUrl(url, callbackAllowedHosts(opts.allowedHosts));
  if (denied) return { ok: false, error: denied };
  const fetchImpl = opts.fetchImpl ?? fetch;
  const attempts = opts.attempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const payload = JSON.stringify(body);
  let lastError = "";
  for (let i = 0; i < attempts; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, signal: ac.signal });
      if (res.ok) return { ok: true, status: res.status };
      lastError = `callback returned HTTP ${res.status}`;
      if (res.status < 500) return { ok: false, error: lastError };
    } catch (err) {
      lastError = `callback request failed: ${(err as Error).message}`;
    } finally {
      clearTimeout(timer);
    }
    if (i < attempts - 1) await sleep(1000 * (i + 1));
  }
  return { ok: false, error: lastError };
}
