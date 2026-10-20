import { ArrowLeft, ChevronRight, Inbox, PenLine, Reply, Send } from "lucide-react";
import Form from "next/form";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { FilterChip } from "@/app/(app)/campaigns/[id]/campaign-client";
import { Badge, ButtonLink, Card, Empty, Input, PageHeader, Skeleton, cx } from "@/components/ui";
import { fmtDateTime, fmtNum } from "@/lib/format";
import { listSent, parseSentQuery, SENT_PAGE, sentThread, type SentQuery, type SentRow } from "@/lib/sent-data";
import { CheckRepliesButton } from "../check-replies";
import { InboxTabs } from "../tabs";

export const metadata = { title: "Sent" };

type SP = PageProps<"/inbox/sent">["searchParams"];

export default function SentPage({ searchParams }: PageProps<"/inbox/sent">) {
  return (
    <>
      <PageHeader title="Inbox" description="Every email sent from your accounts, and who replied. Click one to see the whole conversation."
        actions={<>
          <Suspense fallback={null}><CheckRepliesButton /></Suspense>
          <ButtonLink href="/inbox?compose=1" variant="primary"><PenLine size={15} />New email</ButtonLink>
        </>}
        tabs={<InboxTabs active="sent" />} />
      <Suspense fallback={<div className="grid gap-4 md:grid-cols-[360px_minmax(0,1fr)]"><Skeleton className="h-[520px]" /><Skeleton className="hidden md:block h-[520px]" /></div>}>
        <SentData searchParams={searchParams} />
      </Suspense>
    </>
  );
}

function href(q: SentQuery, patch: Partial<SentQuery> & { id?: string | null }): string {
  const p = new URLSearchParams();
  const next = { ...q, ...patch };
  if (next.f !== "all") p.set("f", next.f);
  if (next.q) p.set("q", next.q);
  if (next.campaign) p.set("campaign", next.campaign);
  if (next.before) p.set("before", next.before);
  if (patch.id) p.set("id", patch.id);
  const s = p.toString();
  return s ? `/inbox/sent?${s}` : "/inbox/sent";
}

const stepLabel = (m: Pick<SentRow, "kind" | "step_number">) => (m.kind === "manual" ? "You wrote" : `Email ${m.step_number}`);

