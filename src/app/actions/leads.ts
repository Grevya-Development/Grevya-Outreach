"use server";

import { refresh } from "next/cache";
import { applyLeadFilter, parseLeadFilter, type LeadSelection } from "@/app/(app)/leads/tabs";
import type { ActionResult } from "@/components/client";
import { fmtNum } from "@/lib/format";
import { db, must } from "@/lib/supabase";
import { isEmailSyntax } from "@/lib/verify";
import { requireAuth } from "./auth";

const STANDARD = ["email", "first_name", "last_name", "company", "title", "website", "linkedin", "phone", "city", "notes"] as const;
export type StandardField = (typeof STANDARD)[number];

export interface ImportRow {
  [field: string]: string;
}

/** What an import or a manual add did (the Add leads dialog's Done screen). */
export interface AddSummary {
  ok: true;
  inserted: number;
  updated: number;
  invalid: number;
  suppressed: number;
  /** Put in the target campaign (0 when none was picked). */
  enrolled: number;
  message?: string;
}

/** A selection can cover a whole filter; past this many leads we stop (the user narrows it). */
const MAX_SELECTION = 50_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const plural = (n: number, one: string, many = `${one}s`) => `${fmtNum(n)} ${n === 1 ? one : many}`;

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** The lead ids a selection stands for: the picked ids, or every lead matching the filter (same query as the page). */
async function resolveSelection(sel: LeadSelection): Promise<string[]> {
  if ("ids" in sel) return [...new Set((Array.isArray(sel.ids) ? sel.ids : []).filter((id) => typeof id === "string" && UUID.test(id)))];
  const f = parseLeadFilter((k) => (sel.filter as Record<string, unknown> | undefined)?.[k]);
  const ids: string[] = [];
  const PAGE = 1000;
  for (let from = 0; from < MAX_SELECTION; from += PAGE) {
    const rows = must(await applyLeadFilter(db().from("leads").select("id"), f)
      .order("created_at", { ascending: false }).order("id").range(from, from + PAGE - 1)) as { id: string }[];
    ids.push(...rows.map((r) => r.id));
    if (rows.length < PAGE) break;
  }
  return ids;
}

type CampaignInfo = { id: string; name: string; status: string };

async function campaignInfo(id: string): Promise<CampaignInfo | null> {
  const { data } = await db().from("campaigns").select("id, name, status").eq("id", id).maybeSingle();
  return (data as CampaignInfo | null) ?? null;
}

/** Where "Open campaign" goes: the builder for a draft, the Leads tab otherwise. */
function campaignHref(c: CampaignInfo): string {
  return c.status === "draft" ? `/campaigns/${c.id}?step=leads` : `/campaigns/${c.id}?tab=leads`;
}

/**
 * Puts leads in a campaign (enroll_leads skips blocked, bounced and invalid ones and anyone already
 * in it). A finished campaign that gets new leads restarts (`restart`) or waits paused.
 */
async function enroll(c: CampaignInfo, ids: string[], restart: boolean): Promise<number> {
  const supa = db();
  let enrolled = 0;
  for (const part of chunks(ids, 1000)) {
    enrolled += Number(must(await supa.rpc("enroll_leads", { p_campaign: c.id, p_tag: null, p_lead_ids: part }))) || 0;
  }
  if (enrolled > 0 && c.status === "completed") {
    must(await supa.from("campaigns").update({ status: restart ? "active" : "paused" }).eq("id", c.id).eq("status", "completed"));
    c.status = restart ? "active" : "paused";
  }
  return enrolled;
}

/**
 * Upserts leads by email. Existing leads get their fields refreshed and the lists merged;
 * status (unsubscribed/bounced) is never reset by an import. With `campaignId` the chunk is also
 * put in that campaign. No refresh(): the dialog imports in chunks and refreshes once at the end.
 */
