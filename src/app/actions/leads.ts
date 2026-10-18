"use server";

import { refresh } from "next/cache";
import type { ActionResult } from "@/components/client";
import { db, must } from "@/lib/supabase";
import { verifyAddress } from "@/lib/email-verify";
import { isEmailSyntax } from "@/lib/verify";
import { requireAuth } from "./auth";

const STANDARD = ["email", "first_name", "last_name", "company", "title", "website", "linkedin", "phone", "city", "notes"] as const;
export type StandardField = (typeof STANDARD)[number];

export interface ImportRow {
  [field: string]: string;
}

export interface ImportResult {
  ok: true;
  inserted: number;
  updated: number;
  invalid: number;
  suppressed: number;
}

/**
 * Upserts leads by email. Existing leads get their fields refreshed and the tags merged;
 * status (unsubscribed/bounced) is never reset by an import.
 */
export async function importLeads(rows: ImportRow[], tags: string[], customKeys: string[]): Promise<ImportResult | { ok: false; error: string }> {
  await requireAuth();
  const supa = db();
  const tagList = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];

  const byEmail = new Map<string, ImportRow>();
  let invalid = 0;
  for (const r of rows) {
    const email = (r.email ?? "").trim().toLowerCase();
    if (!isEmailSyntax(email)) { invalid++; continue; }
    byEmail.set(email, { ...r, email });
  }
  const emails = [...byEmail.keys()];
  if (!emails.length) return { ok: true, inserted: 0, updated: 0, invalid, suppressed: 0 };

  const existing = new Map<string, { id: string; tags: string[]; custom: Record<string, string> }>();
  const suppressedSet = new Set<string>();
  for (let i = 0; i < emails.length; i += 500) {
    const chunk = emails.slice(i, i + 500);
    const [ex, sup] = await Promise.all([
      supa.from("leads").select("id, email, tags, custom").in("email", chunk).then(must),
      supa.from("suppressions").select("email").in("email", chunk).then(must),
    ]);
    for (const l of ex as { id: string; email: string; tags: string[]; custom: Record<string, string> }[]) existing.set(l.email, l);
    for (const s of sup as { email: string }[]) suppressedSet.add(s.email);
  }

  const payload = emails.map((email) => {
    const r = byEmail.get(email)!;
    const prev = existing.get(email);
    const custom: Record<string, string> = { ...(prev?.custom ?? {}) };
    for (const k of customKeys) if (r[k]?.trim()) custom[k] = r[k].trim();
    const row: Record<string, unknown> = {
      email,
      custom,
      tags: [...new Set([...(prev?.tags ?? []), ...tagList])],
    };
    for (const f of STANDARD) if (f !== "email" && r[f] !== undefined) row[f] = (r[f] ?? "").trim();
    // Only new leads get a status; existing ones keep theirs (bulk upserts must share one column set).
    if (!prev) row.status = suppressedSet.has(email) ? "unsubscribed" : "active";
    return row;
  });

  const fresh = payload.filter((r) => !existing.has(r.email as string));
  const known = payload.filter((r) => existing.has(r.email as string));
  for (const group of [fresh, known]) {
    for (let i = 0; i < group.length; i += 500) {
      const { error } = await supa.from("leads").upsert(group.slice(i, i + 500), { onConflict: "email", defaultToNull: false });
      if (error) return { ok: false, error: error.message };
    }
  }
  refresh();
  return { ok: true, inserted: emails.length - existing.size, updated: existing.size, invalid, suppressed: suppressedSet.size };
}

/**
 * Verifies leads with the E-mail Verifier (syntax, domain, disposable/role, and the mailbox
 * itself when port 25 is reachable). Up to 100 unverified leads per call.
 */
export async function verifyLeads(ids?: string[]): Promise<ActionResult> {
  await requireAuth();
  const supa = db();
  let q = supa.from("leads").select("id, email").is("verify_status", null).limit(100);
  if (ids?.length) q = supa.from("leads").select("id, email").in("id", ids);
  const leads = must(await q) as { id: string; email: string }[];
  if (!leads.length) return { ok: true, message: "Nothing left to verify" };

  const results: { id: string; status: string }[] = [];
  for (let i = 0; i < leads.length; i += 5) {
    const batch = leads.slice(i, i + 5);
    // Hunter credits are reserved for the Verifier page; bulk lead checks use free methods.
    const rs = await Promise.all(batch.map((l) => verifyAddress(l.email, { useHunter: false })));
    batch.forEach((l, j) => results.push({ id: l.id, status: rs[j].status }));
  }
  for (const status of ["valid", "invalid", "risky", "unknown"]) {
    const group = results.filter((r) => r.status === status).map((r) => r.id);
    if (group.length) await supa.from("leads").update({ verify_status: status, ...(status === "invalid" ? { status: "invalid" } : {}) }).in("id", group);
  }
  const bad = results.filter((r) => r.status === "invalid").length;
  const good = results.filter((r) => r.status === "valid").length;
  refresh();
  return { ok: true, message: `Checked ${results.length}: ${good} valid, ${bad} invalid, ${results.length - good - bad} risky/unconfirmed` };
}

