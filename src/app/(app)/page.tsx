import { connection } from "next/server";
import { ArrowUpRight, Inbox } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/client";
import { Card, CardHeader, Empty, PageHeader, Progress, Skeleton, Stat, StatusBadge, pct, timeAgo } from "@/components/ui";
import { env } from "@/lib/env";
import { getProfile } from "@/lib/profile";
import { effectiveDailyLimit, inSendingWindow } from "@/lib/schedule";
import { db, must } from "@/lib/supabase";
import type { Mailbox, Reply } from "@/lib/types";
import { RunNowButton } from "./run-now";

export default function DashboardPage() {
  return (
    <>
      <PageHeader title="Dashboard" description="Today at a glance. Refreshes automatically." actions={<RunNowButton />} />
      <Suspense fallback={<DashboardSkeleton />}>
        <Dashboard />
      </Suspense>
    </>
  );
}

function DashboardSkeleton() {
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[86px]" />)}</div>
      <div className="grid lg:grid-cols-[1.4fr_1fr] gap-4"><Skeleton className="h-72" /><Skeleton className="h-72" /></div>
    </div>
  );
}

interface Day { day: string; sent: number; opened: number; replied: number; bounced: number }

async function Dashboard() {
  await connection(); // always fresh data, never prerendered
  const supa = db();
  const tz = env.timezone;
  const [daysRaw, mailboxes, counts, replies, engine, campaigns] = await Promise.all([
    supa.rpc("daily_activity", { p_days: 14, p_tz: tz }).then(must),
    supa.from("mailboxes").select("*").order("created_at").then(must),
    supa.rpc("mailbox_sent_today").then(must),
    supa.from("replies").select("*").eq("kind", "reply").order("received_at", { ascending: false }).limit(6).then(must),
    supa.from("app_state").select("value").eq("key", "engine").maybeSingle(),
    supa.from("campaigns").select("id, name, status").eq("status", "active"),
  ]);
  const prepCount = (status: string) => supa.from("campaign_leads").select("id", { count: "exact", head: true })
    .eq("prep_status", status).in("status", ["queued", "in_progress"]).eq("current_step", 0).then((r) => r.count ?? 0);
  const nowIso = new Date().toISOString();
  const [[prepReady, prepPending, prepWorking, prepReview, prepFailed], needsReply, followUpsDue, leadCount, profile, everLaunched] = await Promise.all([
    Promise.all(["ready", "pending", "working", "review", "failed"].map(prepCount)),
    supa.from("replies").select("id", { count: "exact", head: true }).eq("kind", "reply").eq("handled", false)
      .or(`follow_up_at.is.null,follow_up_at.lte.${nowIso}`).then((r) => r.count ?? 0),
    supa.from("replies").select("id", { count: "exact", head: true }).eq("handled", false).lte("follow_up_at", nowIso).then((r) => r.count ?? 0),
    supa.from("leads").select("id", { count: "exact", head: true }).then((r) => r.count ?? 0),
    getProfile(),
    supa.from("campaigns").select("id", { count: "exact", head: true }).neq("status", "draft").then((r) => r.count ?? 0),
  ]);
  const days = (daysRaw as Day[]).map((d) => ({ ...d, sent: Number(d.sent), opened: Number(d.opened), replied: Number(d.replied), bounced: Number(d.bounced) }));
  const today = days.at(-1) ?? { sent: 0, opened: 0, replied: 0, bounced: 0, day: "" };
  const week = days.slice(-7).reduce((a, d) => ({ sent: a.sent + d.sent, replied: a.replied + d.replied, bounced: a.bounced + d.bounced }), { sent: 0, replied: 0, bounced: 0 });
  const sent = new Map((counts as { mailbox_id: string; sent: number }[]).map((c) => [c.mailbox_id, Number(c.sent)]));
  const mbs = mailboxes as Mailbox[];
  const capacity = mbs.filter((m) => m.status === "active").reduce((s, m) => s + effectiveDailyLimit(m), 0);
  const lastTick = (engine.data?.value as { last_tick?: string } | undefined)?.last_tick;
  const engineAlive = isRecent(lastTick, 3 * 60_000);
  const activeCampaigns = (campaigns.data ?? []) as { id: string; name: string }[];
  const max = Math.max(1, ...days.map((d) => d.sent));
  const bounceRate = week.sent ? week.bounced / week.sent : 0;

  return (
    <div className="grid gap-4 fade-in">
      <AutoRefresh seconds={20} />

      <GettingStarted steps={[
        { done: Boolean(profile.services.trim()), title: "Tell the AI what Grevya sells", body: "Settings → Company profile → Import from website, then review.", href: "/settings" },
        { done: mbs.some((m) => m.status === "active"), title: "Connect a mailbox", body: "Add info@grevya.com — GoDaddy is detected automatically.", href: "/mailboxes" },
        { done: leadCount > 0, title: "Add people to email", body: "Type them in, paste a list, or import a CSV.", href: "/leads" },
        { done: Number(everLaunched) > 0, title: "Create and launch a campaign", body: "AI researches each company and writes every email. Preview before launching.", href: "/campaigns" },
        { done: Boolean(engineAlive), title: "Start the sending engine", body: "Run “npm run worker” in a terminal and keep it running.", href: "/settings" },
      ]} />

      {(needsReply > 0 || followUpsDue > 0) && (
        <div className="grid sm:grid-cols-2 gap-3">
          {needsReply > 0 && (
            <Link href="/inbox?f=todo" className="rounded-xl border border-accent/30 bg-accent-soft/50 px-4 py-3 hover:bg-accent-soft transition-colors">
              <div className="text-[22px] font-semibold tabular-nums text-accent">{needsReply}</div>
              <div className="text-[13px]">{needsReply === 1 ? "reply needs" : "replies need"} your answer →</div>
            </Link>
          )}
          {followUpsDue > 0 && (
            <Link href="/inbox?f=due" className="rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 hover:opacity-90 transition-opacity">
              <div className="text-[22px] font-semibold tabular-nums text-warn">{followUpsDue}</div>
              <div className="text-[13px]">follow-up{followUpsDue === 1 ? "" : "s"} due today →</div>
            </Link>
          )}
        </div>
      )}

      {!engineAlive && activeCampaigns.length > 0 && (
        <div className="rounded-xl border border-warn/30 bg-warn-soft text-warn px-4 py-3 text-[13px]">
          <b>The sending engine isn&apos;t running</b>{lastTick ? ` (last run ${timeAgo(lastTick)})` : ""}. Start it with <code className="font-mono">npm run worker</code>, or point a 1-minute cron at <code className="font-mono">/api/engine/tick</code>. See Settings.
        </div>
      )}

      {prepReady + prepPending + prepWorking + prepReview + prepFailed > 0 && (
        <Card className="px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px]">
          <span className="font-medium">AI writer</span>
          <span><b className="text-good tabular-nums">{prepReady}</b> <span className="text-muted">emails ready</span></span>
          {prepPending + prepWorking > 0 && <span><b className="text-info tabular-nums">{prepPending + prepWorking}</b> <span className="text-muted">being researched & written</span></span>}
          {prepReview > 0 && <span><b className="text-warn tabular-nums">{prepReview}</b> <span className="text-muted">awaiting approval</span></span>}
          {prepFailed > 0 && <span><b className="text-bad tabular-nums">{prepFailed}</b> <span className="text-muted">failed</span></span>}
          {Number((engine.data?.value as { prep_rate_limited_for?: number } | undefined)?.prep_rate_limited_for) > 0 && (
            <span className="text-warn">Groq limit reached — writing resumes automatically</span>
          )}
        </Card>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Sent today" value={today.sent} sub={`of ${capacity} capacity`} />
        <Stat label="Replies today" value={today.replied} sub={`${week.replied} this week`} tone={today.replied ? "good" : undefined} />
        <Stat label="Reply rate · 7d" value={pct(week.replied, week.sent)} sub={`${week.sent} sent this week`} />
        <Stat label="Bounce rate · 7d" value={pct(week.bounced, week.sent)} sub={bounceRate > 0.03 ? "High — verify your list" : "Keep under 2–3%"} tone={bounceRate > 0.03 ? "bad" : undefined} />
      </div>

      <div className="grid lg:grid-cols-[1.4fr_1fr] gap-4 items-start">
        <Card>
          <CardHeader title="Last 14 days" description={<span className="flex gap-3"><Legend className="bg-accent" label="Sent" /><Legend className="bg-good" label="Replies" /><Legend className="bg-bad" label="Bounces" /></span>} />
          <div className="px-4 pb-4">
            <div className="flex items-end gap-1.5 h-44">
              {days.map((d) => (
                <div key={d.day} className="group relative flex-1 h-full flex flex-col justify-end">
                  <div className="w-full rounded-t-[4px] bg-accent/80 group-hover:bg-accent transition-[height,background] duration-500" style={{ height: `${(d.sent / max) * 100}%`, minHeight: d.sent ? 2 : 0 }} />
                  {d.replied > 0 && <div className="absolute left-1/2 -translate-x-1/2 size-1.5 rounded-full bg-good" style={{ bottom: `calc(${(d.sent / max) * 100}% + 4px)` }} />}
                  <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block z-10 whitespace-nowrap rounded-lg border border-line bg-panel px-2.5 py-1.5 text-[12px] shadow-lg">
                    <div className="font-medium">{new Date(`${d.day}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</div>
                    <div className="tabular-nums text-muted">{d.sent} sent · {d.replied} replies · {d.bounced} bounces</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-between text-[11px] text-faint mt-1.5 tabular-nums">
              <span>{days[0] && new Date(`${days[0].day}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>
              <span>Today</span>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Mailboxes today" actions={<Link href="/mailboxes" className="text-[12.5px] text-muted hover:text-ink inline-flex items-center gap-0.5">Manage<ArrowUpRight size={13} /></Link>} />
          <div className="grid gap-3 px-4 pb-4">
            {mbs.length === 0 && <p className="text-[13px] text-muted">No mailboxes yet. <Link href="/mailboxes" className="text-accent underline">Add info@grevya.com</Link> to start.</p>}
            {mbs.map((m) => {
              const limit = effectiveDailyLimit(m);
              const s = sent.get(m.id) ?? 0;
              return (
                <div key={m.id} className="grid gap-1.5">
                  <div className="flex items-center justify-between gap-2 text-[13px]">
                    <span className="truncate">{m.email}</span>
                    <span className="flex items-center gap-2 shrink-0">
                      {m.status !== "active" ? <StatusBadge status={m.status} /> : !inSendingWindow(m) && <span className="text-[11.5px] text-faint">outside hours</span>}
                      <span className="tabular-nums text-muted"><b className="text-ink font-medium">{s}</b>/{limit}</span>
                    </span>
                  </div>
                  <Progress value={s} max={limit} />
                </div>
              );
            })}
            <div className="text-[12px] text-faint pt-1 border-t border-line">
              Engine: {lastTick ? <>last run {timeAgo(lastTick)} {engineAlive ? <span className="text-good">● running</span> : <span className="text-warn">● stopped</span>}</> : "never run"}
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Latest replies" actions={<Link href="/inbox" className="text-[12.5px] text-muted hover:text-ink inline-flex items-center gap-0.5">Inbox<ArrowUpRight size={13} /></Link>} />
        {(replies as Reply[]).length === 0 ? (
          <Empty icon={<Inbox size={24} />} title="No replies yet">Replies are picked up from each mailbox&apos;s inbox every 5 minutes.</Empty>
        ) : (
          <div className="divide-y divide-line border-t border-line">
            {(replies as Reply[]).map((r) => (
              <Link key={r.id} href={`/inbox?id=${r.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-panel-2/60 transition-colors">
                <span className={`size-1.5 rounded-full shrink-0 ${r.is_read ? "bg-transparent" : "bg-accent"}`} />
                <span className="font-medium w-48 shrink-0 truncate">{r.from_name || r.from_email}</span>
                <span className="text-muted truncate flex-1">{r.snippet}</span>
                {r.sentiment && r.sentiment !== "neutral" && <StatusBadge status={r.sentiment} />}
                <span className="text-[12px] text-faint shrink-0 tabular-nums">{timeAgo(r.received_at)}</span>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function GettingStarted({ steps }: { steps: { done: boolean; title: string; body: string; href: string }[] }) {
  const left = steps.filter((x) => !x.done).length;
  if (!left) return null;
  const next = steps.findIndex((x) => !x.done);
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <div className="font-semibold">Get set up</div>
          <div className="text-[12.5px] text-muted">{steps.length - left} of {steps.length} done</div>
        </div>
        <div className="h-1.5 w-32 rounded-full bg-panel-2 overflow-hidden"><div className="h-full bg-accent" style={{ width: `${((steps.length - left) / steps.length) * 100}%` }} /></div>
      </div>
      <ol className="grid gap-1.5">
        {steps.map((x, i) => (
          <li key={x.title}>
            <Link href={x.href} className={`flex items-start gap-3 rounded-lg px-3 py-2 transition-colors ${i === next ? "bg-accent-soft/60 hover:bg-accent-soft" : "hover:bg-panel-2"}`}>
              <span className={`mt-0.5 size-5 shrink-0 rounded-full grid place-items-center text-[11px] font-semibold ${x.done ? "bg-good text-white" : i === next ? "bg-accent text-accent-ink" : "bg-panel-2 text-muted"}`}>{x.done ? "✓" : i + 1}</span>
              <span>
                <span className={`block text-[13.5px] ${x.done ? "text-muted line-through" : "font-medium"}`}>{x.title}</span>
                {!x.done && <span className="block text-[12.5px] text-muted">{x.body}</span>}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function isRecent(iso: string | undefined, ms: number): boolean {
  return Boolean(iso) && Date.now() - new Date(iso!).getTime() < ms;
}

function Legend({ className, label }: { className: string; label: string }) {
  return <span className="inline-flex items-center gap-1"><span className={`size-2 rounded-sm ${className}`} />{label}</span>;
}
