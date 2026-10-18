// Analytics (live campaigns' default tab). A server component: range chips are links, the rest is
// rendered from the campaign's stats and the 0004 RPCs (hidden with a hint when they're missing).
import { BarChart3, Download } from "lucide-react";
import { notFound } from "next/navigation";
import { Card, CardHeader, Empty, Stat, Td, Th, buttonClass, cx, pct } from "@/components/ui";
import { APP_TZ, fmtDate, fmtDay, fmtNum, fmtTime } from "@/lib/format";
import { effectiveCampaignCapacity, nextWindowStart } from "@/lib/schedule";
import { db } from "@/lib/supabase";
import { FilterChip } from "./campaign-client";
import { getAiProgress, getCampaign, getDailyActivity, getEngine, getSentToday, getStepStats } from "./data";

const RANGES = ["7", "14", "30", "all"] as const;
type Range = (typeof RANGES)[number];
const RANGE_LABEL: Record<Range, string> = { "7": "7 days", "14": "14 days", "30": "30 days", all: "All time" };
const tzNote = APP_TZ === "Asia/Kolkata" ? " IST" : "";

/** Days shown in the chart and the start of the range ('all': up to 90 days since the campaign was made). */
function rangeWindow(range: Range, createdAt: string): { chartDays: number; since: string | null } {
  const now = Date.now();
  if (range !== "all") return { chartDays: Number(range), since: new Date(now - Number(range) * 86_400_000).toISOString() };
  const createdDays = Math.max(1, Math.ceil((now - new Date(createdAt).getTime()) / 86_400_000));
  return { chartDays: Math.min(90, Math.max(7, createdDays)), since: null };
}

