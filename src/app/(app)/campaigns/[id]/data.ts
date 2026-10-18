// Server-only data loaders for the campaign page. Each is wrapped in React cache(), so the header,
// the tab bar and the active tab share one query per request. Tabs load only their own data.
import { cache } from "react";
import { getEngineState } from "@/lib/app-state";
import { APP_TZ } from "@/lib/format";
import { leadDomain, type Research } from "@/lib/research";
import { db, isMissingRpc, must } from "@/lib/supabase";
import type { Campaign, CampaignLead, CampaignStats, CampaignStep, Lead, PublicMailbox } from "@/lib/types";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ───────────── Leads tab filter (shared with the bulk actions) ───────────── */

/** `?status=` values of the campaign Leads tab. AI-only ones are only offered for AI campaigns. */
export const LEAD_STATUS_FILTERS = [
  "ai_writing", "to_review", "ai_failed", "waiting", "in_sequence", "replied", "finished", "bounced", "unsubscribed", "skipped", "failed",
] as const;
export type LeadStatusFilter = (typeof LEAD_STATUS_FILTERS)[number];
export type CampaignLeadFilter = { q?: string; status?: string };

/** Reads `q` and `status` from the URL (unknown values are dropped; 'not_started' is an old name for 'waiting'). */
export function parseCampaignLeadFilter(get: (k: string) => unknown): CampaignLeadFilter {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const q = str(get("q")).slice(0, 100);
  let status = str(get("status"));
  if (status === "not_started") status = "waiting";
  return { q: q || undefined, status: (LEAD_STATUS_FILTERS as readonly string[]).includes(status) ? status : undefined };
}

type Filterable = {
  eq(column: string, value: unknown): Filterable;
  in(column: string, values: unknown[]): Filterable;
  or(filters: string, opts?: { referencedTable?: string }): Filterable;
};

/** Applies the Leads tab filter to a campaign_leads query that embeds `leads!inner(…)`. */
export function applyCampaignLeadFilter<Q>(query: Q, f: CampaignLeadFilter, mode: Campaign["mode"]): Q {
  let q = query as unknown as Filterable;
  if (f.q) {
    const safe = f.q.replace(/[,()%*\\]/g, " ");
    q = q.or(`email.ilike.%${safe}%,first_name.ilike.%${safe}%,last_name.ilike.%${safe}%,company.ilike.%${safe}%`, { referencedTable: "leads" });
  }
  switch (f.status) {
    case "ai_writing": q = q.eq("status", "queued").eq("current_step", 0).in("prep_status", ["pending", "working"]); break;
    case "to_review": q = q.eq("status", "queued").eq("prep_status", "review"); break;
    case "ai_failed": q = q.eq("status", "queued").eq("prep_status", "failed"); break;
    case "waiting": q = q.eq("status", "queued").eq("current_step", 0); if (mode === "ai") q = q.eq("prep_status", "ready"); break;
    case "in_sequence": q = q.eq("status", "in_progress"); break;
    case "finished": q = q.eq("status", "completed"); break;
    case "replied": case "bounced": case "unsubscribed": case "skipped": case "failed": q = q.eq("status", f.status); break;
  }
  return q as unknown as Q;
}

/* ───────────── Which view the URL asks for ───────────── */

export const BUILDER_STEPS = ["leads", "sequence", "schedule", "options", "launch"] as const;
export const STEP_LABELS: Record<(typeof BUILDER_STEPS)[number], string> = { leads: "Leads", sequence: "Sequence", schedule: "Schedule", options: "Options", launch: "Launch" };
export const LIVE_TABS = ["analytics", "leads", "review", "sequence", "schedule", "options"] as const;
export type CampaignViewName = (typeof BUILDER_STEPS)[number] | (typeof LIVE_TABS)[number];

export const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * Drafts are built step by step (`?step=`), live campaigns have tabs (`?tab=`). `?tab=review` and
 * `?step=launch` work in any status; a tab name on a draft (or a step on a live campaign) maps over.
 */