async function SentData({ searchParams }: { searchParams: SP }) {
  await connection();
  const sp = await searchParams;
  const query = parseSentQuery(sp);
  const id = typeof sp.id === "string" ? sp.id : null;
  const [rows, open] = await Promise.all([listSent(query), id ? sentThread(id) : null]);

  const filters = (
    <div className="flex flex-wrap items-center gap-2">
      <Form action="/inbox/sent" key={query.q ?? ""} className="flex-1 min-w-[180px] max-w-sm">
        <Input name="q" defaultValue={query.q} placeholder="Search by email or subject" aria-label="Search sent emails" className="h-8 text-[13px]" />
        {query.f !== "all" && <input type="hidden" name="f" value={query.f} />}
        {query.campaign && <input type="hidden" name="campaign" value={query.campaign} />}
      </Form>
      <div className="flex flex-wrap gap-1.5">
        {([["all", "All"], ["replied", "Replied"], ["bounced", "Bounced"]] as const).map(([k, label]) => (
          <FilterChip key={k} href={href(query, { f: k, before: undefined })} active={query.f === k}>{label}</FilterChip>
        ))}
      </div>
    </div>
  );

  if (!rows.length && !query.before && !open) {
    const filtered = query.f !== "all" || !!query.q || !!query.campaign;
    return (
      <div className="grid gap-3">
        {filters}
        <Card>
          <Empty icon={<Send size={28} />} title={filtered ? "No emails match" : "Nothing sent yet"}
            action={filtered ? <ButtonLink href="/inbox/sent">Clear filters</ButtonLink> : <ButtonLink href="/campaigns" variant="primary">Go to campaigns</ButtonLink>}>
            {filtered ? "Try another filter or search." : "Emails your campaigns send, and ones you write, show up here with the replies they get."}
          </Empty>
        </Card>
      </div>
    );
  }

  return (
    <div className="grid gap-3 min-w-0">
      <div className={cx(open && "max-md:hidden")}>{filters}</div>
      <div className="grid grid-cols-1 gap-4 items-start md:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        <Card className={cx("overflow-hidden min-w-0", open && "max-md:hidden")}>
          <ol className="divide-y divide-line">
            {rows.map((m) => (
              <li key={m.id}>
                <Link href={href(query, { id: m.id })} scroll={false} aria-current={open?.message.id === m.id ? "true" : undefined}
                  className={cx("block px-3 py-2.5 transition-colors", open?.message.id === m.id ? "bg-accent-soft/60" : "hover:bg-panel-2")}>
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13px] font-medium truncate flex-1 min-w-0">{m.lead?.name || m.to_email}</span>
                    <span className="text-[11.5px] text-faint whitespace-nowrap">{fmtDateTime(m.sent_at)}</span>
                  </div>
                  <div className="text-[12.5px] truncate">{m.subject || "(no subject)"}</div>
                  <div className="text-[12px] text-muted truncate">{m.snippet}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-faint">
                    {m.replyId && <Badge tone="good" dot>Replied</Badge>}
                    {m.status === "bounced" && <Badge tone="bad" dot>Bounced</Badge>}
                    {m.open_count > 0 && <Badge>Opened</Badge>}
                    <span className="truncate">{[m.campaign, stepLabel(m)].filter(Boolean).join(" · ")}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ol>
          {(rows.length >= SENT_PAGE || query.before) && (
            <div className="flex justify-between gap-2 px-3 py-2 border-t border-line text-[12.5px]">
              {query.before ? <Link href={href(query, { before: undefined })} className="text-accent hover:underline">Newest</Link> : <span />}
              {rows.length >= SENT_PAGE && <Link href={href(query, { before: rows.at(-1)!.sent_at })} className="text-accent hover:underline inline-flex items-center gap-0.5">Older<ChevronRight size={13} /></Link>}
            </div>
          )}
          {!rows.length && <p className="px-3 py-6 text-center text-[12.5px] text-muted">No older emails.</p>}
        </Card>

        {open ? <Conversation data={open} backHref={href(query, { id: null })} /> : (
          <Card className="hidden md:grid place-items-center min-h-[320px] text-center px-6">
            <div className="grid gap-1.5 justify-items-center text-muted">
              <Inbox size={26} className="text-faint" />
              <p className="text-[13px]">Pick an email to see the whole conversation.</p>
              <p className="text-[12px] text-faint">{fmtNum(rows.length)} shown · replies are checked every couple of minutes while the app runs.</p>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

function Conversation({ data, backHref }: { data: NonNullable<Awaited<ReturnType<typeof sentThread>>>; backHref: string }) {
  const { message: m, thread, latestReplyId } = data;
  return (
    <div className="grid gap-3 min-w-0">
      <Link href={backHref} scroll={false} className="md:hidden inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink"><ArrowLeft size={14} />All sent emails</Link>
      <Card className="px-4 py-3 grid gap-2">
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold truncate">{m.lead?.name || m.to_email}</h2>
            <p className="text-[12.5px] text-muted truncate">{[m.lead?.name ? m.to_email : null, m.lead?.company].filter(Boolean).join(" · ")}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {m.lead_id && <ButtonLink size="sm" variant="ghost" href={`/leads?lead=${m.lead_id}`}>Lead & research</ButtonLink>}
            {latestReplyId
              ? <ButtonLink size="sm" variant="primary" href={`/inbox?id=${latestReplyId}`}><Reply size={14} />Answer in Inbox</ButtonLink>
              : <ButtonLink size="sm" href={`/inbox?compose=1&to=${encodeURIComponent(m.to_email)}`}><PenLine size={14} />Write to them</ButtonLink>}
          </div>
        </div>
        {!latestReplyId && <p className="text-[12px] text-faint">No reply yet. When they answer, it appears here and in Replies.</p>}
      </Card>
      {thread.map((t) => (
        <Card key={t.id} className={cx("px-4 py-3 grid gap-1.5 min-w-0", t.direction === "in" && "border-accent/40 bg-accent-soft/20", t.id === m.id && "ring-2 ring-accent/20")}>
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
            <Badge tone={t.direction === "in" ? (t.label === "Reply" ? "good" : "warn") : "neutral"}>{t.label}</Badge>
            <span className="truncate">From {t.who}</span>
            <span className="ml-auto text-faint whitespace-nowrap">{fmtDateTime(t.at)}</span>
          </div>
          {t.subject && <div className="text-[13.5px] font-medium break-words">{t.subject}</div>}
          <div className="text-[13.5px] whitespace-pre-wrap break-words leading-relaxed">{t.body}</div>
        </Card>
      ))}
    </div>
  );
}
