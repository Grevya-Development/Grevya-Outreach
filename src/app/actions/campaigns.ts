"use server";

import { randomUUID } from "node:crypto";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { applyCampaignLeadFilter, parseCampaignLeadFilter, type CampaignLeadFilter } from "@/app/(app)/campaigns/[id]/data";
import type { ActionResult } from "@/components/client";
import { composeEmail } from "@/lib/compose";
import { fmtNum } from "@/lib/format";
import { draftStep, generateLine, RateLimitError } from "@/lib/groq";
import { getLaunchChecklist } from "@/lib/launch-checklist";
import { sendEmail } from "@/lib/mailer";
import { prepareLead } from "@/lib/prepare";
import { getProfile } from "@/lib/profile";
import { leadDomain, profileText, type Research } from "@/lib/research";
import { checkContent, type SpamReport } from "@/lib/spamcheck";
import { db, must } from "@/lib/supabase";
import { missingVariables, usesVariable } from "@/lib/template";
import type { Campaign, CampaignLead, CampaignStep, Lead, Mailbox } from "@/lib/types";
import { isEmailSyntax } from "@/lib/verify";
import { requireAuth } from "./auth";

/** AI mode: each step's body is the instruction for what that email should do. */
const AI_STEPS = [
  { step_number: 1, delay_days: 0, subject: "", body: "Open with one specific, true detail about their company. Connect one likely need to the service that fits them best, with one proof point. End with a soft yes/no question." },
  { step_number: 2, delay_days: 3, subject: "", body: "A different, concrete use case for their industry — what we'd build for them and the outcome. One-line question." },
  { step_number: 3, delay_days: 4, subject: "", body: "Offer something low-effort for them: a short written idea of what an AI pilot could look like for their team. Ask if they'd like it." },
  { step_number: 4, delay_days: 6, subject: "", body: "Polite close-out. Say you won't follow up again and leave the door open." },
];