export function resolveView(sp: Record<string, string | string[] | undefined>, draft: boolean): { view: CampaignViewName; builder: boolean } {
  const step = first(sp.step);
  const tab = first(sp.tab);
  const isStep = (v?: string): v is (typeof BUILDER_STEPS)[number] => !!v && (BUILDER_STEPS as readonly string[]).includes(v);
  const isTab = (v?: string): v is (typeof LIVE_TABS)[number] => !!v && (LIVE_TABS as readonly string[]).includes(v);
  if (draft) {
    if (isStep(step)) return { view: step, builder: true };
    if (tab === "review" || tab === "analytics") return { view: tab, builder: false };
    if (isStep(tab)) return { view: tab, builder: true };
    return { view: "leads", builder: true };
  }
  if (isTab(tab)) return { view: tab, builder: false };
  if (isStep(step)) return { view: step, builder: false };
  return { view: "analytics", builder: false };
}

/** The URL of a view: a builder step for drafts, a tab otherwise. */
export function viewHref(id: string, view: CampaignViewName, builder: boolean, extra?: Record<string, string>): string {
  const p = new URLSearchParams({ [builder && view !== "review" && view !== "analytics" ? "step" : "tab"]: view, ...extra });
  if (view === "launch") { p.delete("tab"); p.set("step", "launch"); }
  return `/campaigns/${id}?${p.toString()}`;
}

/* ───────────── The campaign ───────────── */

export type CampaignData = {
  campaign: Campaign;
  steps: CampaignStep[];
  /** Every account (for the Schedule checklist), without passwords. */
  mailboxes: MailboxLite[];
  attachedIds: string[];
  stats: CampaignStats | null;
  statusCounts: Record<string, number>;
  /** Migration 0004 is in (campaigns.sequence_confirmed_at exists). */
  hasConfirm: boolean;
};

const MB_COLUMNS = "id, email, from_name, daily_limit, warmup_enabled, warmup_start, warmup_increment, warmup_started_at, min_delay_sec, max_delay_sec, timezone, window_start, window_end, send_days, signature, status, last_error, created_at";
export type MailboxLite = Pick<PublicMailbox, "id" | "email" | "from_name" | "daily_limit" | "warmup_enabled" | "warmup_start" | "warmup_increment" | "warmup_started_at" | "min_delay_sec" | "max_delay_sec" | "timezone" | "window_start" | "window_end" | "send_days" | "signature" | "status" | "last_error" | "created_at">;

/** The campaign, its steps and accounts, and its counts. Null when it doesn't exist. */
export const getCampaign = cache(async (id: string): Promise<CampaignData | null> => {
  if (!UUID.test(id)) return null;
  const supa = db();
  const [campaignRes, steps, mailboxes, attached, stats, counts] = await Promise.all([
    supa.from("campaigns").select("*").eq("id", id).maybeSingle(),
    supa.from("campaign_steps").select("*").eq("campaign_id", id).order("step_number").then(must),
    supa.from("mailboxes").select(MB_COLUMNS).order("created_at").then(must),
    supa.from("campaign_mailboxes").select("mailbox_id").eq("campaign_id", id).then(must),
    supa.rpc("campaign_stats").then(must),
    supa.rpc("campaign_status_counts", { p_campaign: id }).then(must),
  ]);
  if (campaignRes.error) throw new Error(campaignRes.error.message);
  const campaign = campaignRes.data as Campaign | null;
  if (!campaign) return null;
  const statusCounts: Record<string, number> = {};
  for (const r of counts as { status: string; n: number }[]) statusCounts[r.status] = Number(r.n) || 0;
  const s = (stats as CampaignStats[]).find((x) => x.campaign_id === id) ?? null;
  return {
    campaign,
    steps: steps as CampaignStep[],
    mailboxes: mailboxes as MailboxLite[],
    attachedIds: (attached as { mailbox_id: string }[]).map((a) => a.mailbox_id),
    stats: s && {
      ...s, leads: Number(s.leads) || 0, sent: Number(s.sent) || 0, opened: Number(s.opened) || 0, clicked: Number(s.clicked) || 0,
      replied: Number(s.replied) || 0, bounced: Number(s.bounced) || 0, unsubscribed: Number(s.unsubscribed) || 0, remaining: Number(s.remaining) || 0,
    },
    statusCounts,
    hasConfirm: "sequence_confirmed_at" in campaign,
  };
});

export const getEngine = cache(() => getEngineState().catch(() => null));