export async function importLeads(
  rows: ImportRow[], tags: string[], customKeys: string[], opts?: { campaignId?: string | null; restart?: boolean },
): Promise<AddSummary | { ok: false; error: string }> {
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
  if (!emails.length) return { ok: true, inserted: 0, updated: 0, invalid, suppressed: 0, enrolled: 0 };

  const existing = new Map<string, { id: string; tags: string[]; custom: Record<string, string> }>();
  const suppressedSet = new Set<string>();
  for (const chunk of chunks(emails, 500)) {
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
    for (const part of chunks(group, 500)) {
      const { error } = await supa.from("leads").upsert(part, { onConflict: "email", defaultToNull: false });
      if (error) return { ok: false, error: error.message };
    }
  }

  let enrolled = 0;
  if (opts?.campaignId) {
    const c = await campaignInfo(opts.campaignId);
    if (!c) return { ok: false, error: "That campaign no longer exists" };
    const ids: string[] = [];
    for (const chunk of chunks(emails, 500)) {
      ids.push(...(must(await supa.from("leads").select("id").in("email", chunk)) as { id: string }[]).map((l) => l.id));
    }
    enrolled = await enroll(c, ids, !!opts.restart);
  }
  return { ok: true, inserted: emails.length - existing.size, updated: existing.size, invalid, suppressed: suppressedSet.size, enrolled };
}

/** Sends leads back to the background checker (the engine checks unchecked emails, newest first). */
export async function requestEmailCheck(sel: LeadSelection): Promise<ActionResult> {
  await requireAuth();
  const ids = await resolveSelection(sel);
  if (!ids.length) return { ok: false, error: "No leads selected" };
  const supa = db();
  for (const part of chunks(ids, 300)) {
    must(await supa.from("leads").update({ verify_status: null }).in("id", part));
    // Marked invalid by an earlier check: give them another chance (bounced/blocked stay as they are).
    must(await supa.from("leads").update({ status: "active" }).in("id", part).eq("status", "invalid"));
  }
  refresh();
  return { ok: true, message: `Checking ${plural(ids.length, "email")} in the background` };
}

export async function deleteLeads(sel: LeadSelection): Promise<ActionResult> {
  await requireAuth();
  const ids = await resolveSelection(sel);
  if (!ids.length) return { ok: false, error: "No leads selected" };
  for (const part of chunks(ids, 300)) must(await db().from("leads").delete().in("id", part));
  refresh();
  return { ok: true, message: `Deleted ${plural(ids.length, "lead")}` };
}

export async function addLeadsToCampaign(campaignId: string, sel: LeadSelection, opts?: { restart?: boolean }): Promise<ActionResult> {
  await requireAuth();
  const c = await campaignInfo(campaignId);
  if (!c) return { ok: false, error: "That campaign no longer exists" };
  const ids = await resolveSelection(sel);
  if (!ids.length) return { ok: false, error: "No leads selected" };
  const enrolled = await enroll(c, ids, !!opts?.restart);
  refresh();
  const skipped = ids.length - enrolled;
  const action = { label: "Open campaign", href: campaignHref(c) };
  if (!enrolled) return { ok: false, error: `None added to ${c.name}: they're already in it, blocked, bounced or invalid`, action };
  return {
    ok: true,
    message: `Added ${fmtNum(enrolled)} to ${c.name}` + (skipped ? ` · ${fmtNum(skipped)} skipped (already in it, blocked or invalid)` : ""),
    action,
  };
}

export async function addLeadsToList(sel: LeadSelection, tag: string): Promise<ActionResult> {
  await requireAuth();
  const t = tag.trim().toLowerCase();
  if (!t) return { ok: false, error: "Enter a list name" };
  const ids = await resolveSelection(sel);
  if (!ids.length) return { ok: false, error: "No leads selected" };
  const supa = db();
  // Leads with the same lists get the same new value, so one update per group (not one per lead).
  const groups = new Map<string, { tags: string[]; ids: string[] }>();
  for (const part of chunks(ids, 300)) {
    const rows = must(await supa.from("leads").select("id, tags").in("id", part)) as { id: string; tags: string[] | null }[];
    for (const r of rows) {
      const cur = r.tags ?? [];
      if (cur.includes(t)) continue;
      const key = JSON.stringify(cur);
      const g = groups.get(key) ?? { tags: [...cur, t], ids: [] };
      g.ids.push(r.id);
      groups.set(key, g);
    }
  }
  let changed = 0;
  for (const g of groups.values()) {
    for (const part of chunks(g.ids, 300)) must(await supa.from("leads").update({ tags: g.tags }).in("id", part));
    changed += g.ids.length;
  }
  refresh();
  if (!changed) return { ok: true, message: `Already in the list “${t}”` };
  return { ok: true, message: `Added ${plural(changed, "lead")} to the list “${t}”`, action: { label: "View list", href: `/leads?tag=${encodeURIComponent(t)}` } };
}

