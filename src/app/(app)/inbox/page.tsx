import { connection } from "next/server";
import { Suspense } from "react";
import { PageHeader, Skeleton } from "@/components/ui";
import { db, must } from "@/lib/supabase";
import type { Mailbox, Reply } from "@/lib/types";
import { InboxView, NewEmailButton, type InboxRow } from "./inbox-client";

export const metadata = { title: "Inbox" };

export default function InboxPage({ searchParams }: PageProps<"/inbox">) {
  return (
    <>
      <PageHeader title="Inbox" description="Every reply from every mailbox. Answer, set a reminder, or mark it done — nothing falls through."
        actions={<Suspense fallback={null}><Compose /></Suspense>} />
      <Suspense fallback={<div className="grid md:grid-cols-[360px_1fr] gap-4"><Skeleton className="h-[520px]" /><Skeleton className="h-[520px]" /></div>}>
        <InboxData params={searchParams} />
      </Suspense>
    </>
  );
}

async function Compose() {
  await connection();
  const mbs = must(await db().from("mailboxes").select("id, email, status").order("created_at")) as Pick<Mailbox, "id" | "email" | "status">[];
  return <NewEmailButton mailboxes={mbs.filter((m) => m.status !== "error")} />;
}

const FILTERS: Record<string, (q: ReturnType<typeof base>) => ReturnType<typeof base>> = {
  // Needs a reply now: open, and not snoozed into the future.
  todo: (q) => q.eq("kind", "reply").eq("handled", false).or(`follow_up_at.is.null,follow_up_at.lte.${new Date().toISOString()}`),
  due: (q) => q.eq("handled", false).lte("follow_up_at", new Date().toISOString()),
  later: (q) => q.eq("handled", false).gt("follow_up_at", new Date().toISOString()),
  interested: (q) => q.eq("sentiment", "interested"),
  done: (q) => q.eq("kind", "reply").eq("handled", true),
  auto: (q) => q.in("kind", ["auto_reply", "bounce"]),
  all: (q) => q,
};

function base() {
  return db().from("replies").select("*, campaigns(name), mailboxes(email)").order("received_at", { ascending: false }).limit(200);
}

async function InboxData({ params }: { params: PageProps<"/inbox">["searchParams"] }) {
  await connection(); // filters use the current time — render at request time
  const sp = await params;
  const filter = typeof sp.f === "string" && sp.f in FILTERS ? sp.f : "todo";
  const [rows, counts] = await Promise.all([
    FILTERS[filter](base()).then(must),
    Promise.all(["todo", "due", "later"].map(async (k) => {
      const q = db().from("replies").select("id", { count: "exact", head: true });
      const r = await (k === "todo" ? q.eq("kind", "reply").eq("handled", false).or(`follow_up_at.is.null,follow_up_at.lte.${new Date().toISOString()}`)
        : k === "due" ? q.eq("handled", false).lte("follow_up_at", new Date().toISOString())
        : q.eq("handled", false).gt("follow_up_at", new Date().toISOString()));
      return [k, r.count ?? 0] as const;
    })),
  ]);
  return (
    <InboxView
      replies={rows as unknown as (Reply & InboxRow)[]}
      filter={filter}
      counts={Object.fromEntries(counts)}
      initialId={typeof sp.id === "string" ? sp.id : undefined}
    />
  );
}
