import { connection } from "next/server";
import { Mail } from "lucide-react";
import { Suspense } from "react";
import { Card, Empty, PageHeader, TableSkeleton } from "@/components/ui";
import { effectiveDailyLimit } from "@/lib/schedule";
import { db, must } from "@/lib/supabase";
import type { Mailbox, PublicMailbox } from "@/lib/types";
import { AddMailboxButton, MailboxCard } from "./mailbox-client";

export const metadata = { title: "Mailboxes" };

export default function MailboxesPage() {
  return (
    <>
      <PageHeader
        title="Mailboxes"
        description="Inboxes the engine sends from. Each one is capped at 400 emails a day (your provider allows 500)."
        actions={<AddMailboxButton />}
      />
      <Suspense fallback={<TableSkeleton rows={3} />}>
        <MailboxList />
      </Suspense>
    </>
  );
}

async function MailboxList() {
  await connection(); // always fresh data, never prerendered
  const supa = db();
  const [rows, counts] = await Promise.all([
    supa.from("mailboxes").select("*").order("created_at").then(must),
    supa.rpc("mailbox_sent_today").then(must),
  ]);
  const sent = new Map((counts as { mailbox_id: string; sent: number }[]).map((c) => [c.mailbox_id, Number(c.sent)]));
  const mailboxes = (rows as Mailbox[]).map(({ password_enc: _p, ...m }) => m as PublicMailbox);

  if (!mailboxes.length) {
    return (
      <Card>
        <Empty icon={<Mail size={28} />} title="No mailboxes yet" action={<AddMailboxButton />}>
          Add info@grevya.com (GoDaddy) to start. You can add more inboxes later to send more per day.
        </Empty>
      </Card>
    );
  }
  const total = mailboxes.filter((m) => m.status === "active").reduce((s, m) => s + effectiveDailyLimit(m), 0);
  return (
    <div className="grid gap-3">
      <p className="text-[13px] text-muted">
        Capacity today: <span className="text-ink font-medium tabular-nums">{total}</span> emails across {mailboxes.filter((m) => m.status === "active").length} active mailbox(es)
      </p>
      {mailboxes.map((m) => (
        <MailboxCard key={m.id} mailbox={m} sentToday={sent.get(m.id) ?? 0} limitToday={effectiveDailyLimit(m)} />
      ))}
    </div>
  );
}