const TEMPLATE_STEPS = [
  {
    step_number: 1, delay_days: 0, subject: "question about {{company|your team}}",
    body: "{Hi|Hey|Hello} {{first_name|there}},\n\n{{ai_line}}\n\n<one or two lines on what you do and the result you get for companies like {{company}}>\n\nWorth a quick chat?",
  },
  { step_number: 2, delay_days: 3, subject: "", body: "{Hi|Hey} {{first_name|there}}, just bumping this up in case it got buried. Would it make sense to talk?" },
  { step_number: 3, delay_days: 5, subject: "", body: "{{first_name|Hi}}, I'll stop here. If {{company|your team}} ever wants help with <problem>, just reply to this email." },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const plural = (n: number, one: string, many = `${one}s`) => `${fmtNum(n)} ${n === 1 ? one : many}`;

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export async function createCampaign(form: FormData) {
  await requireAuth();
  const name = String(form.get("name") ?? "").trim() || "Untitled campaign";
  const mode = form.get("mode") === "template" ? "template" : "ai";
  const list = String(form.get("list") ?? "").trim();
  const supa = db();
  // A user's first campaign reviews AI emails before they send (until they trust the output).
  const launched = mode === "ai" ? ((await supa.from("campaigns").select("id", { count: "exact", head: true }).neq("status", "draft")).count ?? 0) : 1;
  const campaign = must(await supa.from("campaigns").insert({
    name, mode, min_fit_score: mode === "ai" ? 4 : 0, ...(mode === "ai" && launched === 0 ? { require_approval: true } : {}),
  }).select("id").single()) as { id: string };
  must(await supa.from("campaign_steps").insert((mode === "ai" ? AI_STEPS : TEMPLATE_STEPS).map((s) => ({ ...s, campaign_id: campaign.id }))));
  // Attach every usable account by default.
  const mbs = must(await supa.from("mailboxes").select("id").eq("status", "active")) as { id: string }[];
  if (mbs.length) must(await supa.from("campaign_mailboxes").insert(mbs.map((m) => ({ campaign_id: campaign.id, mailbox_id: m.id }))));
  if (list) await supa.rpc("enroll_leads", { p_campaign: campaign.id, p_tag: list, p_lead_ids: null });
  redirect(`/campaigns/${campaign.id}?step=leads`);
}

export async function renameCampaign(id: string, name: string): Promise<ActionResult> {
  await requireAuth();
  const clean = name.trim().slice(0, 120);
  if (!clean) return { ok: false, error: "A campaign needs a name" };
  must(await db().from("campaigns").update({ name: clean }).eq("id", id));
  refresh();
  return { ok: true, message: "Renamed" };
}

export interface CampaignSettings {
  name: string;
  daily_limit: number;
  track_opens: boolean;
  track_clicks: boolean;
  stop_on_reply: boolean;
  include_unsubscribe: boolean;
  ai_enabled: boolean;
  ai_prompt: string;
  sender_context: string;
  mode: "template" | "ai";
  min_fit_score: number;
  require_approval: boolean;
  mailbox_ids: string[];
}

const SETTING_KEYS = ["name", "daily_limit", "track_opens", "track_clicks", "stop_on_reply", "include_unsubscribe", "ai_enabled", "ai_prompt", "sender_context", "min_fit_score", "require_approval"] as const;

/** Saves only the settings that are passed. The writing mode is changed with changeWritingMode. */
export async function saveCampaignSettings(id: string, patch: Partial<Omit<CampaignSettings, "mode">>): Promise<ActionResult> {
  await requireAuth();
  const supa = db();
  const before = must(await supa.from("campaigns").select("require_approval").eq("id", id).single()) as Pick<Campaign, "require_approval">;
  const update: Record<string, unknown> = {};
  for (const k of SETTING_KEYS) if (patch[k] !== undefined) update[k] = patch[k];
  if (typeof update.name === "string") update.name = update.name.trim() || "Untitled campaign";
  // 10000 means "no extra limit" (the accounts' own limits apply).
  if (patch.daily_limit !== undefined) update.daily_limit = Math.max(1, Math.min(10000, Math.round(Number(patch.daily_limit) || 1)));
  if (patch.min_fit_score !== undefined) update.min_fit_score = Math.max(0, Math.min(10, Math.round(Number(patch.min_fit_score) || 0)));
  if (Object.keys(update).length) must(await supa.from("campaigns").update(update).eq("id", id));
  if (patch.mailbox_ids) {
    const ids = [...new Set(patch.mailbox_ids.filter((m) => UUID.test(m)))];
    must(await supa.from("campaign_mailboxes").delete().eq("campaign_id", id));
    if (ids.length) must(await supa.from("campaign_mailboxes").insert(ids.map((m) => ({ campaign_id: id, mailbox_id: m }))));
  }
  // Turning approval off releases anything waiting for review.
  if (before.require_approval && patch.require_approval === false) {
    await supa.from("campaign_leads").update({ prep_status: "ready" }).eq("campaign_id", id).eq("prep_status", "review");
  }
  refresh();
  return { ok: true, message: "Saved" };
}

/**
 * Switching modes: AI steps hold instructions, template steps hold email text, so one must never
 * be sent as the other. Pauses the campaign, loads the new mode's starter sequence and deletes the
 * emails written for leads who haven't been contacted yet.
 */
export async function changeWritingMode(id: string, mode: "ai" | "template"): Promise<ActionResult> {
  await requireAuth();
  const supa = db();
  const before = must(await supa.from("campaigns").select("mode").eq("id", id).single()) as Pick<Campaign, "mode">;
  if (before.mode === mode) return { ok: true, message: "Nothing to change" };
  must(await supa.from("campaigns").update({ mode, ...(mode === "ai" ? { min_fit_score: 4 } : {}) }).eq("id", id));
  await supa.from("campaigns").update({ status: "paused" }).eq("id", id).eq("status", "active");
  must(await supa.rpc("replace_steps", {
    p_campaign: id,
    p_steps: (mode === "ai" ? AI_STEPS : TEMPLATE_STEPS).map(({ step_number, delay_days, subject, body }) => ({ step_number, delay_days, subject, body })),
  }));
  await supa.from("campaign_leads").update({ prep_status: "pending", prep_error: null, prep_attempts: 0, prep_locked_until: null, personalization: null })
    .eq("campaign_id", id).eq("current_step", 0).eq("status", "queued");
  // The new starter sequence must be looked at and saved before the AI writes from it (no-op before 0004).
  await supa.from("campaigns").update({ sequence_confirmed_at: null }).eq("id", id);
  refresh();
  return { ok: true, message: `Switched to ${mode === "ai" ? "AI-written" : "Template"} emails. Check the new sequence, then resume.` };
}

export interface StepInput {
  delay_days: number;
  subject: string;
  body: string;
}

/**
 * Saves the sequence and marks it confirmed (AI writing waits for that). In AI mode, emails already
 * written for leads not yet contacted are only rewritten when `rewrite` is set (the user chose to).
 */
export async function saveSteps(id: string, steps: StepInput[], opts?: { rewrite?: boolean }): Promise<ActionResult> {
  await requireAuth();
  const supa = db();
  const campaign = must(await supa.from("campaigns").select("mode").eq("id", id).single()) as Pick<Campaign, "mode">;
  if (!steps.length) return { ok: false, error: "A campaign needs at least one email" };
  if (steps.length > 6) return { ok: false, error: "A sequence can have up to 6 emails" };
  if (campaign.mode === "template" && !steps[0].subject.trim()) return { ok: false, error: "Email 1 needs a subject" };
  const empty = steps.findIndex((s) => !s.body.trim());
  if (empty >= 0) return { ok: false, error: campaign.mode === "ai" ? `Email ${empty + 1} needs instructions` : `Email ${empty + 1} needs a body` };
  // One transaction: a running engine never sees a campaign with zero steps.
  must(await supa.rpc("replace_steps", {
    p_campaign: id,
    p_steps: steps.map((s, i) => ({ step_number: i + 1, delay_days: i === 0 ? 0 : Math.max(1, Math.round(s.delay_days) || 1), subject: s.subject, body: s.body })),
  }));
  let rewritten = 0;
  if (campaign.mode === "ai" && opts?.rewrite === true) {
    const { data } = await supa.from("campaign_leads").update({ prep_status: "pending", prep_error: null, prep_attempts: 0 })
      .eq("campaign_id", id).eq("current_step", 0).eq("status", "queued").in("prep_status", ["ready", "review", "failed"]).select("id");
    rewritten = data?.length ?? 0;
  }
  // Before migration 0004 the column doesn't exist; that's fine (AI writing then never waits).
  await supa.from("campaigns").update({ sequence_confirmed_at: new Date().toISOString() }).eq("id", id);
  refresh();
  return { ok: true, message: rewritten ? `Sequence saved, ${plural(rewritten, "email")} will be rewritten` : "Sequence saved" };
}

export async function setCampaignStatus(id: string, status: "active" | "paused"): Promise<ActionResult> {
  await requireAuth();
  if (status === "active") {
    const { items } = await getLaunchChecklist(id);
    const failures = items.filter((i) => i.blocking && !i.ok);
    if (failures.length) {
      return {
        ok: false,
        error: "Can't launch yet: " + failures.map((f) => f.label).join(" · "),
        action: { label: "Open checklist", href: `/campaigns/${id}?step=launch` },
      };
    }
  }
  must(await db().from("campaigns").update({ status }).eq("id", id));
  refresh();
  return { ok: true, message: status === "active" ? "Campaign is live. Emails go out inside each account's sending hours" : "Campaign paused" };
}

export async function deleteCampaign(id: string) {
  await requireAuth();
  must(await db().from("campaigns").delete().eq("id", id));
  redirect("/campaigns");
}

/** Puts leads in the campaign (by list, all leads, or ids). Blocked, bounced, invalid and already-added leads are skipped. */
export async function enrollLeads(id: string, src: { tag?: string | null; all?: boolean; leadIds?: string[] }, opts?: { restart?: boolean }): Promise<ActionResult> {
  await requireAuth();
  const supa = db();
  const c = must(await supa.from("campaigns").select("status").eq("id", id).single()) as Pick<Campaign, "status">;
  let n = 0;
  if (src.leadIds?.length) {
    for (const part of chunks(src.leadIds.filter((x) => UUID.test(x)), 1000)) {
      n += Number(must(await supa.rpc("enroll_leads", { p_campaign: id, p_tag: null, p_lead_ids: part }))) || 0;
    }
  } else if (src.tag || src.all) {
    n = Number(must(await supa.rpc("enroll_leads", { p_campaign: id, p_tag: src.all ? null : src.tag, p_lead_ids: null }))) || 0;
  } else {
    return { ok: false, error: "Pick a list" };
  }
  // A finished campaign with new leads restarts (when asked) or waits, paused.
  if (n && c.status === "completed") {
    await supa.from("campaigns").update({ status: opts?.restart ? "active" : "paused" }).eq("id", id).eq("status", "completed");
  }
  refresh();
  return n
    ? { ok: true, message: `Added ${plural(n, "lead")}${n && c.status === "completed" ? (opts?.restart ? ". The campaign is running again" : ". The campaign is paused until you resume it") : ""}` }
    : { ok: false, error: "No new leads to add: they're already in this campaign, blocked, bounced or invalid" };
}

/* ───────────── campaign lead selections (bulk actions) ───────────── */

export type CampaignLeadSelection = { ids: string[] } | { filter: CampaignLeadFilter };

/** A selection can cover a whole filter; past this many rows we stop (the user narrows it). */
const MAX_SELECTION = 50_000;

/** The campaign_leads ids a selection stands for: the picked ids, or every row matching the filter (same query as the Leads tab). */
async function resolveCampaignSelection(campaignId: string, sel: string[] | CampaignLeadSelection): Promise<string[]> {
  if (Array.isArray(sel) || "ids" in sel) {
    const ids = Array.isArray(sel) ? sel : Array.isArray(sel.ids) ? sel.ids : [];
    return [...new Set(ids.filter((id) => typeof id === "string" && UUID.test(id)))];
  }
  const filter = parseCampaignLeadFilter((k) => (sel.filter as Record<string, unknown> | undefined)?.[k]);
  const supa = db();
  const c = must(await supa.from("campaigns").select("mode").eq("id", campaignId).single()) as Pick<Campaign, "mode">;
  const out: string[] = [];
  const PAGE = 1000;
  for (let from = 0; from < MAX_SELECTION; from += PAGE) {
    const rows = must(await applyCampaignLeadFilter(
      supa.from("campaign_leads").select("id, leads!inner(id)").eq("campaign_id", campaignId), filter, c.mode,
    ).order("created_at").order("id").range(from, from + PAGE - 1)) as { id: string }[];
    out.push(...rows.map((r) => r.id));
    if (rows.length < PAGE) break;
  }
  return out;
}

export async function removeCampaignLeads(campaignId: string, sel: string[] | CampaignLeadSelection): Promise<ActionResult> {
  await requireAuth();
  const ids = await resolveCampaignSelection(campaignId, sel);
  if (!ids.length) return { ok: false, error: "No leads selected" };
  for (const part of chunks(ids, 300)) must(await db().from("campaign_leads").delete().eq("campaign_id", campaignId).in("id", part));
  refresh();
  return { ok: true, message: `Removed ${plural(ids.length, "lead")} from this campaign` };
}

/** Approves AI-written emails waiting for review (all of them, or a selection). */
export async function approveLeads(campaignId: string, sel?: string[] | CampaignLeadSelection): Promise<ActionResult> {
  await requireAuth();
  const supa = db();
  let n = 0;
  if (!sel) {
    const { data, error } = await supa.from("campaign_leads").update({ prep_status: "ready" }).eq("campaign_id", campaignId).eq("prep_status", "review").select("id");
    if (error) return { ok: false, error: error.message };
    n = data?.length ?? 0;
  } else {
    const ids = await resolveCampaignSelection(campaignId, sel);
    for (const part of chunks(ids, 300)) {
      const { data, error } = await supa.from("campaign_leads").update({ prep_status: "ready" }).eq("campaign_id", campaignId).eq("prep_status", "review").in("id", part).select("id");
      if (error) return { ok: false, error: error.message };
      n += data?.length ?? 0;
    }
  }
  refresh();
  return n ? { ok: true, message: `Approved ${plural(n, "lead")}` } : { ok: false, error: "Nothing to approve: none of these are waiting for review" };
}

/**
 * Sends leads not yet contacted back to the AI writer. Emails the user edited by hand are kept
 * unless `includeEdited` is set. Without `sel`, covers the whole campaign.
 */
export async function rewriteLeads(campaignId: string, sel?: string[] | CampaignLeadSelection, opts?: { includeEdited?: boolean }): Promise<ActionResult> {
  await requireAuth();
  const supa = db();
  const picked = sel ? new Set(await resolveCampaignSelection(campaignId, sel)) : null;
  if (picked && !picked.size) return { ok: false, error: "No leads selected" };
  const rows: { id: string; personalization: CampaignLead["personalization"] }[] = [];
  const base = () => supa.from("campaign_leads").select("id, personalization")
    .eq("campaign_id", campaignId).eq("current_step", 0).eq("status", "queued").neq("prep_status", "working");
  if (picked) {
    for (const part of chunks([...picked], 300)) rows.push(...(must(await base().in("id", part)) as typeof rows));
  } else {
    const PAGE = 1000;
    for (let from = 0; from < MAX_SELECTION; from += PAGE) {
      const page = must(await base().order("id").range(from, from + PAGE - 1)) as typeof rows;
      rows.push(...page);
      if (page.length < PAGE) break;
    }
  }
  const edited = rows.filter((r) => r.personalization?.edited === true);
  const ids = (opts?.includeEdited ? rows : rows.filter((r) => r.personalization?.edited !== true)).map((r) => r.id);
  for (const part of chunks(ids, 300)) {
    must(await supa.from("campaign_leads").update({ prep_status: "pending", prep_error: null, prep_attempts: 0 }).in("id", part));
  }
  refresh();
  const kept = opts?.includeEdited ? 0 : edited.length;
  return {
    ok: true,
    message: `${plural(ids.length, "lead")} will be rewritten` + (kept ? ` · ${plural(kept, "email")} you edited by hand kept` : ""),
  };
}

/** Puts low-fit skipped leads back in the queue (e.g. after lowering the fit threshold). */
export async function unskipLeads(campaignId: string): Promise<ActionResult> {
  await requireAuth();
  const { data, error } = await db().from("campaign_leads").update({ status: "queued", prep_status: "pending", skip_reason: null, prep_attempts: 0 })
    .eq("campaign_id", campaignId).eq("status", "skipped").like("skip_reason", "Low fit%").select("id");
  if (error) return { ok: false, error: error.message };
  refresh();
  return { ok: true, message: `${plural(data?.length ?? 0, "lead")} back in the queue` };
}

/** Skips leads in the Review queue (or a Leads tab selection): they get no emails from this campaign. */
export async function skipCampaignLeads(campaignId: string, sel: string[] | CampaignLeadSelection): Promise<ActionResult> {
  await requireAuth();
  const ids = await resolveCampaignSelection(campaignId, sel);
  if (!ids.length) return { ok: false, error: "No leads selected" };
  for (const part of chunks(ids, 300)) {
    must(await db().from("campaign_leads").update({ status: "skipped", prep_status: "skipped", skip_reason: "Skipped by you", locked_until: null })
      .eq("campaign_id", campaignId).in("id", part).in("status", ["queued", "in_progress"]));
  }
  refresh();
  return { ok: true, message: `Skipped ${plural(ids.length, "lead")}` };
}

/** Gives every "AI couldn't write" lead another try. */
export async function retryAiFailed(campaignId: string): Promise<ActionResult> {
  await requireAuth();
  const { data, error } = await db().from("campaign_leads").update({ prep_status: "pending", prep_attempts: 0, prep_error: null })
    .eq("campaign_id", campaignId).eq("prep_status", "failed").select("id");
  if (error) return { ok: false, error: error.message };
  refresh();
  return { ok: true, message: `The AI will try ${plural(data?.length ?? 0, "lead")} again` };
}

/** Retry for a selection: leads that couldn't be sent go back in the queue, and AI failures are written again. */
export async function retryLeads(campaignId: string, sel: string[] | CampaignLeadSelection): Promise<ActionResult> {
  await requireAuth();
  const supa = db();
  const ids = await resolveCampaignSelection(campaignId, sel);
  if (!ids.length) return { ok: false, error: "No leads selected" };
  let n = 0;
  for (const part of chunks(ids, 300)) {
    const failed = must(await supa.from("campaign_leads").select("id, current_step").in("id", part).eq("campaign_id", campaignId).eq("status", "failed")) as { id: string; current_step: number }[];
    for (const step of [0, 1]) {
      const group = failed.filter((r) => (r.current_step > 0 ? 1 : 0) === step).map((r) => r.id);
      if (!group.length) continue;
      must(await supa.from("campaign_leads").update({
        status: step ? "in_progress" : "queued", attempts: 0, last_error: null, next_send_at: new Date().toISOString(),
      }).in("id", group));
      n += group.length;
    }
    const { data } = await supa.from("campaign_leads").update({ prep_status: "pending", prep_attempts: 0, prep_error: null })
      .in("id", part).eq("campaign_id", campaignId).eq("prep_status", "failed").select("id");
    n += data?.length ?? 0;
  }
  if (n) await supa.from("campaigns").update({ status: "paused" }).eq("id", campaignId).eq("status", "completed");
  refresh();
  return n ? { ok: true, message: `${plural(n, "lead")} will be retried` } : { ok: false, error: "Nothing to retry: none of these failed" };
}

/** Saves a hand edit to one AI-written email (Review queue autosave). Marks the draft as edited so rewrites keep it. */
export async function updateLeadDraft(campaignLeadId: string, stepIndex: number, subject: string, body: string): Promise<ActionResult> {
  await requireAuth();
  const supa = db();
  const row = must(await supa.from("campaign_leads").select("personalization, current_step").eq("id", campaignLeadId).single()) as Pick<CampaignLead, "personalization" | "current_step">;
  const emails = [...(row.personalization?.emails ?? [])];
  if (stepIndex < 0 || stepIndex >= emails.length) return { ok: false, error: "This email doesn't exist any more" };
  if (stepIndex < row.current_step) return { ok: false, error: "This email was already sent" };
  emails[stepIndex] = { subject: subject.slice(0, 300), body: body.slice(0, 10_000) };
  must(await supa.from("campaign_leads").update({ personalization: { ...(row.personalization ?? {}), emails, edited: true } }).eq("id", campaignLeadId));
  return { ok: true };
}

/**
 * Sends one step of the sequence to `to`, exactly as a lead would get it, from the lead's (or the
 * first active) account. Nothing is recorded: it doesn't count towards limits or stats.
 */
export async function sendTestStep(campaignId: string, stepIndex: number, campaignLeadId: string | null, to: string): Promise<ActionResult> {
  await requireAuth();
  const address = to.trim().toLowerCase();
  if (!isEmailSyntax(address)) return { ok: false, error: "Enter a valid email address" };
  const supa = db();
  const [campaign, steps, attached, profile] = await Promise.all([
    supa.from("campaigns").select("*").eq("id", campaignId).single().then(must) as Promise<Campaign>,
    supa.from("campaign_steps").select("*").eq("campaign_id", campaignId).order("step_number").then(must) as Promise<CampaignStep[]>,
    supa.from("campaign_mailboxes").select("mailbox_id").eq("campaign_id", campaignId).then(must) as Promise<{ mailbox_id: string }[]>,
    getProfile(),
  ]);
  if (!steps[stepIndex]) return { ok: false, error: "That email isn't in the sequence any more" };

  let q = supa.from("campaign_leads").select("*, leads(*)").eq("campaign_id", campaignId);
  // Without a lead: the first one still in the sequence (in AI mode, the first whose emails are written).
  q = campaignLeadId ? q.eq("id", campaignLeadId) : q.in("status", ["queued", "in_progress"]).order("created_at");
  if (!campaignLeadId && campaign.mode === "ai") q = q.in("prep_status", ["ready", "review"]);
  const rows = must(await q.limit(1)) as unknown as (CampaignLead & { leads: Lead })[];
  const cl = rows[0] ?? null;
  const lead: Lead = cl?.leads ?? {
    id: "00000000-0000-0000-0000-000000000000", email: address, first_name: "Priya", last_name: "", company: "Acme", title: "", website: "",
    linkedin: "", phone: "", city: "", notes: "", custom: {}, tags: [], status: "active", verify_status: null, created_at: new Date().toISOString(),
  };
  if (campaign.mode === "ai" && !cl?.personalization?.emails?.[stepIndex]) {
    return { ok: false, error: cl || campaignLeadId ? "This lead's emails aren't written yet" : "No lead's emails are written yet. AI-written emails are written for each real lead" };
  }

  const mbId = cl?.mailbox_id ?? null;
  const attachedIds = attached.map((a) => a.mailbox_id);
  let mb: Mailbox | null = null;
  if (mbId) mb = (await supa.from("mailboxes").select("*").eq("id", mbId).maybeSingle()).data as Mailbox | null;
  if (!mb && attachedIds.length) {
    mb = ((await supa.from("mailboxes").select("*").in("id", attachedIds).eq("status", "active").order("created_at").limit(1)).data?.[0] as Mailbox | undefined) ?? null;
  }
  if (!mb) return { ok: false, error: "Choose an active email account for this campaign first (Schedule)" };

  try {
    const c = composeEmail({
      campaign, steps, stepIndex, lead, mailbox: mb, address: profile.address,
      cl: { id: cl?.id ?? "test", personalization: cl?.personalization ?? null, last_subject: null, last_message_id: stepIndex > 0 ? "<test>" : null },
    });
    await sendEmail({
      mailbox: mb, to: address, subject: `[Test] ${c.subject}`, text: c.text, messageId: randomUUID(),
      trackOpens: false, trackClicks: false,
    });
  } catch (err) {
    return { ok: false, error: `Couldn't send the test: ${(err as Error).message}` };
  }
  return { ok: true, message: `Test sent to ${address}` };
}

export interface PreviewResult {
  ok: true;
  lead: Pick<Lead, "id" | "email" | "first_name" | "last_name" | "company" | "title">;
  mode: "template" | "ai";
  prepStatus: CampaignLead["prep_status"];
  aiLine: string | null;
  research: Pick<Research, "domain" | "status" | "source" | "title" | "tech" | "analysis" | "error"> | null;
  emails: { step: number; delay_days: number; subject: string; body: string; missing: string[]; spam: SpamReport }[];
}

/**
 * Builds the sequence for one lead exactly as the engine will send it. In AI mode this researches
 * and writes the emails if they aren't written yet (or `regenerate` is set). Only called from an
 * explicit button ("Write this one now", "Generate opening line"), never on page load.
 */
export async function previewForLead(campaignId: string, campaignLeadId: string | null, draftSteps: StepInput[] | null, regenerate = false): Promise<PreviewResult | { ok: false; error: string }> {
  await requireAuth();
  const supa = db();
  const campaign = must(await supa.from("campaigns").select("*").eq("id", campaignId).single()) as Campaign;
  const savedSteps = must(await supa.from("campaign_steps").select("*").eq("campaign_id", campaignId).order("step_number")) as CampaignStep[];
  const steps: Pick<CampaignStep, "subject" | "body" | "step_number" | "delay_days">[] = campaign.mode === "template" && draftSteps
    ? draftSteps.map((s, i) => ({ ...s, step_number: i + 1 }))
    : savedSteps;

  let q = supa.from("campaign_leads").select("*, leads(*)").eq("campaign_id", campaignId);
  q = campaignLeadId ? q.eq("id", campaignLeadId) : q.in("status", ["queued", "in_progress"]).order("created_at");
  const rows = must(await q.limit(1)) as unknown as (CampaignLead & { leads: Lead })[];
  let cl = rows[0];
  if (!cl) return { ok: false, error: "Add leads to this campaign to preview" };
  const lead = cl.leads;

  const mbId = cl.mailbox_id ?? (must(await supa.from("campaign_mailboxes").select("mailbox_id").eq("campaign_id", campaignId).limit(1)) as { mailbox_id: string }[])[0]?.mailbox_id;
  const mb: Pick<Mailbox, "from_name" | "signature"> = mbId
    ? (must(await supa.from("mailboxes").select("from_name, signature").eq("id", mbId).single()) as Pick<Mailbox, "from_name" | "signature">)
    : { from_name: "", signature: "" };
  const profile = await getProfile();

  try {
    if (campaign.mode === "ai") {
      if (regenerate || !cl.personalization?.emails?.length) {
        if (!profile.services.trim()) return { ok: false, error: "Fill in your company profile first (Settings → Company profile)" };
        const claim = must(await supa.from("campaign_leads").update({ prep_status: "working", prep_locked_until: new Date(Date.now() + 10 * 60_000).toISOString() })
          .eq("id", cl.id).neq("prep_status", "working").select("prep_locked_until")) as { prep_locked_until: string }[];
        if (!claim.length) return { ok: false, error: "The AI is writing this lead's emails right now. Try again in a minute" };
        try {
          await prepareLead({ ...cl, prep_status: "working", prep_locked_until: claim[0].prep_locked_until }, { force: regenerate });
        } catch (err) {
          await supa.from("campaign_leads").update({ prep_status: "pending", prep_locked_until: null, prep_error: (err as Error).message.slice(0, 300) }).eq("id", cl.id);
          throw err;
        }
        cl = { ...(must(await supa.from("campaign_leads").select("*").eq("id", cl.id).single()) as CampaignLead), leads: lead };
      }
    } else if (campaign.ai_enabled && (!cl.personalization?.ai_line || regenerate) && steps.some((s) => usesVariable(s.body, "ai_line") || usesVariable(s.subject, "ai_line"))) {
      const ai_line = await generateLine({ lead, instructions: campaign.ai_prompt, senderContext: campaign.sender_context || profileText(profile) });
      cl.personalization = { ...(cl.personalization ?? {}), ai_line, generated_at: new Date().toISOString() };
      await supa.from("campaign_leads").update({ personalization: cl.personalization }).eq("id", cl.id);
    }
  } catch (err) {
    const msg = err instanceof RateLimitError ? `The AI is busy. Try again in ${err.retryAfterSec}s` : (err as Error).message;
    return { ok: false, error: msg };
  }

  if (cl.status === "skipped") {
    return { ok: false, error: cl.skip_reason ?? "This lead was skipped" };
  }

  const domain = leadDomain(lead);
  const research = domain
    ? ((await supa.from("company_research").select("domain, status, source, title, tech, analysis, error").eq("domain", domain).maybeSingle()).data as PreviewResult["research"])
    : null;

  const fullSteps = steps.map((s) => ({ ...s, id: "", campaign_id: campaignId })) as CampaignStep[];
  const emails = steps.map((s, i) => {
    const c = composeEmail({ campaign, steps: fullSteps, stepIndex: i, cl: { ...cl, last_subject: null, last_message_id: cl.last_message_id ?? "<preview>" }, lead, mailbox: mb, address: profile.address });
    const ctx = { lead, aiLine: cl.personalization?.ai_line, senderName: mb.from_name, signature: mb.signature, seed: "" };
    return {
      step: i + 1,
      delay_days: s.delay_days,
      subject: c.subject,
      body: c.text,
      missing: campaign.mode === "template" ? [...missingVariables(s.subject, ctx), ...missingVariables(s.body, ctx)] : [],
      spam: checkContent(c.subject, c.text, { allowLinks: 1, isFollowUp: i > 0 }),
    };
  });

  return {
    ok: true,
    lead: { id: lead.id, email: lead.email, first_name: lead.first_name, last_name: lead.last_name, company: lead.company, title: lead.title },
    mode: campaign.mode,
    prepStatus: cl.prep_status,
    aiLine: cl.personalization?.ai_line ?? null,
    research,
    emails,
  };
}

export async function aiDraftStep(campaignId: string, stepIndex: number, brief: string): Promise<{ ok: true; subject: string; body: string } | { ok: false; error: string }> {
  await requireAuth();
  const campaign = must(await db().from("campaigns").select("sender_context").eq("id", campaignId).single()) as Pick<Campaign, "sender_context">;
  try {
    const d = await draftStep({ brief, senderContext: campaign.sender_context || profileText(await getProfile()), stepNumber: stepIndex + 1, isFollowUp: stepIndex > 0 });
    return { ok: true, ...d };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function duplicateCampaign(id: string) {
  await requireAuth();
  const supa = db();
  const c = must(await supa.from("campaigns").select("*").eq("id", id).single()) as Campaign;
  const steps = must(await supa.from("campaign_steps").select("*").eq("campaign_id", id)) as CampaignStep[];
  const mbs = must(await supa.from("campaign_mailboxes").select("mailbox_id").eq("campaign_id", id)) as { mailbox_id: string }[];
  // The copy is a new draft: its sequence gets confirmed again when it's saved.
  const { id: _id, created_at: _c, status: _s, sequence_confirmed_at: _sc, ...rest } = c;
  const copy = must(await supa.from("campaigns").insert({ ...rest, name: `${c.name} (copy)` }).select("id, status").single()) as { id: string; status: string };
  if (steps.length) must(await supa.from("campaign_steps").insert(steps.map(({ id: _i, campaign_id: _ci, ...s }) => ({ ...s, campaign_id: copy.id }))));
  if (mbs.length) must(await supa.from("campaign_mailboxes").insert(mbs.map((m) => ({ campaign_id: copy.id, mailbox_id: m.mailbox_id }))));
  redirect(copy.status === "draft" ? `/campaigns/${copy.id}?step=leads` : `/campaigns/${copy.id}`);
}

/** Puts leads that couldn't be sent back in the queue (e.g. after fixing an account or network problem). */
export async function retryFailed(campaignId: string): Promise<ActionResult> {
  await requireAuth();
  const supa = db();
  const rows = must(await supa.from("campaign_leads").select("id, current_step").eq("campaign_id", campaignId).eq("status", "failed")) as { id: string; current_step: number }[];
  for (const step of [0, 1]) {
    const group = rows.filter((r) => (r.current_step > 0 ? 1 : 0) === step).map((r) => r.id);
    for (const part of chunks(group, 300)) {
      must(await supa.from("campaign_leads").update({
        status: step ? "in_progress" : "queued", attempts: 0, last_error: null, next_send_at: new Date().toISOString(),
      }).in("id", part));
    }
  }
  if (rows.length) await supa.from("campaigns").update({ status: "paused" }).eq("id", campaignId).eq("status", "completed");
  refresh();
  return { ok: true, message: `${plural(rows.length, "lead")} will be retried` };
}

/**
 * Follow-ups pinned to an account that's paused, broken or no longer in this campaign can't be
 * sent. Move them to the campaign's other accounts; they continue as fresh emails.
 */
export async function reassignStuck(campaignId: string): Promise<ActionResult> {
  await requireAuth();
  const supa = db();
  const attached = must(await supa.from("campaign_mailboxes").select("mailbox_id, mailboxes(status)").eq("campaign_id", campaignId)) as unknown as { mailbox_id: string; mailboxes: { status: string } | null }[];
  const healthy = attached.filter((a) => a.mailboxes?.status === "active").map((a) => a.mailbox_id);
  if (!healthy.length) return { ok: false, error: "No active email account in this campaign to move them to" };
  const stuck = must(await supa.from("campaign_leads").select("id, mailbox_id").eq("campaign_id", campaignId)
    .in("status", ["queued", "in_progress"]).not("mailbox_id", "is", null)) as { id: string; mailbox_id: string }[];
  const ids = stuck.filter((r) => !healthy.includes(r.mailbox_id)).map((r) => r.id);
  for (const part of chunks(ids, 200)) {
    must(await supa.from("campaign_leads").update({ mailbox_id: null, last_message_id: null, locked_until: null }).in("id", part));
  }
  refresh();
  return { ok: true, message: ids.length ? `Moved ${plural(ids.length, "lead")} to active accounts` : "No leads were waiting" };
}
