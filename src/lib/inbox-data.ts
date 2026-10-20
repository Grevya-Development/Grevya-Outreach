// Inbox reads, shared by the /inbox page and its GET route handlers. Server only (it uses the
// service-role client); client components may import its types.
import { db, isMissingRpc, must } from "./supabase";
import type { Mailbox, Reply } from "./types";

export type InboxView = "todo" | "reminders" | "done" | "auto" | "all";

/** A conversation in the list: the reply plus the names the list shows. */
export type InboxRow = Reply & {
  campaigns: { name: string } | null;
  mailboxes: { email: string } | null;
  leads: { company: string } | null;
};

/** View counts. Before migration 0004 only `todo` and `reminders` are known. */
export type InboxCounts = {
  todo: number;
  reminders: number;
  done?: number;
  auto?: number;
  all?: number;
  labels?: Record<string, number>;
  /** The soonest reminder still in the future (shown when To do is empty). */
  next_reminder?: string | null;
};

export type InboxQuery = {
  f: InboxView;
  label?: string;
  campaign?: string;
  account?: string;
  q?: string;
  before?: string;
  since?: string;
  limit?: number;
};

export type FilterOptions = {
  campaigns: { id: string; name: string }[];
  mailboxes: Pick<Mailbox, "id" | "email" | "imap_host" | "status">[];
};

export interface ThreadItem {
  id: string;
  direction: "out" | "in";
  at: string;
  subject: string;
  body: string;
  who: string;
  label: string;
}

export const PAGE_SIZE = 50;
const SELECT = "*, campaigns(name), mailboxes(email), leads(company)";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `f` from the URL. Old links used `due` and `later`. */
export function parseView(f: unknown): InboxView {
  if (f === "due") return "todo";
  if (f === "later") return "reminders";
  return f === "reminders" || f === "done" || f === "auto" || f === "all" ? f : "todo";
}

