// Background email checks: the engine checks new leads' addresses a few at a time, newest first,
// so lists are clean before the first send without anyone pressing a button. Results come from
// verifyAddress (which reuses the 30-day email_checks cache).
import { verifyAddress, type VerifyStatus } from "./email-verify";
import { db } from "./supabase";
import type { Lead } from "./types";

const PARALLEL = 5;                 // friendly to DNS and to mail servers
const COOL_DOWN_MS = 30 * 60_000;   // a lead whose check failed (network, DNS) waits this long
const GIVE_UP_AFTER = 3;            // …and is marked "Couldn't confirm" after this many failures
const MAX_SCAN = 200;

type Retry = { until: number; failures: number };
const g = globalThis as { __verifyRetry?: Map<string, Retry> }; // survives hot reloads
const retries = (g.__verifyRetry ??= new Map());

type Pending = Pick<Lead, "id" | "email" | "status">;

/**
 * Checks up to `limit` leads that were never checked and saves the results on the leads.
 * Invalid addresses of leads that can still be emailed become status 'invalid'. Never throws.
 */
export async function verifyPending(limit = 25): Promise<{ checked: number; error?: string }> {
  try {
    return await run(limit);
  } catch (err) {
    return { checked: 0, error: (err as Error).message };
  }
}

async function run(limit: number): Promise<{ checked: number; error?: string }> {
  const now = Date.now();
  for (const [id, r] of retries) if (r.until < now - 86_400_000) retries.delete(id); // deleted leads
  const cooling = new Set([...retries].filter(([, r]) => r.until > now).map(([id]) => id));

  const { data, error } = await db().from("leads").select("id, email, status").is("verify_status", null)
    .order("created_at", { ascending: false }).limit(Math.min(limit + cooling.size, MAX_SCAN));
  if (error) return { checked: 0, error: error.message };
  const leads = ((data ?? []) as Pending[]).filter((l) => !cooling.has(l.id)).slice(0, limit);

  let checked = 0;
  for (let i = 0; i < leads.length; i += PARALLEL) {
    const batch = leads.slice(i, i + PARALLEL);
    const byStatus = new Map<VerifyStatus, string[]>();
    const nowInvalid: string[] = [];
    const failed: string[] = [];
    const add = (status: VerifyStatus, id: string) => byStatus.set(status, [...(byStatus.get(status) ?? []), id]);

    await Promise.all(batch.map(async (lead) => {
      try {
        // No address at all can never be checked: say so instead of retrying forever.
        if (typeof lead.email !== "string" || !lead.email.trim()) return add("unknown", lead.id);
        const r = await verifyAddress(lead.email, { strictDns: true });
        add(r.status, lead.id);
        if (r.status === "invalid" && lead.status === "active") nowInvalid.push(lead.id);
      } catch {
        // DnsUnavailableError, a socket or a database hiccup: nothing is known about the address
        // yet, so leave it unchecked and retry later.
        failed.push(lead.id);
      }
    }));

    // Count a failure against a lead only when others in the same batch worked, so a network
    // outage doesn't wear down every lead's retries.
    const networkUp = failed.length < batch.length;
    for (const id of failed) {
      const failures = (retries.get(id)?.failures ?? 0) + (networkUp ? 1 : 0);
      if (failures >= GIVE_UP_AFTER) {
        retries.delete(id);
        add("unknown", id);
      } else {
        retries.set(id, { until: Date.now() + COOL_DOWN_MS, failures });
      }
    }

    const supa = db();
    for (const [status, ids] of byStatus) {
      // Only fill in leads still unchecked: a result saved meanwhile (e.g. from the verifier) wins.
      const { error: upErr } = await supa.from("leads").update({ verify_status: status }).in("id", ids).is("verify_status", null);
      if (upErr) return { checked, error: upErr.message };
      for (const id of ids) retries.delete(id);
      checked += ids.length;
    }
    if (nowInvalid.length) {
      await supa.from("leads").update({ status: "invalid" }).in("id", nowInvalid).eq("status", "active");
    }
  }
  return { checked };
}
