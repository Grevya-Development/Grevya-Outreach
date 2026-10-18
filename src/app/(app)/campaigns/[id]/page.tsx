import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import type { CampaignOption } from "@/components/add-leads";
import { Card, Empty, Skeleton, TableSkeleton } from "@/components/ui";
import { composeEmail } from "@/lib/compose";
import { CAMPAIGN_LEAD_STATUS_LABEL, PREP_LABEL } from "@/lib/labels";
import { getLaunchChecklist } from "@/lib/launch-checklist";
import { getProfile } from "@/lib/profile";
import { describeWindow, effectiveDailyLimit, MAILBOX_HARD_CAP, nextWindowStart, warmupInfo } from "@/lib/schedule";
import { checkContent } from "@/lib/spamcheck";
import { db, must } from "@/lib/supabase";
import type { CampaignLead, Lead } from "@/lib/types";
import { AnalyticsTab } from "./analytics-tab";
import {
  BUILDER_STEPS, first, getAiProgress, getCampaign, getCampaignLeadsPage, getEngine, getLeadTags, getReviewLead, getReviewQueue,
  LEADS_PAGE, parseCampaignLeadFilter, resolveView, senderFor, UUID, viewHref, type CampaignData, type CampaignViewName, type MailboxLite,
} from "./data";
import { CampaignHeader, CampaignNav } from "./header";
import { LaunchStep } from "./launch-step";
import { LeadsTab, type LeadsTabRow } from "./leads-tab";
import { OptionsTab } from "./options-tab";
import { ReviewTab, type ReviewSelected } from "./review-tab";
import { ScheduleTab } from "./schedule-tab";
import { SequenceTab, type SelectedPreview } from "./sequence-tab";

export const metadata = { title: "Campaign" };

type SP = Record<string, string | string[] | undefined>;
type ViewProps = { data: CampaignData; sp: SP; builder: boolean };

export default function CampaignPage({ params, searchParams }: PageProps<"/campaigns/[id]">) {
  return (
    <div className="grid gap-5 min-w-0">
      <Suspense fallback={<HeaderSkeleton />}><CampaignHeader params={params} /></Suspense>
      <Suspense fallback={<Skeleton className="h-9 w-full max-w-xl" />}><CampaignNav params={params} searchParams={searchParams} /></Suspense>
      <Suspense fallback={<TableSkeleton />}><CampaignView params={params} searchParams={searchParams} /></Suspense>
    </div>
  );
}

function HeaderSkeleton() {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="grid gap-2"><Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-72 max-w-full" /></div>
      <div className="flex gap-2"><Skeleton className="h-9 w-36" /><Skeleton className="h-9 w-9" /></div>
    </div>
  );
}

/** Picks the step/tab from the URL and renders it in its own Suspense, so switching shows that tab's skeleton only. */
async function CampaignView({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!UUID.test(id)) notFound();
  const data = await getCampaign(id);
  if (!data) notFound();
  const { view, builder } = resolveView(sp, data.campaign.status === "draft");
  const props: ViewProps = { data, sp, builder };
  return (
    <Suspense key={view} fallback={<TableSkeleton />}>
      {view === "analytics" ? <AnalyticsView {...props} />
        : view === "leads" ? <LeadsView {...props} />
          : view === "review" ? <ReviewView {...props} />
            : view === "sequence" ? <SequenceView {...props} />
              : view === "schedule" ? <ScheduleView {...props} />
                : view === "options" ? <OptionsView {...props} />
                  : <LaunchView {...props} />}
    </Suspense>
  );
}

/** Back / next hrefs in the draft builder. */
function builderNav(id: string, view: CampaignViewName, builder: boolean) {
  if (!builder) return {};
  const i = (BUILDER_STEPS as readonly string[]).indexOf(view);
  return {
    backHref: i > 0 ? viewHref(id, BUILDER_STEPS[i - 1], true) : undefined,
    nextHref: i >= 0 && i < BUILDER_STEPS.length - 1 ? viewHref(id, BUILDER_STEPS[i + 1], true) : undefined,
  };
}

const nameOf = (l: Pick<Lead, "first_name" | "last_name" | "email">) => [l.first_name, l.last_name].filter(Boolean).join(" ") || l.email;
const fromLabel = (m: MailboxLite | null) => (m ? `${m.from_name || m.email} <${m.email}>` : "No email account selected");
const defaultTo = (data: CampaignData) => senderFor(data, null)?.email ?? "";
const headCount = (r: { count: number | null }) => r.count ?? 0;

async function AnalyticsView({ data, sp }: ViewProps) {
  await connection();
  return <AnalyticsTab id={data.campaign.id} range={first(sp.range)} />;
}

/* ───────────── Leads ───────────── */