/** The inbox query from search params (page props or a route's URLSearchParams). Bad values are dropped. */
export function parseQuery(sp: URLSearchParams | Record<string, string | string[] | undefined>): InboxQuery {
  const get = (k: string) => {
    const v = sp instanceof URLSearchParams ? sp.get(k) : sp[k];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const uuid = (k: string) => { const v = get(k); return v && UUID.test(v) ? v : undefined; };
  const iso = (k: string) => { const v = get(k); return v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined; };
  const label = get("label");
  return {
    f: parseView(get("f")),
    label: label && /^[a-z_]+$/.test(label) ? label : undefined,
    campaign: uuid("campaign"),
    account: uuid("account"),
    q: get("q")?.slice(0, 100),
    before: iso("before"),
    since: iso("since"),
  };
}

/** One page of conversations, newest first. */
export async function listReplies(query: InboxQuery): Promise<InboxRow[]> {
  const now = new Date().toISOString();
  let q = db().from("replies").select(SELECT).order("received_at", { ascending: false }).limit(Math.min(query.limit ?? PAGE_SIZE, 100));
  switch (query.f) {
    case "todo": // replies waiting for an answer, plus reminders that are due
      q = q.eq("handled", false).or(`follow_up_at.lte.${now},and(kind.eq.reply,follow_up_at.is.null)`);
      break;
    case "reminders":
      q = q.eq("handled", false).gt("follow_up_at", now);
      break;
    case "done":
      q = q.eq("kind", "reply").eq("handled", true);
      break;
    case "auto":
      q = q.in("kind", ["auto_reply", "bounce"]);
      break;
  }
  if (query.label) q = q.eq("sentiment", query.label);
  if (query.campaign) q = q.eq("campaign_id", query.campaign);
  if (query.account) q = q.eq("mailbox_id", query.account);
  if (query.q) {
    const safe = query.q.replace(/[,()%*]/g, " ").trim();
    if (safe) q = q.or(`from_email.ilike.%${safe}%,from_name.ilike.%${safe}%,subject.ilike.%${safe}%,snippet.ilike.%${safe}%`);
  }
  if (query.before) q = q.lt("received_at", query.before);
  if (query.since) q = q.gt("received_at", query.since);
  return must(await q) as unknown as InboxRow[];
}

/** One conversation by id, whatever view it's in (deep links). */
export async function getReplyRow(id: string): Promise<InboxRow | null> {
  if (!UUID.test(id)) return null;
  const { data } = await db().from("replies").select(SELECT).eq("id", id).maybeSingle();
  return (data as unknown as InboxRow | null) ?? null;
}

/** Counts for the views and labels: one RPC (0004), or two direct counts before it. */
export async function inboxCounts(): Promise<InboxCounts> {
  const supa = db();
  const now = new Date().toISOString();
  const [rpc, next] = await Promise.all([
    supa.rpc("inbox_counts"),
    supa.from("replies").select("follow_up_at").eq("handled", false).gt("follow_up_at", now)
      .order("follow_up_at", { ascending: true }).limit(1).then((r) => (r.data?.[0]?.follow_up_at as string | undefined) ?? null),
  ]);
  if (!rpc.error && rpc.data) {
    const c = rpc.data as Record<string, unknown>;
    const n = (k: string) => Number(c[k]) || 0;
    return {
      todo: n("todo"), reminders: n("reminders"), done: n("done"), auto: n("auto"), all: n("all"),
      labels: (c.labels as Record<string, number> | null) ?? {}, next_reminder: next,
    };
  }
  if (rpc.error && !isMissingRpc(rpc.error)) console.error("inbox_counts:", rpc.error.message);
  const count = () => supa.from("replies").select("id", { count: "exact", head: true }).eq("handled", false);
  const [todo, reminders] = await Promise.all([
    count().or(`follow_up_at.lte.${now},and(kind.eq.reply,follow_up_at.is.null)`),
    count().gt("follow_up_at", now),
  ]);
  return { todo: todo.count ?? 0, reminders: reminders.count ?? 0, next_reminder: next };
}

/** Campaigns and email accounts for the filter selects (and the reply-detection warning). */
export async function filterOptions(): Promise<FilterOptions> {
  const supa = db();
  const [campaigns, mailboxes] = await Promise.all([
    supa.from("campaigns").select("id, name").order("created_at", { ascending: false }).then(must),
    supa.from("mailboxes").select("id, email, imap_host, status").order("created_at").then(must),
  ]);
  return { campaigns: campaigns as FilterOptions["campaigns"], mailboxes: mailboxes as FilterOptions["mailboxes"] };
}

type SentRow = { id: string; sent_at: string; subject: string; body: string; from_email: string | null; kind: string; step_number: number; status: string };
type ReceivedRow = { id: string; received_at: string; subject: string; body: string; snippet: string; from_name: string; from_email: string; kind: string };

/** The whole conversation with this person: what we sent (campaign + manual) and what they replied. Null if the reply doesn't exist. */
export async function loadThread(replyId: string): Promise<ThreadItem[] | null> {
  if (!UUID.test(replyId)) return null;
  const { data: r } = await db().from("replies").select("lead_id, from_email").eq("id", replyId).maybeSingle();
  if (!r) return null;
  const { lead_id, from_email } = r as { lead_id: string | null; from_email: string };
  return threadFor({ leadId: lead_id, email: from_email });
}

/** Every email to and from one person (by lead, else by address), oldest first. */
export async function threadFor({ leadId, email }: { leadId: string | null; email: string }): Promise<ThreadItem[]> {
  const supa = db();
  const sentCols = "id, sent_at, subject, body, from_email, kind, step_number, status";
  const gotCols = "id, received_at, subject, body, snippet, from_name, from_email, kind";
  const [sent, received] = await Promise.all([
    (leadId ? supa.from("messages").select(sentCols).eq("lead_id", leadId) : supa.from("messages").select(sentCols).eq("to_email", email))
      .in("status", ["sent", "bounced"]).order("sent_at").limit(50).then(must),
    (leadId ? supa.from("replies").select(gotCols).eq("lead_id", leadId) : supa.from("replies").select(gotCols).eq("from_email", email))
      .order("received_at").limit(50).then(must),
  ]);
  const items: ThreadItem[] = [
    ...(sent as SentRow[]).map((m) => ({
      id: m.id, direction: "out" as const, at: m.sent_at, subject: m.subject, body: m.body, who: m.from_email ?? "you",
      label: m.kind === "manual" ? "You wrote" : `Email ${m.step_number}${m.status === "bounced" ? " (bounced)" : ""}`,
    })),
    ...(received as ReceivedRow[]).map((x) => ({
      id: x.id, direction: "in" as const, at: x.received_at, subject: x.subject, body: x.body || x.snippet, who: x.from_name || x.from_email,
      label: x.kind === "auto_reply" ? "Auto-reply" : x.kind === "bounce" ? "Bounce" : "Reply",
    })),
  ];
  return items.sort((a, b) => a.at.localeCompare(b.at));
}
