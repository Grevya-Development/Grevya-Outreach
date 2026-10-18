import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Agent, fetch as undiciFetch } from "undici";
import { env } from "./env";

// Opening a TLS connection to Supabase can take several seconds on some networks, so we keep a
// small pool of connections open and reuse them (queries then take ~0.2s instead of ~4s).
const POOL_SIZE = 6;
type Globals = { __sbPool?: Agent; __sbClient?: SupabaseClient; __sbWarm?: ReturnType<typeof setInterval> };
const g = globalThis as Globals; // survives dev hot-reloads and is shared across route bundles

function pool(): Agent {
  g.__sbPool ??= new Agent({ connections: POOL_SIZE, keepAliveTimeout: 10 * 60_000, keepAliveMaxTimeout: 30 * 60_000, connect: { timeout: 20_000 } });
  return g.__sbPool;
}

/** Fires one tiny request per pooled connection so they're open before a page needs them. */
function warm() {
  const url = `${env.supabaseUrl}/rest/v1/app_state?select=key&limit=1`;
  const headers = { apikey: env.supabaseServiceKey, Authorization: `Bearer ${env.supabaseServiceKey}` };
  for (let i = 0; i < POOL_SIZE; i++) {
    undiciFetch(url, { headers, dispatcher: pool() }).then((r) => r.body?.cancel()).catch(() => {});
  }
}

/** Server-only Supabase client using the service-role key. Never import from client components. */
export function db(): SupabaseClient {
  if (!g.__sbClient) {
    g.__sbClient = createClient(env.supabaseUrl, env.supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: ((input: RequestInfo | URL, init?: RequestInit) => undiciFetch(input as string, { ...(init as object), dispatcher: pool() })) as unknown as typeof fetch },
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