async function LeadsView({ data, sp, builder }: ViewProps) {
  await connection();
  const { campaign: c, statusCounts: sc } = data;
  const id = c.id;
  const ai = c.mode === "ai";
  const filter = parseCampaignLeadFilter((k) => first(sp[k]));
  const page = Math.max(1, Math.floor(Number(first(sp.page))) || 1);
  const viewParam = builder ? "step=leads" : "tab=leads";
  const [res, tags, engine, progress, campaigns] = await Promise.all([
    getCampaignLeadsPage(id, c.mode, page, filter.q ?? "", filter.status ?? ""),
    getLeadTags(),
    getEngine(),
    ai ? getAiProgress(id) : null,
    db().from("campaigns").select("id, name, status").order("created_at", { ascending: false }).then(must) as Promise<CampaignOption[]>,
  ]);

  // Past the last page (an old link, or the last rows were removed): go to the last page instead of failing.
  if (res.outOfRange) {
    const last = Math.max(1, Math.ceil(res.total / LEADS_PAGE));
    if (last !== page) {
      const next = new URLSearchParams(viewParam);
      if (filter.q) next.set("q", filter.q);
      if (filter.status) next.set("status", filter.status);
      if (last > 1) next.set("page", String(last));
      redirect(`/campaigns/${id}?${next.toString()}`);
    }
  }

  const n = (k: string) => sc[k] ?? 0;
  const L = CAMPAIGN_LEAD_STATUS_LABEL;
  const chips = [
    { key: "all", label: "All", count: Object.values(sc).reduce((a, b) => a + b, 0) },
    ...(progress ? [
      { key: "ai_writing", label: PREP_LABEL.working, count: progress.writing },
      { key: "to_review", label: PREP_LABEL.review, count: progress.review },
      { key: "ai_failed", label: PREP_LABEL.failed, count: progress.failed },
    ] : []),
    { key: "waiting", label: L.queued, count: progress ? progress.ready : n("queued") },
    { key: "in_sequence", label: "In sequence", count: n("in_progress") },
    { key: "replied", label: L.replied, count: n("replied") },
    { key: "finished", label: L.completed, count: n("completed") },
    { key: "bounced", label: L.bounced, count: n("bounced") },
    { key: "unsubscribed", label: L.unsubscribed, count: n("unsubscribed") },
    { key: "skipped", label: L.skipped, count: n("skipped") },
    { key: "failed", label: L.failed, count: n("failed") },
  ];
  const rows: LeadsTabRow[] = res.rows.map((r) => ({
    id: r.id, status: r.status, current_step: r.current_step, next_send_at: r.next_send_at, due: !!r.due,
    last_error: r.last_error, prep_status: r.prep_status, prep_error: r.prep_error, fit_score: r.fit_score, skip_reason: r.skip_reason,
    mailbox_id: r.mailbox_id, lead_id: r.lead_id, edited: r.edited === true, lastSent: r.lastSent ?? null,
    lead: { email: r.leads.email, first_name: r.leads.first_name, last_name: r.leads.last_name, company: r.leads.company, verify_status: r.leads.verify_status },
  }));

  return (
    <LeadsTab key={`${filter.q ?? ""}|${filter.status ?? ""}|${page}`}
      campaign={{ id, name: c.name, status: c.status, mode: c.mode }} builder={builder}
      rows={rows} total={res.total} page={page} pageSize={LEADS_PAGE} filter={filter} chips={chips} tags={tags}
      accounts={Object.fromEntries(data.mailboxes.map((m) => [m.id, m.email]))} totalSteps={data.steps.length}
      checking={!!engine?.alive && !engine.paused} aiNote={ai && builder && data.hasConfirm && !c.sequence_confirmed_at}
      campaigns={campaigns} viewParam={viewParam} nextHref={builderNav(id, "leads", builder).nextHref}
      defaultAdd={first(sp.add) === "list" ? "list" : undefined} />
  );
}

/* ───────────── Sequence ───────────── */

type PreviewRow = { id: string; prep_status: string | null; leads: Pick<Lead, "email" | "first_name" | "last_name" | "company" | "custom"> | null };
type FullRow = Pick<CampaignLead, "id" | "status" | "prep_status" | "skip_reason" | "mailbox_id" | "personalization"> & { leads: Lead | null };
const FULL = "id, status, prep_status, skip_reason, mailbox_id, personalization, leads(*)";