export async function AnalyticsTab({ id, range: rawRange }: { id: string; range?: string }) {
  const data = await getCampaign(id);
  if (!data) notFound();
  const { campaign: c, stats } = data;
  const range: Range = (RANGES as readonly string[]).includes(rawRange ?? "") ? (rawRange as Range) : "30";
  const { chartDays, since } = rangeWindow(range, c.created_at);

  const supa = db();
  const replyCount = (sentiment: string) => {
    let q = supa.from("replies").select("id", { count: "exact", head: true }).eq("campaign_id", id).eq("sentiment", sentiment);
    if (since) q = q.gte("received_at", since);
    return q.then((r) => r.count ?? 0);
  };
  const [daily, stepStats, sentToday, interested, meetings, engine, progress] = await Promise.all([
    getDailyActivity(id, chartDays),
    getStepStats(id, since),
    getSentToday(id),
    replyCount("interested"),
    replyCount("meeting_booked"),
    getEngine(),
    c.mode === "ai" ? getAiProgress(id) : null,
  ]);

  const healthy = data.mailboxes.filter((m) => data.attachedIds.includes(m.id) && m.status === "active");
  const capacity = effectiveCampaignCapacity(healthy, c.daily_limit);
  // The range only applies when the daily numbers are available (migration 0004).
  const inRange = range !== "all" && daily;
  const sum = (k: "sent" | "opened" | "replied" | "bounced") => (daily ?? []).reduce((s, d) => s + d[k], 0);
  const sent = inRange ? sum("sent") : stats?.sent ?? 0;
  const opened = inRange ? sum("opened") : stats?.opened ?? 0;
  const replied = inRange ? sum("replied") : stats?.replied ?? 0;
  const bounced = inRange ? sum("bounced") : stats?.bounced ?? 0;
  const href = (r: Range) => `/campaigns/${id}?tab=analytics${r === "30" ? "" : `&range=${r}`}`;

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap gap-1.5">
        {RANGES.map((r) => <FilterChip key={r} href={href(r)} active={r === range}>{RANGE_LABEL[r]}</FilterChip>)}
      </div>
      <span className="text-[12.5px] text-muted ml-auto tabular-nums">
        Sending today: <b className="text-ink">{fmtNum(sentToday)}</b> of {fmtNum(capacity.perDay)}
      </span>
      <a href={`/api/campaigns/${id}/export`} download className={buttonClass("secondary", "sm")}><Download size={14} />Export CSV</a>
    </div>
  );

  // Nothing sent yet: say when the first emails go out, and what's holding them up.
  if (!(stats?.sent ?? 0)) {
    const next = healthy.map((m) => nextWindowStart(m)).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0];
    const reasons = [
      c.status === "paused" && "The campaign is paused.",
      c.status === "draft" && "The campaign hasn't been launched yet.",
      engine?.paused && "Sending is paused for every campaign (Settings → Sending).",
      engine && !engine.paused && !engine.alive && "Sending is stopped, so nothing goes out until it starts again (Settings → Sending).",
      !healthy.length && "No active email account is selected (Schedule).",
      progress && progress.ready === 0 && progress.review > 0 && "Waiting for you to approve the AI emails (Review).",
      progress && progress.ready === 0 && progress.review === 0 && progress.writing > 0 && "The AI is still writing the first emails.",
    ].filter(Boolean) as string[];
    return (
      <div className="grid gap-4">
        {toolbar}
        <Card>
          <Empty icon={<BarChart3 size={28} />} title="Nothing sent yet">
            {next ? <>First emails go out {fmtDay(next)} {fmtTime(next)}{tzNote}.</> : "First emails go out once an active email account is selected."}
            {reasons.map((r) => <span key={r} className="block mt-1">{r}</span>)}
          </Empty>
        </Card>
      </div>
    );
  }

  const max = Math.max(1, ...(daily ?? []).map((d) => d.sent));
  const quiet = (daily ?? []).every((d) => d.sent === 0 && d.replied === 0);
  const stepRows = Array.from({ length: Math.max(data.steps.length, ...(stepStats ?? []).map((s) => s.step_number)) }, (_, i) =>
    (stepStats ?? []).find((s) => s.step_number === i + 1) ?? { step_number: i + 1, sent: 0, bounced: 0, opened: 0, replied: 0 });

  return (
    <div className="grid gap-4 min-w-0">
      {toolbar}
      {!daily && range !== "all" && <p className="text-[12.5px] text-muted -mt-1">Showing all-time totals.</p>}
      <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 gap-3">
        <Stat label="Sent" value={fmtNum(sent)} />
        {c.track_opens && <Stat label="Opened" value={fmtNum(opened)} sub={`${pct(opened, sent)} (approx.)`} />}
        <Stat label="Replied" value={fmtNum(replied)} sub={pct(replied, sent)} tone={replied ? "good" : undefined} />
        <Stat label="Interested" value={fmtNum(interested)} tone={interested ? "good" : undefined} />
        <Stat label="Meetings booked" value={fmtNum(meetings)} />
        <Stat label="Bounced" value={fmtNum(bounced)} sub={pct(bounced, sent)} tone={sent > 20 && bounced / sent > 0.03 ? "bad" : undefined} />
        <Stat label="Unsubscribed" value={fmtNum(stats?.unsubscribed ?? 0)} sub="all time" />
      </div>

      {daily && stepStats ? (
        <>
          <Card>
            <CardHeader title={range === "all" ? `Last ${chartDays} days` : `Last ${RANGE_LABEL[range]}`}
              description={<span className="flex gap-3"><Legend className="bg-accent" label="Sent" /><Legend className="bg-good" label="Replies" /></span>} />
            <div className="px-4 pb-4">
              <div className="relative flex items-end gap-1 h-44">
                {quiet && <div className="absolute inset-x-0 bottom-0 border-b border-dashed border-line" />}
                {quiet && <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-[12.5px] text-faint">No emails sent in this period</span>}
                {daily.map((d) => (
                  <div key={d.day} className="group relative flex-1 h-full flex flex-col justify-end">
                    <div className="w-full rounded-t-[3px] bg-accent/80 group-hover:bg-accent transition-[height,background] duration-500" style={{ height: `${(d.sent / max) * 100}%`, minHeight: d.sent ? 2 : 0 }} />
                    {d.replied > 0 && <div className="absolute left-1/2 -translate-x-1/2 size-1.5 rounded-full bg-good" style={{ bottom: `calc(${(d.sent / max) * 100}% + 4px)` }} />}
                    <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block z-10 whitespace-nowrap rounded-lg border border-line bg-panel px-2.5 py-1.5 text-[12px] shadow-lg">
                      <div className="font-medium">{fmtDay(d.day)}</div>
                      <div className="tabular-nums text-muted">{fmtNum(d.sent)} sent · {fmtNum(d.replied)} replies · {fmtNum(d.bounced)} bounces</div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex justify-between text-[11px] text-faint mt-1.5 tabular-nums">
                <span>{daily[0] ? fmtDate(daily[0].day) : ""}</span>
                <span>Today</span>
              </div>
            </div>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Each email" description={range === "all" ? undefined : `Emails sent in the last ${RANGE_LABEL[range]}. Replies are counted after the last email a lead got.`} />
            <div className="relative overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead className="bg-panel-2/50">
                  <tr><Th>Email</Th><Th className="text-right">Sent</Th><Th className="text-right">Replies after this email</Th><Th className="text-right">Reply %</Th><Th className="text-right">Bounced</Th></tr>
                </thead>
                <tbody>
                  {stepRows.map((s) => (
                    <tr key={s.step_number}>
                      <Td className="font-medium whitespace-nowrap">{s.step_number === 1 ? "Email 1" : `Email ${s.step_number} · follow-up`}</Td>
                      <Td className="text-right tabular-nums">{fmtNum(s.sent)}</Td>
                      <Td className="text-right tabular-nums">{fmtNum(s.replied)}</Td>
                      <Td className="text-right tabular-nums text-muted">{s.sent ? pct(s.replied, s.sent) : "—"}</Td>
                      <Td className={cx("text-right tabular-nums", s.bounced ? "text-bad" : "text-muted")}>{fmtNum(s.bounced)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      ) : (
        <Card className="px-4 py-3 text-[13px] text-muted">
          The daily chart and per-email results need the optional database update: run <code className="text-ink">supabase/migrations/0004_flow.sql</code>.
        </Card>
      )}
    </div>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return <span className="inline-flex items-center gap-1.5 text-[12px] text-muted"><span className={cx("size-2 rounded-full", className)} />{label}</span>;
}
