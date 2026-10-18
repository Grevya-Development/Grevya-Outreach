import { connection } from "next/server";
import { Mail } from "lucide-react";
import { cache, Suspense } from "react";
import { Card, Empty, PageHeader, TableSkeleton } from "@/components/ui";
import { getSendingSchedule } from "@/lib/app-state";
import { fmtDate, fmtNum } from "@/lib/format";
import { effectiveDailyLimit, inSendingWindow, MAILBOX_HARD_CAP } from "@/lib/schedule";
import { db, must } from "@/lib/supabase";
import type { Mailbox, PublicMailbox } from "@/lib/types";
import { DomainHealth, HealthSkeleton } from "./health";
import { AddMailboxButton, MailboxCard } from "./mailbox-client";

export const metadata = { title: "Email accounts" };

/** Sending more than this a day takes more than one account. */
const TARGET_PER_DAY = 800;

// The header button and the list both need the schedule: read it once per request.
const schedule = cache(getSendingSchedule);

type Search = PageProps<"/mailboxes">["searchParams"];

export default function MailboxesPage({ searchParams }: PageProps<"/mailboxes">) {
  return (
    <>
      <PageHeader
        title="Email accounts"
        description={`The inboxes your campaigns send from. Each account sends up to ${MAILBOX_HARD_CAP} emails a day (safety limit).`}
        actions={
          <Suspense fallback={<AddMailboxButton />}>
            <ConnectButton params={searchParams} />
          </Suspense>
        }
      />
      <Suspense fallback={<TableSkeleton rows={3} />}>
        <MailboxList params={searchParams} />
      </Suspense>
    </>
  );
}

/** "Connect account", opened straight away for /mailboxes?connect=1. */
async function ConnectButton({ params }: { params: Search }) {
  const [sp, hours] = await Promise.all([params, schedule()]);
  return <AddMailboxButton defaultOpen={first(sp.connect) === "1"} schedule={hours} />;
}

async function MailboxList({ params }: { params: Search }) {
  await connection(); // always fresh data, never prerendered
  const supa = db();
  const [sp, rows, counts, hours, links] = await Promise.all([
    params,
    supa.from("mailboxes").select("*").order("created_at").then(must),
    supa.rpc("mailbox_sent_today").then(must),
    schedule(),
    supa.from("campaign_mailboxes").select("mailbox_id, campaigns(name, status)").then(must),
  ]);
  const sent = new Map((counts as { mailbox_id: string; sent: number }[]).map((c) => [c.mailbox_id, Number(c.sent)]));
  const mailboxes = (rows as Mailbox[]).map(({ password_enc: _p, ...m }) => m as PublicMailbox);

  // Campaigns that still use each account (finished ones don't matter when removing it).
  const usedBy = new Map<string, string[]>();
  for (const l of links as unknown as { mailbox_id: string; campaigns: { name: string; status: string } | null }[]) {
    if (!l.campaigns || l.campaigns.status === "completed") continue;
    usedBy.set(l.mailbox_id, [...(usedBy.get(l.mailbox_id) ?? []), l.campaigns.name]);
  }

  if (!mailboxes.length) {
    return (
      <Card>
        <Empty
          icon={<Mail size={28} />}
          title="No email accounts yet"
          action={<AddMailboxButton schedule={hours} variant="secondary" />}
          secondary={`Each account sends up to ${MAILBOX_HARD_CAP}/day; connect 2–3 to reach ${TARGET_PER_DAY}+.`}
        >
          Connect the inbox you&apos;ll send from. Gmail, Google Workspace, Outlook and GoDaddy are detected automatically.
        </Empty>
      </Card>
    );
  }

  const active = mailboxes.filter((m) => m.status === "active");
  const sentTotal = mailboxes.reduce((s, m) => s + (sent.get(m.id) ?? 0), 0);
  const effective = active.reduce((s, m) => s + effectiveDailyLimit(m), 0);
  const full = active.reduce((s, m) => s + Math.min(MAILBOX_HARD_CAP, m.daily_limit), 0);
  const more = full < TARGET_PER_DAY ? Math.ceil((TARGET_PER_DAY - full) / MAILBOX_HARD_CAP) : 0;
  const test = first(sp.test);

  return (
    <div className="grid gap-3">
      <p className="text-[13px] text-muted">
        Today: <span className="text-ink font-medium tabular-nums">{fmtNum(sentTotal)}</span> of{" "}
        <span className="text-ink font-medium tabular-nums">{fmtNum(effective)}</span> sent across {active.length} active{" "}
        {active.length === 1 ? "account" : "accounts"}
        {more > 0 && <> · for {fmtNum(TARGET_PER_DAY)}/day connect {more} more</>}
      </p>
      {mailboxes.map((m) => (
        <MailboxCard
          key={m.id}
          mailbox={m}
          sentToday={sent.get(m.id) ?? 0}
          limitToday={effectiveDailyLimit(m)}
          inWindow={inSendingWindow(m)}
          fullDate={fullCapacityDate(m)}
          campaignNames={usedBy.get(m.id) ?? []}
          openTest={test === m.id}
          health={
            <Suspense fallback={<HealthSkeleton />}>
              <DomainHealth email={m.email} smtpHost={m.smtp_host} />
            </Suspense>
          }
        />
      ))}
    </div>
  );
}

/** The day warm-up reaches the full daily limit ('25 Nov'), or null without a warm-up. */
function fullCapacityDate(m: PublicMailbox): string | null {
  if (!m.warmup_enabled || m.warmup_increment <= 0) return null;
  const days = Math.max(0, Math.ceil((Math.min(MAILBOX_HARD_CAP, m.daily_limit) - m.warmup_start) / m.warmup_increment));
  const d = new Date(`${String(m.warmup_started_at).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return fmtDate(d.toISOString().slice(0, 10));
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