export async function deleteLeads(ids: string[]): Promise<ActionResult> {
  await requireAuth();
  for (let i = 0; i < ids.length; i += 300) must(await db().from("leads").delete().in("id", ids.slice(i, i + 300)));
  refresh();
  return { ok: true, message: `Deleted ${ids.length} lead${ids.length === 1 ? "" : "s"}` };
}

export async function tagLeads(ids: string[], tag: string): Promise<ActionResult> {
  await requireAuth();
  const t = tag.trim().toLowerCase();
  if (!t) return { ok: false, error: "Enter a tag" };
  const supa = db();
  const rows = must(await supa.from("leads").select("id, tags").in("id", ids)) as { id: string; tags: string[] }[];
  await Promise.all(rows.map((r) => supa.from("leads").update({ tags: [...new Set([...r.tags, t])] }).eq("id", r.id)));
  refresh();
  return { ok: true, message: `Tagged ${rows.length} lead${rows.length === 1 ? "" : "s"} “${t}”` };
}

export async function updateLead(id: string, patch: Partial<Record<StandardField, string>> & { tags?: string[] }): Promise<ActionResult> {
  await requireAuth();
  must(await db().from("leads").update(patch).eq("id", id));
  refresh();
  return { ok: true, message: "Lead updated" };
}

export interface ManualLead {
  email: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  title?: string;
  website?: string;
  linkedin?: string;
  notes?: string;
}

/**
 * Adds leads typed or pasted by hand. Existing leads get missing fields filled in (never
 * overwritten); optionally drops them straight into a campaign.
 */
export async function addLeadsManually(input: { leads: ManualLead[]; tags: string[]; campaignId?: string | null }): Promise<ActionResult> {
  await requireAuth();
  const supa = db();
  const tags = [...new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  const rows = input.leads
    .map((l) => ({ ...l, email: l.email.trim().toLowerCase() }))
    .filter((l) => isEmailSyntax(l.email));
  if (!rows.length) return { ok: false, error: "No valid email addresses" };

  const emails = rows.map((r) => r.email);
  const existing = must(await supa.from("leads").select("*").in("email", emails)) as Record<string, unknown>[];
  const byEmail = new Map(existing.map((l) => [l.email as string, l]));
  const fields = ["first_name", "last_name", "company", "title", "website", "linkedin", "notes"] as const;

  const fresh = rows.filter((r) => !byEmail.has(r.email)).map((r) => ({
    email: r.email, tags, status: "active",
    ...Object.fromEntries(fields.map((f) => [f, (r[f] ?? "").trim()])),
  }));
  if (fresh.length) must(await supa.from("leads").insert(fresh));
  let updated = 0;
  for (const r of rows.filter((x) => byEmail.has(x.email))) {
    const prev = byEmail.get(r.email)!;
    const patch: Record<string, unknown> = { tags: [...new Set([...((prev.tags as string[]) ?? []), ...tags])] };
    for (const f of fields) if (!String(prev[f] ?? "").trim() && (r[f] ?? "").trim()) patch[f] = (r[f] ?? "").trim();
    must(await supa.from("leads").update(patch).eq("id", prev.id as string));
    updated++;
  }

  let enrolled = 0;
  if (input.campaignId) {
    const ids = (must(await supa.from("leads").select("id").in("email", emails)) as { id: string }[]).map((l) => l.id);
    enrolled = Number(must(await supa.rpc("enroll_leads", { p_campaign: input.campaignId, p_tag: null, p_lead_ids: ids })));
    if (enrolled) await supa.from("campaigns").update({ status: "paused" }).eq("id", input.campaignId).eq("status", "completed");
  }
  refresh();
  const parts = [fresh.length && `${fresh.length} added`, updated && `${updated} already existed`, input.campaignId && `${enrolled} put in the campaign`].filter(Boolean);
  return { ok: true, message: parts.join(", ") || "Nothing to add" };
}