/** AI drafts for leads waiting for Email 1: total, being written, waiting for review, failed, ready. */
export const getAiProgress = cache(async (id: string) => {
  const supa = db();
  const head = () => supa.from("campaign_leads").select("id", { count: "exact", head: true }).eq("campaign_id", id).eq("status", "queued");
  const [total, writing, review, failed] = await Promise.all([
    head().then((r) => r.count ?? 0),
    head().in("prep_status", ["pending", "working"]).then((r) => r.count ?? 0),
    head().eq("prep_status", "review").then((r) => r.count ?? 0),
    head().eq("prep_status", "failed").then((r) => r.count ?? 0),
  ]);
  return { total, writing, review, failed, ready: Math.max(0, total - writing - review - failed) };
});

/** Leads pinned to an account that can't send (paused, broken or no longer in this campaign). */
export const getStuckCount = cache(async (id: string, healthyKey: string): Promise<number> => {
  const base = db().from("campaign_leads").select("id", { count: "exact", head: true })
    .eq("campaign_id", id).in("status", ["queued", "in_progress"]).not("mailbox_id", "is", null);
  const { count, error } = await (healthyKey ? base.not("mailbox_id", "in", `(${healthyKey})`) : base);
  if (error) throw new Error(error.message);
  return count ?? 0;
});

export const getLeadTags = cache(async () => {
  const rows = must(await db().rpc("lead_tags")) as { tag: string; n: number }[];
  return rows.map((t) => ({ tag: t.tag, n: Number(t.n) || 0 }));
});

/** The From account a lead's emails come from: its assigned account, else the first active attached one. */
export function senderFor(data: { mailboxes: MailboxLite[]; attachedIds: string[] }, mailboxId: string | null): MailboxLite | null {
  const attached = data.mailboxes.filter((m) => data.attachedIds.includes(m.id));
  return (mailboxId && data.mailboxes.find((m) => m.id === mailboxId))
    || attached.find((m) => m.status === "active") || attached[0] || null;
}

/* ───────────── Leads tab ───────────── */

export const LEADS_PAGE = 50;

const LEAD_COLUMNS = "id, status, current_step, next_send_at, last_error, prep_status, prep_error, fit_score, skip_reason, mailbox_id, lead_id, "
  + "edited:personalization->edited, leads!inner(id, email, first_name, last_name, company, title, website, verify_status)";

export type CampaignLeadRow = Pick<CampaignLead, "id" | "status" | "current_step" | "next_send_at" | "last_error" | "prep_status" | "prep_error" | "fit_score" | "skip_reason" | "mailbox_id" | "lead_id"> & {
  edited: boolean | null;
  leads: Pick<Lead, "id" | "email" | "first_name" | "last_name" | "company" | "title" | "website" | "verify_status">;
  lastSent?: string | null;
  /** next_send_at has passed. */
  due?: boolean;
};

/** One page of the Leads tab. `outOfRange` (with the real total) means the page is past the end. */
export const getCampaignLeadsPage = cache(async (id: string, mode: Campaign["mode"], page: number, q: string, status: string) => {
  const supa = db();
  const filter = { q: q || undefined, status: status || undefined };
  const res = await applyCampaignLeadFilter(
    supa.from("campaign_leads").select(LEAD_COLUMNS, { count: "exact" }).eq("campaign_id", id), filter, mode,
  ).order("created_at").order("id").range((page - 1) * LEADS_PAGE, page * LEADS_PAGE - 1);
  const outOfRange = !!res.error && (res.error.code === "PGRST103" || res.status === 416);
  if (res.error && !outOfRange) throw new Error(res.error.message);
  let total = res.count;
  if (outOfRange || total == null) {
    const { count } = await applyCampaignLeadFilter(
      supa.from("campaign_leads").select("id, leads!inner(id)", { count: "exact", head: true }).eq("campaign_id", id), filter, mode,
    );
    total = count ?? 0;
  }
  const rows = (res.data ?? []) as unknown as CampaignLeadRow[];
  // Last sent: at most 50 leads × 6 emails, so one small query.
  if (rows.length) {
    const sent = (await supa.from("messages").select("campaign_lead_id, sent_at").in("campaign_lead_id", rows.map((r) => r.id))
      .neq("status", "failed").order("sent_at", { ascending: false }).limit(400)).data as { campaign_lead_id: string; sent_at: string }[] | null;
    const last = new Map<string, string>();
    for (const m of sent ?? []) if (!last.has(m.campaign_lead_id)) last.set(m.campaign_lead_id, m.sent_at);
    const now = Date.now();
    for (const r of rows) {
      r.lastSent = last.get(r.id) ?? null;
      r.due = !!r.next_send_at && new Date(r.next_send_at).getTime() <= now;
    }
  }
  return { rows, total: total ?? 0, outOfRange: outOfRange || (page > 1 && (page - 1) * LEADS_PAGE >= (total ?? 0)) };
});