async function SequenceView({ data, sp, builder }: ViewProps) {
  await connection();
  const { campaign: c } = data;
  const id = c.id;
  const ai = c.mode === "ai";
  const supa = db();
  const leadParam = first(sp.lead);
  const light = () => supa.from("campaign_leads").select("id, prep_status, leads(email, first_name, last_name, company, custom)")
    .eq("campaign_id", id).in("status", ["queued", "in_progress"]);
  const written = () => supa.from("campaign_leads").select("id", { count: "exact", head: true })
    .eq("campaign_id", id).eq("status", "queued").eq("current_step", 0).in("prep_status", ["ready", "review"]);
  const [ready, others, wanted, unsentWritten, editedCount, progress, profile] = await Promise.all([
    // AI: leads whose emails are already written come first, so the preview has something to show.
    ai ? light().in("prep_status", ["ready", "review"]).order("created_at").limit(30).then(must) as Promise<PreviewRow[]> : Promise.resolve([] as PreviewRow[]),
    light().order("created_at").limit(30).then(must) as Promise<PreviewRow[]>,
    leadParam && UUID.test(leadParam)
      ? supa.from("campaign_leads").select(FULL).eq("id", leadParam).eq("campaign_id", id).maybeSingle().then((r) => r.data as FullRow | null)
      : Promise.resolve(null),
    ai ? written().then(headCount) : 0,
    ai ? written().eq("personalization->>edited", "true").then(headCount) : 0,
    ai ? getAiProgress(id) : null,
    getProfile(),
  ]);

  const seen = new Set<string>();
  const list = [...ready, ...others].filter((r) => r.leads && !seen.has(r.id) && seen.add(r.id)).slice(0, 30);
  if (wanted?.leads && !seen.has(wanted.id)) list.unshift({ id: wanted.id, prep_status: wanted.prep_status, leads: wanted.leads });
  const row: FullRow | null = wanted ?? (list[0]
    ? ((await supa.from("campaign_leads").select(FULL).eq("id", list[0].id).maybeSingle()).data as FullRow | null)
    : null);

  const sender = senderFor(data, row?.mailbox_id ?? null);
  let selected: SelectedPreview | null = null;
  if (row?.leads) {
    const lead = row.leads;
    let aiEmails: SelectedPreview["aiEmails"] = null;
    if (ai && row.personalization?.emails?.length) {
      aiEmails = [];
      for (let i = 0; i < data.steps.length; i++) {
        try {
          const e = composeEmail({
            campaign: c, steps: data.steps, stepIndex: i, lead, address: profile.address,
            cl: { id: row.id, personalization: row.personalization, last_subject: null, last_message_id: i > 0 ? "<preview>" : null },
            mailbox: sender ?? { from_name: "", signature: "" },
          });
          aiEmails.push({
            label: i === 0 ? "Email 1" : `Email ${i + 1} · after ${data.steps[i].delay_days} days`,
            subject: e.subject, body: e.text, spam: checkContent(e.subject, e.text, { allowLinks: 1, isFollowUp: i > 0 }),
          });
        } catch {
          break; // this step isn't written (the sequence got longer since)
        }
      }
    }
    selected = {
      id: row.id, status: row.status, prepStatus: row.prep_status, skipReason: row.skip_reason,
      lead: {
        id: lead.id, email: lead.email, first_name: lead.first_name, last_name: lead.last_name, company: lead.company, title: lead.title,
        website: lead.website, linkedin: lead.linkedin, phone: lead.phone, city: lead.city, notes: lead.notes, custom: lead.custom ?? {},
      },
      aiLine: row.personalization?.ai_line ?? null,
      aiEmails,
      from: fromLabel(sender),
    };
  }
  const customKeys = [...new Set(list.flatMap((r) => Object.keys(r.leads?.custom ?? {})))].sort().slice(0, 20);
  const nav = builderNav(id, "sequence", builder);

  return (
    <SequenceTab
      campaign={{ id, name: c.name, status: c.status, mode: c.mode, include_unsubscribe: c.include_unsubscribe, ai_enabled: c.ai_enabled }}
      builder={builder} confirmed={data.hasConfirm ? !!c.sequence_confirmed_at : true}
      steps={data.steps.map((s) => ({ delay_days: s.delay_days, subject: s.subject, body: s.body }))}
      previewLeads={list.map((r) => ({ id: r.id, label: `${nameOf(r.leads!)}${r.leads!.company ? ` · ${r.leads!.company}` : ""}` }))}
      selected={selected} sender={sender ? { email: sender.email, from_name: sender.from_name, signature: sender.signature } : null}
      customKeys={customKeys} unsentWritten={unsentWritten} editedCount={editedCount}
      progress={progress ? { done: progress.total - progress.writing, total: progress.total } : null}
      viewParam={builder ? "step=sequence" : "tab=sequence"} backHref={nav.backHref} nextHref={nav.nextHref} />
  );
}

/* ───────────── Schedule ───────────── */