export async function removeLeadFromList(id: string, tag: string): Promise<ActionResult> {
  await requireAuth();
  const supa = db();
  const lead = must(await supa.from("leads").select("tags").eq("id", id).maybeSingle()) as { tags: string[] | null } | null;
  if (!lead) return { ok: false, error: "This lead was deleted" };
  must(await supa.from("leads").update({ tags: (lead.tags ?? []).filter((t) => t !== tag) }).eq("id", id));
  refresh();
  return { ok: true, message: `Removed from the list “${tag}”` };
}

export async function removeLeadFromCampaign(campaignLeadId: string): Promise<ActionResult> {
  await requireAuth();
  must(await db().from("campaign_leads").delete().eq("id", campaignLeadId));
  refresh();
  return { ok: true, message: "Removed from the campaign" };
}

const EDITABLE = ["first_name", "last_name", "company", "title", "website", "linkedin", "phone", "city", "notes"] as const;

export async function updateLead(id: string, patch: Partial<Record<StandardField, string>> & { tags?: string[] }): Promise<ActionResult> {
  await requireAuth();
  const clean: Record<string, unknown> = {};
  for (const k of EDITABLE) if (typeof patch[k] === "string") clean[k] = patch[k]!.trim();
  if (Array.isArray(patch.tags)) clean.tags = [...new Set(patch.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
  if (!Object.keys(clean).length) return { ok: true, message: "Nothing to save" };
  must(await db().from("leads").update(clean).eq("id", id));
  refresh();
  return { ok: true, message: "Lead saved" };
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
export async function addLeadsManually(input: {
  leads: ManualLead[]; tags: string[]; campaignId?: string | null; restart?: boolean;
}): Promise<AddSummary | { ok: false; error: string }> {
  await requireAuth();
  const supa = db();
  const tags = [...new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  const all = input.leads.map((l) => ({ ...l, email: (l.email ?? "").trim().toLowerCase() }));
  const byEmail = new Map(all.filter((l) => isEmailSyntax(l.email)).map((l) => [l.email, l]));
  const rows = [...byEmail.values()];
  const invalid = all.length - all.filter((l) => isEmailSyntax(l.email)).length;
  if (!rows.length) return { ok: false, error: "No valid email addresses" };

  const emails = rows.map((r) => r.email);
  const [existing, suppressed] = await Promise.all([
    supa.from("leads").select("*").in("email", emails).then(must) as Promise<Record<string, unknown>[]>,
    supa.from("suppressions").select("email").in("email", emails).then(must) as Promise<{ email: string }[]>,
  ]);
  const known = new Map(existing.map((l) => [l.email as string, l]));
  const blocked = new Set(suppressed.map((s) => s.email));
  const fields = ["first_name", "last_name", "company", "title", "website", "linkedin", "notes"] as const;

  const fresh = rows.filter((r) => !known.has(r.email)).map((r) => ({
    email: r.email, tags, status: blocked.has(r.email) ? "unsubscribed" : "active",
    ...Object.fromEntries(fields.map((f) => [f, (r[f] ?? "").trim()])),
  }));
  if (fresh.length) must(await supa.from("leads").insert(fresh));
  let updated = 0;
  for (const r of rows.filter((x) => known.has(x.email))) {
    const prev = known.get(r.email)!;
    const patch: Record<string, unknown> = { tags: [...new Set([...((prev.tags as string[]) ?? []), ...tags])] };
    for (const f of fields) if (!String(prev[f] ?? "").trim() && (r[f] ?? "").trim()) patch[f] = (r[f] ?? "").trim();
    must(await supa.from("leads").update(patch).eq("id", prev.id as string));
    updated++;
  }

  let enrolled = 0;
  let campaignName = "";
  if (input.campaignId) {
    const c = await campaignInfo(input.campaignId);
    if (!c) return { ok: false, error: "That campaign no longer exists" };
    campaignName = c.name;
    const ids = (must(await supa.from("leads").select("id").in("email", emails)) as { id: string }[]).map((l) => l.id);
    enrolled = await enroll(c, ids, !!input.restart);
  }
  refresh();
  const parts = [fresh.length && `${fmtNum(fresh.length)} added`, updated && `${fmtNum(updated)} already existed`, input.campaignId && `${fmtNum(enrolled)} put in ${campaignName}`].filter(Boolean);
  return {
    ok: true, inserted: fresh.length, updated, invalid, suppressed: [...blocked].length, enrolled,
    message: parts.join(" · ") || "Nothing to add",
  };
}
