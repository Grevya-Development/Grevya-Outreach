"use server";

import { refresh } from "next/cache";
import type { ActionResult } from "@/components/client";
import { canProbeSmtp, verifyAddress, type VerifyResult } from "@/lib/email-verify";
import { findEmail, type FindResult } from "@/lib/email-finder";
import { db, must } from "@/lib/supabase";
import { requireAuth } from "./auth";

export interface VerifierCapabilities {
  smtp: boolean;
}

export async function verifierCapabilities(): Promise<VerifierCapabilities> {
  await requireAuth();
  return { smtp: await canProbeSmtp() };
}

/** Verifies up to 25 addresses per call (the page calls this in batches to show progress). */
export async function verifyBatch(emails: string[], force = false): Promise<VerifyResult[]> {
  await requireAuth();
  const list = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))].slice(0, 25);
  // Small parallelism: friendly to DNS and to mail servers.
  const out: VerifyResult[] = [];
  for (let i = 0; i < list.length; i += 5) {
    out.push(...(await Promise.all(list.slice(i, i + 5).map((e) => verifyAddress(e, { useCache: !force })))));
  }
  return out;
}

export async function findOne(input: { first: string; last: string; domain: string }): Promise<FindResult | { ok: false; error: string }> {
  await requireAuth();
  try {
    return await findEmail(input);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Saves verified/found addresses as leads (skips anything marked invalid). */
export async function saveToLeads(rows: { email: string; first_name?: string; last_name?: string; company?: string; website?: string; status: string }[], tags: string[], campaignId?: string | null): Promise<ActionResult> {
  await requireAuth();
  const supa = db();
  const good = rows.filter((r) => r.status !== "invalid");
  if (!good.length) return { ok: false, error: "Nothing to save — all selected addresses are invalid" };
  const tagList = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  const emails = good.map((r) => r.email.toLowerCase());
  const existing = new Map(((must(await supa.from("leads").select("id, email, tags").in("email", emails)) as { id: string; email: string; tags: string[] }[])).map((l) => [l.email, l]));
  const fresh = good.filter((r) => !existing.has(r.email.toLowerCase())).map((r) => ({
    email: r.email.toLowerCase(), first_name: r.first_name ?? "", last_name: r.last_name ?? "", company: r.company ?? "", website: r.website ?? "",
    tags: tagList, status: "active", verify_status: r.status === "valid" ? "valid" : r.status === "risky" ? "risky" : "unknown",
  }));
  if (fresh.length) must(await supa.from("leads").insert(fresh));
  for (const r of good.filter((x) => existing.has(x.email.toLowerCase()))) {
    const prev = existing.get(r.email.toLowerCase())!;
    await supa.from("leads").update({ tags: [...new Set([...(prev.tags ?? []), ...tagList])], verify_status: r.status === "valid" ? "valid" : r.status === "risky" ? "risky" : "unknown" }).eq("id", prev.id);
  }
  let enrolled = 0;
  if (campaignId) {
    const ids = (must(await supa.from("leads").select("id").in("email", emails)) as { id: string }[]).map((l) => l.id);
    enrolled = Number(must(await supa.rpc("enroll_leads", { p_campaign: campaignId, p_tag: null, p_lead_ids: ids })));
  }
  refresh();
  return { ok: true, message: `Saved ${good.length} to Leads${campaignId ? `, ${enrolled} added to the campaign` : ""}` };
}