async function ScheduleView({ data, builder }: ViewProps) {
  await connection();
  const { campaign: c, statusCounts: sc } = data;
  const now = new Date();
  const accounts = data.mailboxes.map((m) => ({
    id: m.id, email: m.email, status: m.status,
    perDay: effectiveDailyLimit(m, now), fullPerDay: Math.min(m.daily_limit, MAILBOX_HARD_CAP), warmup: warmupInfo(m, now),
    window: describeWindow(m), nextStart: nextWindowStart(m, now)?.toISOString() ?? null, sendDays: m.send_days,
  }));
  const nav = builderNav(c.id, "schedule", builder);
  return (
    <ScheduleTab campaign={{ id: c.id, status: c.status, daily_limit: c.daily_limit }} builder={builder} accounts={accounts}
      attachedIds={data.attachedIds} leadsRemaining={(sc.queued ?? 0) + (sc.in_progress ?? 0)} stepDelays={data.steps.map((s) => s.delay_days)}
      backHref={nav.backHref} nextHref={nav.nextHref} />
  );
}

/* ───────────── Options ───────────── */

async function OptionsView({ data, builder }: ViewProps) {
  await connection();
  const { campaign: c } = data;
  const q = db().from("campaign_leads").select("id", { count: "exact", head: true }).eq("campaign_id", c.id).eq("status", "queued").eq("current_step", 0);
  const writtenCount = await (c.mode === "ai" ? q.in("prep_status", ["ready", "review"]) : q.not("personalization", "is", null)).then(headCount);
  const nav = builderNav(c.id, "options", builder);
  return <OptionsTab campaign={c} builder={builder} writtenCount={writtenCount} backHref={nav.backHref} nextHref={nav.nextHref} />;
}

/* ───────────── Launch ───────────── */

async function LaunchView({ data, builder }: ViewProps) {
  await connection();
  const { campaign: c } = data;
  const checklist = await getLaunchChecklist(c.id);
  return (
    <LaunchStep campaign={{ id: c.id, name: c.name, status: c.status }} checklist={checklist} builder={builder}
      backHref={builder ? viewHref(c.id, "options", true) : undefined} stepCount={data.steps.length} defaultTo={defaultTo(data)} />
  );
}

/* ───────────── Review ───────────── */

async function ReviewView({ data, sp }: ViewProps) {
  await connection();
  const { campaign: c } = data;
  if (c.mode !== "ai") {
    return <Card><Empty title="Nothing to review">Review is for AI-written campaigns. Template emails are sent as you wrote them.</Empty></Card>;
  }
  const view = first(sp.view) === "failed" ? "failed" : "to_review";
  const [{ rows, counts }, progress] = await Promise.all([getReviewQueue(c.id, view), getAiProgress(c.id)]);
  const leadParam = first(sp.lead);
  const selId = rows.find((r) => r.id === leadParam)?.id ?? rows[0]?.id;
  const sel = selId ? await getReviewLead(selId) : null;

  const now = new Date();
  const nextSend = data.mailboxes.filter((m) => data.attachedIds.includes(m.id) && m.status === "active")
    .map((m) => nextWindowStart(m, now)).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;

  let selected: ReviewSelected | null = null;
  if (sel) {
    const a = sel.research?.analysis;
    selected = {
      id: sel.id,
      prepError: sel.prep_error,
      edited: sel.personalization?.edited === true,
      lead: { name: nameOf(sel.leads), email: sel.leads.email, title: sel.leads.title, company: sel.leads.company || a?.company_name || "", website: sel.leads.website || sel.research?.domain || "" },
      fit: sel.fit_score,
      research: sel.research ? {
        whatTheyDo: a?.what_they_do ?? "", facts: a?.facts ?? [], bestService: a?.best_service ?? "", angle: a?.angle ?? "", fitReason: a?.fit_reason ?? "",
        failed: sel.research.status === "failed" ? `Their website couldn't be read${sel.research.error ? `: ${sel.research.error}` : ""}.` : null,
      } : null,
      emails: (sel.personalization?.emails ?? []).map((e) => ({ subject: e.subject ?? "", body: e.body ?? "" })),
      sends: data.steps.map((s, i) => (i === 0 ? "Day 0" : `after ${s.delay_days} day${s.delay_days === 1 ? "" : "s"}`)),
      from: fromLabel(senderFor(data, sel.mailbox_id)),
    };
  }

  return (
    <ReviewTab campaign={{ id: c.id, name: c.name, require_approval: c.require_approval }} view={view}
      queue={rows.map((r) => ({ id: r.id, name: r.leads ? nameOf(r.leads) : "—", company: r.leads?.company ?? "", fit: r.fit_score }))}
      counts={counts} selected={selected}
      progress={{ done: progress.total - progress.writing, total: progress.total, writing: progress.writing }}
      approved={progress.ready} nextSend={nextSend?.toISOString() ?? null} stepCount={data.steps.length} defaultTo={defaultTo(data)} />
  );
}
