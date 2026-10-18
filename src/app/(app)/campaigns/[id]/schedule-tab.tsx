"use client";

import { Clock, Mail, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { saveCampaignSettings } from "@/app/actions/campaigns";
import { useAction } from "@/components/client";
import { Badge, ButtonLink, Card, CardHeader, Empty, Field, Input, StatusBadge, cx } from "@/components/ui";
import { fmtDate, fmtDay, fmtNum, fmtTime } from "@/lib/format";
import { daysForFirstEmails, estimateFinish } from "@/lib/schedule";
import { EditFooter, useUnsavedGuard } from "./builder";

export type ScheduleAccount = {
  id: string;
  email: string;
  status: string;
  /** Today's limit, warm-up included. */
  perDay: number;
  /** The limit once warm-up is over. */
  fullPerDay: number;
  warmup: { day: number; fullOn: string } | null;
  /** 'Mon–Fri · 09:00–18:00 · IST' */
  window: string;
  /** When this account may send next (worked out on the server). */
  nextStart: string | null;
  sendDays: number[];
};

const NO_LIMIT = 10000;
const short = (email: string) => `${email.split("@")[0]}@`;

export function ScheduleTab({ campaign, builder, accounts, attachedIds, leadsRemaining, stepDelays, backHref, nextHref }: {
  campaign: { id: string; status: string; daily_limit: number };
  builder: boolean;
  accounts: ScheduleAccount[];
  attachedIds: string[];
  leadsRemaining: number;
  stepDelays: number[];
  backHref?: string;
  nextHref?: string;
}) {
  const router = useRouter();
  const savedIds = attachedIds.filter((id) => accounts.some((a) => a.id === id));
  const [ids, setIds] = useState<string[]>(savedIds);
  const [noLimit, setNoLimit] = useState(campaign.daily_limit >= NO_LIMIT);
  const [limit, setLimit] = useState(campaign.daily_limit >= NO_LIMIT ? 400 : campaign.daily_limit);
  const [saving, run] = useAction();
  const dailyLimit = noLimit ? NO_LIMIT : Math.max(1, Math.min(NO_LIMIT - 1, Math.round(limit) || 1));
  const dirty = dailyLimit !== campaign.daily_limit || [...ids].sort().join() !== [...savedIds].sort().join();
  useUnsavedGuard(dirty);

  const chosen = accounts.filter((a) => ids.includes(a.id));
  const sending = chosen.filter((a) => a.status === "active");
  const accountsTotal = sending.reduce((s, a) => s + a.perDay, 0);
  const perDay = noLimit ? accountsTotal : Math.min(dailyLimit, accountsTotal);
  const fullTotal = sending.reduce((s, a) => s + a.fullPerDay, 0);
  const windows = [...new Set(chosen.map((a) => a.window))];

  const nextStart = sending.map((a) => a.nextStart).filter((x): x is string => !!x).sort()[0];
  const finish = nextStart && perDay > 0
    ? estimateFinish({ leadsRemaining, steps: stepDelays, perDay, startDate: new Date(nextStart), sendDays: [...new Set(sending.flatMap((a) => a.sendDays))] })
    : null;
  const plan = nextStart && perDay > 0 ? { next: nextStart, days: daysForFirstEmails(leadsRemaining, perDay), finish: finish?.toISOString() ?? null } : null;

  const toggle = (id: string) => setIds((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
  const save = () => {
    if (builder && !dirty && nextHref) return router.push(nextHref, { scroll: false });
    run(() => saveCampaignSettings(campaign.id, { mailbox_ids: ids, daily_limit: dailyLimit }), () => { if (builder && nextHref) router.push(nextHref, { scroll: false }); });
  };

  if (!accounts.length) {
    return (
      <Card>
        <Empty icon={<Mail size={28} />} title="Connect an email account to send from"
          action={<ButtonLink href="/mailboxes?connect=1" variant="primary"><Plus size={15} />Connect account</ButtonLink>}>
          Campaigns send from your own email accounts, up to 400 emails a day each once warmed up.
        </Empty>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 min-w-0">
      <Card>
        <CardHeader title="Send from" description="Emails rotate between these accounts. Follow-ups come from the account that sent Email 1."
          actions={<button type="button" className="text-[12.5px] text-accent font-medium hover:underline"
            onClick={() => setIds(accounts.filter((a) => a.status === "active").map((a) => a.id))}>Select all healthy</button>} />
        <div className="grid gap-2 px-4 pb-4">
          {accounts.map((a) => {
            const on = ids.includes(a.id);
            return (
              <label key={a.id} className={cx("flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 cursor-pointer transition-colors",
                on ? "border-accent/50 bg-accent-soft/40" : "border-line hover:bg-panel-2")}>
                <input type="checkbox" className="accent-[var(--accent)]" checked={on} onChange={() => toggle(a.id)} />
                <span className={cx("size-2 rounded-full shrink-0", a.status === "active" ? "bg-good" : a.status === "error" ? "bg-bad" : "bg-warn")} />
                <span className="flex-1 min-w-[160px] truncate">{a.email}</span>
                {a.status !== "active" && <StatusBadge status={a.status} kind="mailbox" />}
                {a.warmup && <Badge tone="info">Warming up · {fmtNum(a.perDay)}/day → {fmtNum(a.fullPerDay)} on {fmtDate(a.warmup.fullOn, { year: true })}</Badge>}
                <span className="text-[12px] text-muted tabular-nums">Today: {fmtNum(a.perDay)}/day</span>
              </label>
            );
          })}
        </div>
      </Card>

      <Card>
        <CardHeader title="When" />
        <div className="px-4 pb-4 grid gap-1.5 text-[13px]">
          {windows.length <= 1 ? (
            <div className="flex items-center gap-2"><Clock size={14} className="text-faint" />{windows[0] ?? accounts[0].window}</div>
          ) : (
            chosen.map((a) => <div key={a.id} className="flex items-center gap-2 min-w-0"><Clock size={14} className="text-faint shrink-0" /><span className="truncate">{a.email}: {a.window}</span></div>)
          )}
          <Link href="/settings/sending" className="text-[12.5px] text-accent hover:underline w-fit">Change in Settings → Sending</Link>
        </div>
      </Card>

      <Card>
        <CardHeader title="How much" />
        <div className="px-4 pb-4 grid gap-3 text-[13px]">
          <div className="flex flex-wrap items-end gap-4">
            <Field label="Campaign daily limit" className="w-44">
              <Input type="number" min={1} max={9999} value={noLimit ? "" : limit} disabled={noLimit} placeholder="No extra limit"
                onChange={(e) => setLimit(Number(e.target.value))} />
            </Field>
            <label className="flex items-center gap-2 h-9 cursor-pointer">
              <input type="checkbox" className="accent-[var(--accent)]" checked={noLimit} onChange={(e) => setNoLimit(e.target.checked)} />
              No extra limit (use account limits)
            </label>
          </div>
          {sending.length ? (
            <p>
              Effective: up to <b className="tabular-nums">{fmtNum(perDay)}/day</b>
              {" = "}{sending.map((a, i) => (
                <span key={a.id}>{i > 0 && " + "}{short(a.email)} {fmtNum(a.perDay)}{a.warmup && ` (warm-up day ${a.warmup.day})`}</span>
              ))}
              {perDay < accountsTotal && <span className="text-muted"> (capped by the campaign daily limit)</span>}.
            </p>
          ) : (
            <p className="text-warn">Choose at least one active account above.</p>
          )}
          {fullTotal < 800 && (
            <p className="text-muted">
              To reach 800/day connect {Math.ceil((800 - fullTotal) / 400)} more account{Math.ceil((800 - fullTotal) / 400) === 1 ? "" : "s"} (400/day each once warmed up).{" "}
              <Link href="/mailboxes?connect=1" className="text-accent hover:underline">Connect account</Link>
            </p>
          )}
          {plan && (
            <p className="text-muted">
              Next send: <b className="text-ink">{fmtDay(plan.next)} {fmtTime(plan.next)}</b>.
              {leadsRemaining > 0 && <> Everyone gets Email 1 in about {fmtNum(plan.days)} working day{plan.days === 1 ? "" : "s"}{plan.finish && <>; the whole sequence finishes around <b className="text-ink">{fmtDate(plan.finish)}</b></>}.</>}
            </p>
          )}
        </div>
      </Card>

      <EditFooter builder={builder} backHref={backHref} dirty={dirty} saving={saving} onSave={save}
        onDiscard={() => { setIds(savedIds); setNoLimit(campaign.daily_limit >= NO_LIMIT); setLimit(campaign.daily_limit >= NO_LIMIT ? 400 : campaign.daily_limit); }} />
    </div>
  );
}
