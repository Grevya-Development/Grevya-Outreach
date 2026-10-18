"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionResult } from "@/components/client";
import { composeEmail } from "@/lib/compose";
import { draftStep, generateLine, RateLimitError } from "@/lib/groq";
import { prepareLead } from "@/lib/prepare";
import { getProfile } from "@/lib/profile";
import { leadDomain, profileText, type Research } from "@/lib/research";
import { checkContent, type SpamReport } from "@/lib/spamcheck";
import { db, must } from "@/lib/supabase";
import { missingVariables, usesVariable } from "@/lib/template";
import type { Campaign, CampaignLead, CampaignStep, Lead, Mailbox } from "@/lib/types";
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

export async function createCampaign(form: FormData) {
  await requireAuth();
  const name = String(form.get("name") ?? "").trim() || "Untitled campaign";
  const mode = form.get("mode") === "template" ? "template" : "ai";
  const supa = db();
  const campaign = must(await supa.from("campaigns").insert({ name, mode, min_fit_score: mode === "ai" ? 4 : 0 }).select("id").single()) as { id: string };
  must(await supa.from("campaign_steps").insert((mode === "ai" ? AI_STEPS : TEMPLATE_STEPS).map((s) => ({ ...s, campaign_id: campaign.id }))));
  // Attach every usable mailbox by default.
  const mbs = must(await supa.from("mailboxes").select("id").eq("status", "active")) as { id: string }[];
  if (mbs.length) must(await supa.from("campaign_mailboxes").insert(mbs.map((m) => ({ campaign_id: campaign.id, mailbox_id: m.id }))));
  redirect(`/campaigns/${campaign.id}`);
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

export async function saveCampaignSettings(id: string, s: CampaignSettings): Promise<ActionResult> {
  await requireAuth();
  const supa = db();
  const { mailbox_ids, ...rest } = s;
  const before = must(await supa.from("campaigns").select("mode, require_approval").eq("id", id).single()) as Pick<Campaign, "mode" | "require_approval">;
  must(await supa.from("campaigns").update({
    ...rest,
    daily_limit: Math.max(1, Math.min(10000, Math.round(rest.daily_limit))),
    min_fit_score: Math.max(0, Math.min(10, Math.round(rest.min_fit_score))),
  }).eq("id", id));
  must(await supa.from("campaign_mailboxes").delete().eq("campaign_id", id));
  if (mailbox_ids.length) must(await supa.from("campaign_mailboxes").insert(mailbox_ids.map((m) => ({ campaign_id: id, mailbox_id: m }))));
  // Turning approval off releases anything waiting for review.
  if (before.require_approval && !rest.require_approval) {
    await supa.from("campaign_leads").update({ prep_status: "ready" }).eq("campaign_id", id).eq("prep_status", "review");
  }
  // Switching modes: AI steps hold instructions, template steps hold email text — never let one
  // be sent as the other. Pause, load the new mode's starter sequence, and re-prepare.
  if (before.mode !== rest.mode) {
    await supa.from("campaigns").update({ status: "paused" }).eq("id", id).eq("status", "active");
    must(await supa.rpc("replace_steps", {
      p_campaign: id,
      p_steps: (rest.mode === "ai" ? AI_STEPS : TEMPLATE_STEPS).map(({ step_number, delay_days, subject, body }) => ({ step_number, delay_days, subject, body })),
    }));
    await supa.from("campaign_leads").update({ prep_status: "pending", prep_error: null, prep_attempts: 0, prep_locked_until: null, personalization: null })
      .eq("campaign_id", id).eq("current_step", 0).eq("status", "queued");
    refresh();
    return { ok: true, message: `Switched to ${rest.mode === "ai" ? "AI-researched" : "template"} emails. The campaign is paused and the sequence was reset — review it, then resume.` };
  }
  refresh();
  return { ok: true, message: "Settings saved" };
}

export interface StepInput {
  delay_days: number;
  subject: string;
  body: string;
}

export async function saveSteps(id: string, steps: StepInput[]): Promise<ActionResult> {
  await requireAuth();
  const supa = db();
  const campaign = must(await supa.from("campaigns").select("mode").eq("id", id).single()) as Pick<Campaign, "mode">;
  if (!steps.length) return { ok: false, error: "A campaign needs at least one step" };
  if (campaign.mode === "template" && !steps[0].subject.trim()) return { ok: false, error: "Email 1 needs a subject" };
  if (steps.some((s) => !s.body.trim())) return { ok: false, error: campaign.mode === "ai" ? "Every step needs instructions" : "Every step needs a body" };
  // One transaction: a running engine never sees a campaign with zero steps.
  must(await supa.rpc("replace_steps", {
    p_campaign: id,
    p_steps: steps.map((s, i) => ({ step_number: i + 1, delay_days: i === 0 ? 0 : Math.max(1, Math.round(s.delay_days)), subject: s.subject, body: s.body })),
  }));
  let rewritten = 0;
  if (campaign.mode === "ai") {
    // Emails already written for not-yet-contacted leads were based on the old instructions.
    const { data } = await supa.from("campaign_leads").update({ prep_status: "pending", prep_error: null, prep_attempts: 0 })
      .eq("campaign_id", id).eq("current_step", 0).in("status", ["queued"]).in("prep_status", ["ready", "review", "failed"]).select("id");
    rewritten = data?.length ?? 0;
  }
  refresh();
  return { ok: true, message: rewritten ? `Sequence saved — ${rewritten} lead(s) will be re-written with the new instructions` : "Sequence saved" };
}

export async function setCampaignStatus(id: string, status: "active" | "paused"): Promise<ActionResult> {
  await requireAuth();
  const supa = db();
  if (status === "active") {
    const [steps, mbs, leads, profile, campaign] = await Promise.all([
      supa.from("campaign_steps").select("id", { count: "exact", head: true }).eq("campaign_id", id),
      supa.from("campaign_mailboxes").select("mailbox_id, mailboxes(status)").eq("campaign_id", id),
      supa.from("campaign_leads").select("id", { count: "exact", head: true }).eq("campaign_id", id).in("status", ["queued", "in_progress"]),
      getProfile(),
      supa.from("campaigns").select("mode").eq("id", id).single(),
    ]);
    if (!steps.count) return { ok: false, error: "Add at least one email to the sequence" };
    const attached = (mbs.data ?? []) as unknown as { mailboxes: { status: string } | null }[];
    if (!attached.length) return { ok: false, error: "Pick at least one mailbox in Settings" };
    if (!attached.some((m) => m.mailboxes?.status === "active")) return { ok: false, error: "All selected mailboxes are paused or have errors" };
    if (!leads.count) return { ok: false, error: "Add leads before launching" };
    if (campaign.data?.mode === "ai" && !profile.services.trim()) return { ok: false, error: "Fill in your company profile (Settings → Company profile) so the AI knows what you offer" };
    if (campaign.data?.mode === "template") {
      const all = must(await supa.from("campaign_steps").select("subject, body").eq("campaign_id", id)) as { subject: string; body: string }[];
      const ph = all.map((s) => `${s.subject}\n${s.body}`.match(/<[^<>\n]{3,}>/)?.[0]).find(Boolean);
      if (ph) return { ok: false, error: `Replace the placeholder ${ph} in your sequence before launching` };
    }
  }
  must(await supa.from("campaigns").update({ status }).eq("id", id));
  refresh();
  return { ok: true, message: status === "active" ? "Campaign is live — emails go out inside each mailbox's sending hours" : "Campaign paused" };
}

export async function deleteCampaign(id: string) {
  await requireAuth();
  must(await db().from("campaigns").delete().eq("id", id));
  redirect("/campaigns");
}

export async function enrollLeads(id: string, tag: string | null): Promise<ActionResult> {
  await requireAuth();
  const n = Number(must(await db().rpc("enroll_leads", { p_campaign: id, p_tag: tag || null, p_lead_ids: null })));
  // A finished campaign with new leads becomes resumable (paused, not silently live).
  if (n) await db().from("campaigns").update({ status: "paused" }).eq("id", id).eq("status", "completed");
  refresh();
  return { ok: true, message: n ? `Added ${n} lead${n === 1 ? "" : "s"}` : "No new eligible leads (already added, unsubscribed, bounced or invalid)" };
}

export async function removeCampaignLeads(campaignId: string, ids: string[]): Promise<ActionResult> {
  await requireAuth();
  must(await db().from("campaign_leads").delete().eq("campaign_id", campaignId).in("id", ids));
  refresh();
  return { ok: true, message: `Removed ${ids.length}` };
}

/** Approves AI-written emails waiting for review (all, or the given leads). */
export async function approveLeads(campaignId: string, ids?: string[]): Promise<ActionResult> {
  await requireAuth();
  let q = db().from("campaign_leads").update({ prep_status: "ready" }).eq("campaign_id", campaignId).eq("prep_status", "review");
  if (ids?.length) q = q.in("id", ids);
  const { data, error } = await q.select("id");
  if (error) return { ok: false, error: error.message };
  refresh();
  return { ok: true, message: `Approved ${data?.length ?? 0}` };
}

/** Sends leads back to the AI writer (e.g. after editing the company profile). */
export async function rewriteLeads(campaignId: string, ids?: string[]): Promise<ActionResult> {
  await requireAuth();
  let q = db().from("campaign_leads").update({ prep_status: "pending", prep_error: null, prep_attempts: 0 })
    .eq("campaign_id", campaignId).eq("current_step", 0).in("status", ["queued"]).neq("prep_status", "working");
  if (ids?.length) q = q.in("id", ids);
  const { data, error } = await q.select("id");
  if (error) return { ok: false, error: error.message };
  refresh();
  return { ok: true, message: `${data?.length ?? 0} lead(s) queued for re-writing` };
}

/** Puts low-fit skipped leads back in the queue (e.g. after lowering the fit threshold). */
export async function unskipLeads(campaignId: string): Promise<ActionResult> {
  await requireAuth();
  const { data, error } = await db().from("campaign_leads").update({ status: "queued", prep_status: "pending", skip_reason: null, prep_attempts: 0 })
    .eq("campaign_id", campaignId).eq("status", "skipped").like("skip_reason", "Low fit%").select("id");
  if (error) return { ok: false, error: error.message };
  refresh();
  return { ok: true, message: `${data?.length ?? 0} lead(s) back in the queue` };
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
 * Builds the sequence for one lead exactly as the engine will send it. In AI mode this
 * researches + writes the emails if they aren't written yet (or `regenerate` is set).
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
        if (!claim.length) return { ok: false, error: "This lead is being written by the background worker right now — try again in a minute" };
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
    const msg = err instanceof RateLimitError ? `Groq is rate-limiting — try again in ${err.retryAfterSec}s` : (err as Error).message;
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
  const { id: _id, created_at: _c, status: _s, ...rest } = c;
  const copy = must(await supa.from("campaigns").insert({ ...rest, name: `${c.name} (copy)` }).select("id").single()) as { id: string };
  if (steps.length) must(await supa.from("campaign_steps").insert(steps.map(({ id: _i, campaign_id: _ci, ...s }) => ({ ...s, campaign_id: copy.id }))));
  if (mbs.length) must(await supa.from("campaign_mailboxes").insert(mbs.map((m) => ({ campaign_id: copy.id, mailbox_id: m.mailbox_id }))));
  redirect(`/campaigns/${copy.id}`);
}

/** Puts failed leads back in the queue (e.g. after fixing a mailbox or network problem). */
export async function retryFailed(campaignId: string): Promise<ActionResult> {
  await requireAuth();
  const supa = db();
  const rows = must(await supa.from("campaign_leads").select("id, current_step").eq("campaign_id", campaignId).eq("status", "failed")) as { id: string; current_step: number }[];
  for (const r of rows) {
    must(await supa.from("campaign_leads").update({
      status: r.current_step > 0 ? "in_progress" : "queued", attempts: 0, last_error: null, next_send_at: new Date().toISOString(),
    }).eq("id", r.id));
  }
  if (rows.length) await supa.from("campaigns").update({ status: "paused" }).eq("id", campaignId).eq("status", "completed");
  refresh();
  return { ok: true, message: `${rows.length} lead(s) will be retried` };
}

/**
 * Follow-ups pinned to a mailbox that's paused, broken or no longer in this campaign can't
 * be sent. Move them to the campaign's other mailboxes; they continue as fresh emails.
 */
export async function reassignStuck(campaignId: string): Promise<ActionResult> {
  await requireAuth();
  const supa = db();
  const attached = must(await supa.from("campaign_mailboxes").select("mailbox_id, mailboxes(status)").eq("campaign_id", campaignId)) as unknown as { mailbox_id: string; mailboxes: { status: string } | null }[];
  const healthy = attached.filter((a) => a.mailboxes?.status === "active").map((a) => a.mailbox_id);
  if (!healthy.length) return { ok: false, error: "No active mailbox in this campaign to move them to" };
  const stuck = must(await supa.from("campaign_leads").select("id, mailbox_id").eq("campaign_id", campaignId)
    .in("status", ["queued", "in_progress"]).not("mailbox_id", "is", null)) as { id: string; mailbox_id: string }[];
  const ids = stuck.filter((r) => !healthy.includes(r.mailbox_id)).map((r) => r.id);
  for (let i = 0; i < ids.length; i += 200) {
    must(await supa.from("campaign_leads").update({ mailbox_id: null, last_message_id: null, locked_until: null }).in("id", ids.slice(i, i + 200)));
  }
  refresh();
  return { ok: true, message: ids.length ? `Moved ${ids.length} lead(s) to active mailboxes` : "No stuck leads" };
}

/** Leads waiting on a mailbox that can't send (for the "stuck" warning). */
export async function countStuck(campaignId: string): Promise<number> {
  await requireAuth();
  const supa = db();
  const attached = must(await supa.from("campaign_mailboxes").select("mailbox_id, mailboxes(status)").eq("campaign_id", campaignId)) as unknown as { mailbox_id: string; mailboxes: { status: string } | null }[];
  const healthy = new Set(attached.filter((a) => a.mailboxes?.status === "active").map((a) => a.mailbox_id));
  const rows = must(await supa.from("campaign_leads").select("mailbox_id").eq("campaign_id", campaignId)
    .in("status", ["queued", "in_progress"]).not("mailbox_id", "is", null)) as { mailbox_id: string }[];
  return rows.filter((r) => !healthy.has(r.mailbox_id)).length;
}
