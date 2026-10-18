import { PenLine } from "lucide-react";
import { connection } from "next/server";
import { Suspense } from "react";
import { Button, PageHeader, Skeleton } from "@/components/ui";
import { filterOptions, getReplyRow, inboxCounts, listReplies, PAGE_SIZE, parseQuery } from "@/lib/inbox-data";
import { db, must } from "@/lib/supabase";
import type { Mailbox } from "@/lib/types";
import { NewEmailButton } from "./compose";
import { InboxView } from "./inbox-client";

export const metadata = { title: "Inbox" };

export default function InboxPage({ searchParams }: PageProps<"/inbox">) {
  return (
    <>
      <PageHeader title="Inbox" description="Every reply from every email account. Answer it, set a reminder, or mark it done."
        actions={
          <Suspense fallback={<Button variant="primary" disabled><PenLine size={15} />New email</Button>}>
            <ComposeData searchParams={searchParams} />
          </Suspense>
        } />
      <Suspense fallback={<InboxSkeleton />}>
        <InboxData searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function ComposeData({ searchParams }: { searchParams: PageProps<"/inbox">["searchParams"] }) {
  await connection();
  const [sp, mailboxes] = await Promise.all([
    searchParams,
    db().from("mailboxes").select("id, email, status").order("created_at").then(must),
  ]);
  return (
    <NewEmailButton mailboxes={mailboxes as Pick<Mailbox, "id" | "email" | "status">[]}
      defaultOpen={sp.compose === "1"} defaultTo={typeof sp.to === "string" ? sp.to : ""} />
  );
}

async function InboxData({ searchParams }: { searchParams: PageProps<"/inbox">["searchParams"] }) {
  await connection(); // the views depend on the current time
  const sp = await searchParams;
  const query = parseQuery(sp);
  const initialId = typeof sp.id === "string" ? sp.id : undefined;
  const [rows, counts, options, linked] = await Promise.all([
    listReplies({ ...query, before: undefined, since: undefined }),
    inboxCounts(),
    filterOptions(),
    initialId ? getReplyRow(initialId) : null,
  ]);
  // A link to one conversation opens it even when it isn't in the current view.
  const all = linked && !rows.some((r) => r.id === linked.id) ? [linked, ...rows] : rows;
  return (
    <InboxView
      rows={all}
      hasMore={rows.length >= PAGE_SIZE}
      cursor={{ newest: rows[0]?.received_at ?? null, oldest: rows.at(-1)?.received_at ?? null }}
      counts={counts}
      options={options}
      filter={{ f: query.f, label: query.label ?? "", campaign: query.campaign ?? "", account: query.account ?? "", q: query.q ?? "" }}
      initialId={linked ? linked.id : undefined}
      renderedAt={requestTime()}
    />
  );
}

/** When this payload was made. The client compares it to spot a payload replayed from the router cache. */
function requestTime(): number {
  return Date.now(); // request-time render (after connection()), so this is the real "now"
}

function InboxSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[190px_320px_minmax(0,1fr)]">
      <Skeleton className="h-10 md:col-span-2 xl:col-span-1 xl:h-[300px]" />
      <Skeleton className="h-[520px]" />
      <Skeleton className="hidden md:block h-[520px]" />
    </div>
  );
}
