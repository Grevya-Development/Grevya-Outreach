import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Agent, fetch as undiciFetch } from "undici";
import { env } from "./env";

// Opening a TLS connection to Supabase can take several seconds on some networks, so we keep a
// small pool of connections open and reuse them (queries then take ~0.2s instead of ~4s).
const POOL_SIZE = 10;
/** Every query gives up after this long, so a stuck socket can never hang a page forever. */
const QUERY_TIMEOUT_MS = 15_000;
type Globals = { __sbPool?: Agent; __sbClient?: SupabaseClient; __sbWarm?: ReturnType<typeof setInterval> };
const g = globalThis as Globals; // survives dev hot-reloads and is shared across route bundles

function pool(): Agent {
  g.__sbPool ??= new Agent({ connections: POOL_SIZE, keepAliveTimeout: 10 * 60_000, keepAliveMaxTimeout: 30 * 60_000, connect: { timeout: 10_000 } });
  return g.__sbPool;
}

type UndiciInit = NonNullable<Parameters<typeof undiciFetch>[1]>;

/**
 * fetch used by supabase-js. HEAD requests (`count: 'exact', head: true`) make undici close the
 * pooled socket, so the next query pays for a fresh TLS handshake. We send them as a GET with
 * limit=1 instead, drain the tiny body (the socket goes back to the pool) and hand supabase-js a
 * body-less response — it reads the count from the Content-Range header.
 */
async function sbFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const signal = init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(QUERY_TIMEOUT_MS)]) : AbortSignal.timeout(QUERY_TIMEOUT_MS);
  const opts = { ...(init as object), signal, dispatcher: pool() } as UndiciInit;
  if ((init?.method ?? "GET").toUpperCase() === "HEAD") {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!url.searchParams.has("limit")) {
      url.searchParams.set("limit", "1");
      url.searchParams.delete("offset");
    }
    const r = await undiciFetch(url, { ...opts, method: "GET" });
    await r.arrayBuffer();
    return new Response(null, { status: r.status, statusText: r.statusText, headers: r.headers as unknown as HeadersInit });
  }
  return undiciFetch(input as string, opts) as unknown as Promise<Response>;
}

/** Opens the pooled connections before a page needs them (2 now, the rest staggered). */
function warm() {
  const url = `${env.supabaseUrl}/rest/v1/app_state?select=key&limit=1`;
  const headers = { apikey: env.supabaseServiceKey, Authorization: `Bearer ${env.supabaseServiceKey}` };
  const ping = () => { undiciFetch(url, { headers, dispatcher: pool(), signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) }).then((r) => r.arrayBuffer()).catch(() => {}); };
  ping();
  ping();
  for (let i = 0; i < POOL_SIZE - 2; i++) setTimeout(ping, 300 * (i + 1)).unref?.();
}

/** Server-only Supabase client using the service-role key. Never import from client components. */
export function db(): SupabaseClient {
  if (!g.__sbClient) {
    g.__sbClient = createClient(env.supabaseUrl, env.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: sbFetch as unknown as typeof fetch },
    });
    warm();
    // Keep the connections alive between page views (idle ones get closed by the server).
    g.__sbWarm ??= setInterval(warm, 25_000);
    g.__sbWarm.unref?.();
  }
  return g.__sbClient;
}

/** Throws on Supabase errors so callers can use the data directly. */
export function must<T>(res: { data: T; error: { message: string } | null }): NonNullable<T> {
  if (res.error) throw new Error(res.error.message);
  return res.data as NonNullable<T>;
}

/** True when an RPC isn't in the database yet (an optional migration hasn't been run). */
export function isMissingRpc(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return err.code === "PGRST202" || err.code === "42883" || /Could not find the function|does not exist/i.test(err.message ?? "");
}
