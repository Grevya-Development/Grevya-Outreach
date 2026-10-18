import { connection } from "next/server";
import { ArrowRight, ArrowUpRight, Inbox, MoreHorizontal, Plus, Send, Sparkles, Upload } from "lucide-react";
import Link from "next/link";
import { cache, Suspense } from "react";
import { setSendingPaused } from "@/app/actions/engine";
import { ActionButton, Menu, RelativeTime } from "@/components/client";
import { Badge, buttonClass, ButtonLink, Card, CardHeader, cx, Empty, PageHeader, pct, Progress, Skeleton, Stat, StatusBadge } from "@/components/ui";
import { getEngineState } from "@/lib/app-state";
import { env } from "@/lib/env";
import { fmtDate, fmtDay, fmtNum, fmtTime } from "@/lib/format";
import { replyLabel } from "@/lib/labels";
import { getProfile } from "@/lib/profile";
import { effectiveDailyLimit, inSendingWindow } from "@/lib/schedule";
import { db, isMissingRpc, must } from "@/lib/supabase";
import type { Mailbox, Reply } from "@/lib/types";
import { NeedsYou, type CampaignCount, type LiveCounts } from "./home-client";

export const metadata = { title: "Home" };

export default function HomePage() {
  return (
    <>
      <PageHeader
        title="Home"
        actions={
          <>
            <Menu
              trigger={<button type="button" className={buttonClass("ghost", "md", "w-9 px-0")} aria-label="More actions"><MoreHorizontal size={17} /></button>}
              items={[{ label: "Send one email", icon: <Send />, href: "/inbox?compose=1" }]}
            />
            <ButtonLink href="/leads?add=csv"><Upload size={15} />Import leads</ButtonLink>
            <ButtonLink variant="primary" href="/campaigns?new=1"><Plus size={15} />New campaign</ButtonLink>
          </>
        }
      />
      <div className="grid gap-4">
        {/* No skeleton: once setup is done this card never shows, so a placeholder would only flash. */}
        <Suspense fallback={null}><GetStarted /></Suspense>
        <Suspense fallback={<Skeleton className="h-[76px] rounded-xl" />}><NextBestAction /></Suspense>
        <Suspense fallback={<Skeleton className="h-[104px] rounded-xl" />}><NeedsYouSection /></Suspense>
        <Suspense fallback={<div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[86px] rounded-xl" />)}</div>}>
          <Kpis />
        </Suspense>
        <div className="grid lg:grid-cols-[1.4fr_1fr] gap-4 items-start">
          <Suspense fallback={<Skeleton className="h-[268px] rounded-xl" />}><ActivityChart /></Suspense>
          <Suspense fallback={<Skeleton className="h-[180px] rounded-xl" />}><AccountsToday /></Suspense>
        </div>
        <Suspense fallback={<Skeleton className="h-[240px] rounded-xl" />}><LatestReplies /></Suspense>
      </div>
    </>
  );
}

// ───────────────────────── data (one parallel wave, shared by every section) ─────────────────────────

interface Day { day: string; sent: number; opened: number; replied: number; bounced: number }

interface Summary {
  todo: number;
  reminders_due: number;
  leads: number;
  unchecked: number;
  launched: number;
  campaigns: number;
  active_campaigns: number;
  /** Missing before migration 0004 (then today's bar of the chart is used). */
  sent_today?: number;
  /** AI drafts for leads not yet emailed, by prep_status. */
  prep: Record<string, number>;
  review_by_campaign: CampaignCount[];
  failed_by_campaign: CampaignCount[];
  draft: { id: string; name: string; leads: number } | null;
}

/** Counts for Home in one RPC, or (before migration 0004) the same keys from parallel count queries. */
async function homeSummary(tz: string): Promise<Summary> {
  const supa = db();
  const { data, error } = await supa.rpc("home_summary", { p_tz: tz });
  if (!error) {
    const s = (data ?? {}) as Record<string, unknown>;
    const n = (k: string) => Number(s[k]) || 0;
    const draft = s.draft as { id: string; name: string; leads: number } | null;
    return {
      todo: n("todo"), reminders_due: n("reminders_due"), leads: n("leads"), unchecked: n("unchecked"), launched: n("launched"),
      campaigns: n("campaigns"), active_campaigns: n("active_campaigns"), sent_today: n("sent_today"),
      prep: Object.fromEntries(Object.entries((s.prep ?? {}) as Record<string, unknown>).map(([k, v]) => [k, Number(v) || 0])),
      review_by_campaign: (s.review_by_campaign as CampaignCount[] | undefined) ?? [],
      failed_by_campaign: (s.failed_by_campaign as CampaignCount[] | undefined) ?? [],
      draft: draft ? { ...draft, leads: Number(draft.leads) || 0 } : null,
    };
  }
  if (!isMissingRpc(error)) throw new Error(error.message);

  const nowIso = new Date().toISOString();
  const count = (r: { count: number | null }) => r.count ?? 0;
  const head = { count: "exact", head: true } as const;
  type WithCount = { id: string; name: string; status: string; campaign_leads: { count: number }[] };
  const perCampaign = (prep: string) => supa.from("campaigns").select("id, name, campaign_leads(count)")
    .eq("campaign_leads.prep_status", prep).eq("campaign_leads.status", "queued")
    .then((r) => ((r.data ?? []) as WithCount[]).map((c) => ({ id: c.id, name: c.name, n: Number(c.campaign_leads?.[0]?.count) || 0 }))
      .filter((c) => c.n > 0).sort((a, b) => b.n - a.n));
  const [todo, reminders, leads, unchecked, writing, campaigns, review, failed] = await Promise.all([
    supa.from("replies").select("id", head).eq("handled", false).or(`follow_up_at.lte.${nowIso},and(kind.eq.reply,follow_up_at.is.null)`).then(count),
    supa.from("replies").select("id", head).eq("handled", false).lte("follow_up_at", nowIso).then(count),
    supa.from("leads").select("id", head).then(count),
    supa.from("leads").select("id", head).is("verify_status", null).then(count),
    supa.from("campaign_leads").select("id", head).in("prep_status", ["pending", "working"]).in("status", ["queued", "in_progress"]).eq("current_step", 0).then(count),
    // Every campaign with its lead count (few rows): covers the campaign counts and the newest draft.
    supa.from("campaigns").select("id, name, status, campaign_leads(count)").order("created_at", { ascending: false }).then((r) => must(r) as WithCount[]),
    perCampaign("review"),
    perCampaign("failed"),
  ]);
  const draft = campaigns.find((c) => c.status === "draft");
  return {
    todo, reminders_due: reminders, leads, unchecked,
    launched: campaigns.filter((c) => c.status !== "draft").length,
    campaigns: campaigns.length,
    active_campaigns: campaigns.filter((c) => c.status === "active").length,
    prep: { pending: writing },
    review_by_campaign: review,
    failed_by_campaign: failed,
    draft: draft ? { id: draft.id, name: draft.name, leads: Number(draft.campaign_leads?.[0]?.count) || 0 } : null,
  };
}

/** Everything Home shows, fetched once per request (React cache) however many sections ask. */
const loadHome = cache(async () => {
  const supa = db();
  const tz = env.timezone;
  const [summary, daysRaw, mailboxes, sentRows, replies, engine, profile] = await Promise.all([
    homeSummary(tz),
    supa.rpc("daily_activity", { p_days: 14, p_tz: tz }).then(must),
    supa.from("mailboxes").select("*").order("created_at").then(must),
    supa.rpc("mailbox_sent_today").then(must),
    supa.from("replies").select("*").eq("kind", "reply").order("received_at", { ascending: false }).limit(5).then(must),
    getEngineState(),
    getProfile(),
  ]);
  const days = (daysRaw as Day[]).map((d) => ({ day: String(d.day), sent: Number(d.sent), opened: Number(d.opened), replied: Number(d.replied), bounced: Number(d.bounced) }));
  const mbs = mailboxes as Mailbox[];
  const sentByMailbox = new Map((sentRows as { mailbox_id: string; sent: number }[]).map((c) => [c.mailbox_id, Number(c.sent)]));
  const capacity = mbs.filter((m) => m.status === "active").reduce((s, m) => s + effectiveDailyLimit(m), 0);
  const sentToday = summary.sent_today ?? days.at(-1)?.sent ?? 0;
  return { summary, days, mbs, sentByMailbox, capacity, sentToday, replies: replies as Reply[], engine, profile };
});

// ───────────────────────── sections ─────────────────────────

async function GetStarted() {
  await connection();
  const { summary, mbs, profile } = await loadHome();
  const steps = [
    { done: !!profile.services.trim(), title: "Describe what Grevya sells", body: "The AI writes every email from your company profile. Fill it from your website in one click.", href: "/settings" },
    { done: mbs.length > 0, title: "Connect an email account", body: "Gmail, Outlook and GoDaddy settings are filled in for you.", href: "/mailboxes?connect=1" },
    { done: summary.leads > 0, title: "Add leads", body: "Upload a CSV or paste a list. Emails are checked in the background.", href: "/leads?add=csv" },
    { done: summary.launched > 0, title: "Launch your first campaign", body: "Pick your leads, review the emails, then launch.", href: "/campaigns?new=1" },
  ];
  const left = steps.filter((x) => !x.done).length;
  if (!left) return null;
  const next = steps.findIndex((x) => !x.done);
  return (
    <Card className="p-4 fade-in">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <div className="font-semibold">Get started</div>
          <div className="text-[12.5px] text-muted">About 3 minutes. {steps.length - left} of {steps.length} done.</div>
        </div>
        <div className="h-1.5 w-32 rounded-full bg-panel-2 overflow-hidden"><div className="h-full bg-accent" style={{ width: `${((steps.length - left) / steps.length) * 100}%` }} /></div>
      </div>
      <ol className="grid gap-1.5">
        {steps.map((x, i) => (
          <li key={x.title}>
            <Link href={x.href} className={cx("flex items-start gap-3 rounded-lg px-3 py-2 transition-colors", i === next ? "bg-accent-soft/60 hover:bg-accent-soft" : "hover:bg-panel-2")}>
              <span className={cx("mt-0.5 size-5 shrink-0 rounded-full grid place-items-center text-[11px] font-semibold",
                x.done ? "bg-good text-white" : i === next ? "bg-accent text-accent-ink" : "bg-panel-2 text-muted")}>{x.done ? "✓" : i + 1}</span>
              <span>
                <span className={cx("block text-[13.5px]", x.done ? "text-muted line-through" : "font-medium")}>{x.title}</span>
                {!x.done && <span className="block text-[12.5px] text-muted">{x.body}</span>}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </Card>
  );
}

type NextAction = { text: string; sub?: string; tone?: "warn" | "bad"; link?: { label: string; href: string }; resume?: boolean };

/** Spec §4.1: the first rule that matches wins. */
function pickNextAction(h: Awaited<ReturnType<typeof loadHome>>): NextAction {
  const { summary: s, engine, mbs, profile } = h;
  const writing = (s.prep.pending ?? 0) + (s.prep.working ?? 0);
  const toReview = s.review_by_campaign.reduce((a, c) => a + c.n, 0);
  if (!profile.services.trim()) {
    return { text: "Tell the AI what Grevya sells", sub: "Every email is written from your company profile.", link: { label: "Fill in profile", href: "/settings" } };
  }
  if (!mbs.some((m) => m.status === "active")) {
    return { text: "Connect an email account", sub: "Campaigns send from the accounts you connect.", link: { label: "Connect account", href: "/mailboxes?connect=1" } };
  }
  if (!engine.paused && !engine.alive && (writing > 0 || s.active_campaigns > 0)) {
    return {
      text: "Sending is stopped. Nothing will send or be written", tone: "bad",
      sub: engine.lastTick ? `Last run ${fmtDay(engine.lastTick)}, ${fmtTime(engine.lastTick)}.` : undefined,
      link: { label: "Open Sending settings", href: "/settings/sending" },
    };
  }
  if (engine.paused) {
    return { text: "Sending is paused", tone: "warn", sub: engine.pausedAt ? `Since ${fmtTime(engine.pausedAt)}. Replies are still collected and AI keeps writing.` : undefined, resume: true };
  }
  if (s.leads === 0) return { text: "Import your leads", sub: "Upload a CSV or paste a list.", link: { label: "Import leads", href: "/leads?add=csv" } };
  if (s.campaigns === 0) return { text: "Create your first campaign", link: { label: "New campaign", href: "/campaigns?new=1" } };
  if (s.draft && s.draft.leads > 0) {
    return { text: `Finish and launch “${s.draft.name}”`, sub: `${fmtNum(s.draft.leads)} leads are waiting in this draft.`, link: { label: "Finish and launch", href: `/campaigns/${s.draft.id}?step=launch` } };
  }
  if (toReview > 0) {
    return { text: `Review ${fmtNum(toReview)} AI email${toReview === 1 ? "" : "s"}`, link: { label: "Review emails", href: `/campaigns/${s.review_by_campaign[0].id}?tab=review` } };
  }
  if (s.todo > 0) return { text: `Reply to ${fmtNum(s.todo)} lead${s.todo === 1 ? "" : "s"}`, link: { label: "Open inbox", href: "/inbox" } };
  return { text: `All caught up. ${fmtNum(h.sentToday)} of ${fmtNum(h.capacity)} sent today` };
}

async function NextBestAction() {
  await connection();
  const a = pickNextAction(await loadHome());
  return (
    <Card className={cx("flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5 fade-in",
      a.tone === "bad" ? "border-bad/30 bg-bad-soft" : a.tone === "warn" ? "border-warn/30 bg-warn-soft" : "border-accent/25 bg-accent-soft/40")}>
      <Sparkles size={18} className={cx("shrink-0", a.tone === "bad" ? "text-bad" : a.tone === "warn" ? "text-warn" : "text-accent")} />
      <div className="flex-1 min-w-[200px]">
        <div className="text-[11.5px] font-medium uppercase tracking-[0.08em] text-muted">Next best action</div>
        <div className="text-[15px] font-semibold">{a.text}</div>
        {a.sub && <div className="text-[12.5px] text-muted mt-0.5">{a.sub}</div>}
      </div>
      {a.resume && <ActionButton action={setSendingPaused.bind(null, false)}>Resume sending</ActionButton>}
      {a.link && <ButtonLink href={a.link.href}>{a.link.label}<ArrowRight size={15} /></ButtonLink>}
    </Card>
  );
}

async function NeedsYouSection() {
  await connection();
  const { summary: s, mbs, engine } = await loadHome();
  const initial: LiveCounts = {
    todo: s.todo,
    reminders_due: s.reminders_due,
    review_by_campaign: s.review_by_campaign,
    failed_by_campaign: s.failed_by_campaign,
    error_accounts: mbs.filter((m) => m.status === "error").length,
    unchecked: s.unchecked,
    engine: { alive: engine.alive, paused: engine.paused },
  };
  return <NeedsYou initial={initial} />;
}

async function Kpis() {
  await connection();
  const { days, summary, sentToday, capacity } = await loadHome();
  // Nothing to measure until the first email goes out.
  if (!days.some((d) => d.sent > 0) && summary.launched === 0) return null;
  const week = days.slice(-7).reduce((a, d) => ({ sent: a.sent + d.sent, replied: a.replied + d.replied, bounced: a.bounced + d.bounced }), { sent: 0, replied: 0, bounced: 0 });
  const bounceRate = week.sent ? week.bounced / week.sent : 0;
  const today = days.at(-1);
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 fade-in">
      <Stat label="Sent today" value={fmtNum(sentToday)} sub={`of ${fmtNum(capacity)} today`} />
      <Stat label="Replies · 7d" value={fmtNum(week.replied)} sub={`${fmtNum(today?.replied ?? 0)} today`} tone={week.replied ? "good" : undefined} />
      <Stat label="Reply rate · 7d" value={pct(week.replied, week.sent)} sub={`${fmtNum(week.sent)} sent in 7 days`} />
      <Stat label="Bounce rate · 7d" value={pct(week.bounced, week.sent)} sub="Keep under 2–3%" tone={bounceRate > 0.03 ? "bad" : undefined} />
    </div>
  );
}

async function ActivityChart() {
  await connection();
  const { days } = await loadHome();
  const max = Math.max(1, ...days.map((d) => d.sent));
  const empty = days.every((d) => d.sent === 0 && d.replied === 0);
  return (
    <Card className="fade-in">
      <CardHeader title="Last 14 days" description={empty ? undefined : <span className="flex gap-3"><Legend className="bg-accent" label="Sent" /><Legend className="bg-good" label="Replies" /></span>} />
      {empty ? (
        <p className="px-4 pb-4 text-[13px] text-muted">Nothing sent yet. Launch a campaign to see activity here.</p>
      ) : (
        <div className="px-4 pb-4">
          <div className="flex items-end gap-1.5 h-44">
            {days.map((d) => (
              <div key={d.day} className="group relative flex-1 h-full flex flex-col justify-end">
                <div className="w-full rounded-t-[4px] bg-accent/80 group-hover:bg-accent transition-[height,background] duration-500" style={{ height: `${(d.sent / max) * 100}%`, minHeight: d.sent ? 2 : 0 }} />
                {d.replied > 0 && <div className="absolute left-1/2 -translate-x-1/2 size-1.5 rounded-full bg-good" style={{ bottom: `calc(${(d.sent / max) * 100}% + 4px)` }} />}
                <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block z-10 whitespace-nowrap rounded-lg border border-line bg-panel px-2.5 py-1.5 text-[12px] shadow-lg">
                  <div className="font-medium">{fmtDay(d.day)}</div>
                  <div className="tabular-nums text-muted">{fmtNum(d.sent)} sent · {fmtNum(d.replied)} replies · {fmtNum(d.bounced)} bounces</div>
                </div>
              </div>
            ))}
          </div>
          <div className="flex justify-between text-[11px] text-faint mt-1.5 tabular-nums">
            <span>{days[0] ? fmtDate(days[0].day) : ""}</span>
            <span>Today</span>
          </div>
        </div>
      )}
    </Card>
  );
}

async function AccountsToday() {
  await connection();
  const { mbs, sentByMailbox } = await loadHome();
  return (
    <Card className="fade-in">
      <CardHeader title="Email accounts today" actions={<Link href="/mailboxes" className="text-[12.5px] text-muted hover:text-ink inline-flex items-center gap-0.5">Manage<ArrowUpRight size={13} /></Link>} />
      <div className="grid gap-3 px-4 pb-4">
        {mbs.length === 0 && (
          <p className="text-[13px] text-muted">No email accounts yet. <Link href="/mailboxes?connect=1" className="text-accent underline">Connect the inbox you&apos;ll send from</Link>.</p>
        )}
        {mbs.map((m) => {
          const limit = effectiveDailyLimit(m);
          const sent = sentByMailbox.get(m.id) ?? 0;
          return (
            <div key={m.id} className="grid gap-1.5">
              <div className="flex items-center justify-between gap-2 text-[13px]">
                <span className="truncate">{m.email}</span>
                <span className="flex items-center gap-2 shrink-0">
                  {m.status !== "active"
                    ? <StatusBadge status={m.status} kind="mailbox" />
                    : !inSendingWindow(m) && <span className="text-[11.5px] text-faint">outside sending hours</span>}
                  <span className="tabular-nums text-muted"><b className="text-ink font-medium">{fmtNum(sent)}</b>/{fmtNum(limit)}</span>
                </span>
              </div>
              <Progress value={sent} max={limit} />
            </div>
          );
        })}
      </div>
    </Card>
  );
}

async function LatestReplies() {
  await connection();
  const { replies } = await loadHome();
  return (
    <Card className="fade-in">
      <CardHeader title="Latest replies" actions={<Link href="/inbox" className="text-[12.5px] text-muted hover:text-ink inline-flex items-center gap-0.5">Inbox<ArrowUpRight size={13} /></Link>} />
      {replies.length === 0 ? (
        <Empty icon={<Inbox size={24} />} title="No replies yet">Replies show up here a few minutes after they arrive.</Empty>
      ) : (
        <div className="divide-y divide-line border-t border-line">
          {replies.map((r) => {
            const label = replyLabel(r.sentiment);
            return (
              <Link key={r.id} href={`/inbox?id=${r.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-panel-2/60 transition-colors">
                <span className={cx("size-1.5 rounded-full shrink-0", r.is_read ? "bg-transparent" : "bg-accent")} />
                <span className="font-medium w-32 sm:w-48 shrink-0 truncate">{r.from_name || r.from_email}</span>
                <span className="text-muted truncate flex-1 min-w-0">{r.snippet}</span>
                {label && <Badge tone={label.tone} dot className="hidden sm:inline-flex">{label.label}</Badge>}
                <RelativeTime iso={r.received_at} className="text-[12px] text-faint shrink-0 tabular-nums" />
              </Link>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return <span className="inline-flex items-center gap-1"><span className={cx("size-2 rounded-sm", className)} />{label}</span>;
}