/* ───────────── Review tab ───────────── */

export type ReviewView = "to_review" | "failed";
export type ReviewQueueRow = {
  id: string; fit_score: number | null; prep_error: string | null;
  leads: Pick<Lead, "email" | "first_name" | "last_name" | "company"> | null;
};

/** Drafts waiting for review (or the AI's failures), oldest first. */
export const getReviewQueue = cache(async (id: string, view: ReviewView) => {
  const supa = db();
  const head = (prep: string) => supa.from("campaign_leads").select("id", { count: "exact", head: true })
    .eq("campaign_id", id).eq("status", "queued").eq("prep_status", prep).then((r) => r.count ?? 0);
  const [rows, toReview, failed] = await Promise.all([
    supa.from("campaign_leads").select("id, fit_score, prep_error, leads(email, first_name, last_name, company)")
      .eq("campaign_id", id).eq("status", "queued").eq("prep_status", view === "failed" ? "failed" : "review")
      .order("created_at").order("id").limit(200).then(must),
    head("review"),
    head("failed"),
  ]);
  return { rows: rows as unknown as ReviewQueueRow[], counts: { to_review: toReview, failed } };
});

export type ReviewResearch = Pick<Research, "domain" | "status" | "title" | "analysis" | "error">;
export type ReviewLead = Pick<CampaignLead, "id" | "campaign_id" | "status" | "prep_status" | "prep_error" | "personalization" | "mailbox_id" | "fit_score" | "current_step"> & {
  leads: Lead;
  research: ReviewResearch | null;
};

/** One campaign lead with its draft and the research the AI used. */
export const getReviewLead = cache(async (campaignLeadId: string): Promise<ReviewLead | null> => {
  if (!UUID.test(campaignLeadId)) return null;
  const supa = db();
  const row = (await supa.from("campaign_leads")
    .select("id, campaign_id, status, prep_status, prep_error, personalization, mailbox_id, fit_score, current_step, leads(*)")
    .eq("id", campaignLeadId).maybeSingle()).data as (Omit<ReviewLead, "research">) | null;
  if (!row?.leads) return null;
  const domain = row.personalization?.research_domain ?? leadDomain(row.leads);
  const research = domain
    ? ((await supa.from("company_research").select("domain, status, title, analysis, error").eq("domain", domain).maybeSingle()).data as ReviewResearch | null)
    : null;
  return { ...row, research };
});

/* ───────────── Analytics tab ───────────── */

export type StepStat = { step_number: number; sent: number; bounced: number; opened: number; replied: number };
export type DayStat = { day: string; sent: number; opened: number; replied: number; bounced: number };

/** Per-email results (migration 0004). Null when the RPC isn't there. */
export const getStepStats = cache(async (id: string, since: string | null): Promise<StepStat[] | null> => {
  const { data, error } = await db().rpc("campaign_step_stats", { p_campaign: id, p_since: since });
  if (error) {
    if (isMissingRpc(error)) return null;
    throw new Error(error.message);
  }
  return ((data ?? []) as StepStat[]).map((r) => ({
    step_number: Number(r.step_number), sent: Number(r.sent) || 0, bounced: Number(r.bounced) || 0, opened: Number(r.opened) || 0, replied: Number(r.replied) || 0,
  }));
});

/** Sends and replies per day in the app timezone (migration 0004). Null when the RPC isn't there. */
export const getDailyActivity = cache(async (id: string, days: number): Promise<DayStat[] | null> => {
  const { data, error } = await db().rpc("campaign_daily_activity", { p_campaign: id, p_days: days, p_tz: APP_TZ });
  if (error) {
    if (isMissingRpc(error)) return null;
    throw new Error(error.message);
  }
  return ((data ?? []) as DayStat[]).map((r) => ({
    day: String(r.day), sent: Number(r.sent) || 0, opened: Number(r.opened) || 0, replied: Number(r.replied) || 0, bounced: Number(r.bounced) || 0,
  }));
});

/** Emails this campaign sent today (app timezone). */
export const getSentToday = cache(async (id: string): Promise<number> => {
  const { data, error } = await db().rpc("campaign_sent_today", { p_campaign: id, p_tz: APP_TZ });
  if (error) throw new Error(error.message);
  return Number(data) || 0;
});
