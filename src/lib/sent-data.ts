// Sent mail: every email this app sent (campaign steps and ones you wrote), newest first, with
// whether the person replied. Server only.
import { threadFor, type ThreadItem } from "./inbox-data";
import { db, must } from "./supabase";

export type SentFilter = "all" | "replied" | "bounced";

export type SentQuery = { f: SentFilter; q?: string; campaign?: string; before?: string };

export type SentRow = {
  id: string;
  sent_at: string;
  to_email: string;
  subject: string;
  snippet: string;
  step_number: number;
  kind: string | null;
  status: string;
  open_count: number;
  lead_id: string | null;
  campaign: string | null;
  from_email: string | null;
  lead: { name: string; company: string } | null;
  /** The newest human reply from this person after this email, if any. */
  replyId: string | null;
};

export const SENT_PAGE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSentQuery(sp: Record<string, string | string[] | undefined>): SentQuery {
  const get = (k: string) => (typeof sp[k] === "string" && (sp[k] as string).trim() ? (sp[k] as string).trim() : undefined);
  const f = get("f");
  const campaign = get("campaign");
  const before = get("before");
  return {
    f: f === "replied" || f === "bounced" ? f : "all",
    q: get("q")?.slice(0, 100),
    campaign: campaign && UUID.test(campaign) ? campaign : undefined,
    before: before && !Number.isNaN(Date.parse(before)) ? new Date(before).toISOString() : undefined,
  };
}

type Raw = {
  id: string; sent_at: string; to_email: string; subject: string; body: string; step_number: number; kind: string | null; status: string;
  open_count: number; lead_id: string | null; from_email: string | null;
  campaigns: { name: string } | null; leads: { first_name: string; last_name: string; company: string } | null;
};

export async function listSent(query: SentQuery): Promise<SentRow[]> {
  const supa = db();
  let q = supa.from("messages")
    .select("id, sent_at, to_email, subject, body, step_number, kind, status, open_count, lead_id, from_email, campaigns(name), leads(first_name, last_name, company)")
    .in("status", ["sent", "bounced"]).order("sent_at", { ascending: false }).limit(SENT_PAGE);
  if (query.f === "bounced") q = q.eq("status", "bounced");
  if (query.f === "replied") {
    // People who replied (most recent 300), then their emails.
    const ids = must(await supa.from("replies").select("lead_id").eq("kind", "reply").not("lead_id", "is", null)
      .order("received_at", { ascending: false }).limit(300)) as { lead_id: string }[];
    const leadIds = [...new Set(ids.map((r) => r.lead_id))];
    if (!leadIds.length) return [];
    q = q.in("lead_id", leadIds);
  }
  if (query.campaign) q = q.eq("campaign_id", query.campaign);
  if (query.q) {
    const safe = query.q.replace(/[,()%*]/g, " ").trim();
    if (safe) q = q.or(`to_email.ilike.%${safe}%,subject.ilike.%${safe}%`);
  }
  if (query.before) q = q.lt("sent_at", query.before);
  const rows = must(await q) as unknown as Raw[];

  // Which of these people replied, and to which conversation.
  const leadIds = [...new Set(rows.map((r) => r.lead_id).filter(Boolean))] as string[];
  const replies = leadIds.length
    ? (must(await supa.from("replies").select("id, lead_id, received_at").eq("kind", "reply").in("lead_id", leadIds)
      .order("received_at", { ascending: false })) as { id: string; lead_id: string; received_at: string }[])
    : [];

  return rows.map((r) => {
    const reply = replies.find((x) => x.lead_id === r.lead_id && x.received_at > r.sent_at) ?? null;
    const name = r.leads ? [r.leads.first_name, r.leads.last_name].filter(Boolean).join(" ") : "";
    return {
      id: r.id, sent_at: r.sent_at, to_email: r.to_email, subject: r.subject, snippet: r.body.replace(/\s+/g, " ").slice(0, 160),
      step_number: r.step_number, kind: r.kind, status: r.status, open_count: r.open_count ?? 0, lead_id: r.lead_id,
      campaign: r.campaigns?.name ?? null, from_email: r.from_email,
      lead: r.leads ? { name, company: r.leads.company ?? "" } : null, replyId: reply?.id ?? null,
    };
  });
}

/** One sent email and the whole conversation with that person. */
export async function sentThread(messageId: string): Promise<{ message: SentRow; thread: ThreadItem[]; latestReplyId: string | null } | null> {
  if (!UUID.test(messageId)) return null;
  const supa = db();
  const { data } = await supa.from("messages")
    .select("id, sent_at, to_email, subject, body, step_number, kind, status, open_count, lead_id, from_email, campaigns(name), leads(first_name, last_name, company)")
    .eq("id", messageId).maybeSingle();
  const r = data as unknown as Raw | null;
  if (!r) return null;
  const thread = await threadFor({ leadId: r.lead_id, email: r.to_email });
  const latestReply = [...thread].reverse().find((t) => t.direction === "in" && t.label === "Reply") ?? null;
  const name = r.leads ? [r.leads.first_name, r.leads.last_name].filter(Boolean).join(" ") : "";
  return {
    message: {
      id: r.id, sent_at: r.sent_at, to_email: r.to_email, subject: r.subject, snippet: "", step_number: r.step_number, kind: r.kind,
      status: r.status, open_count: r.open_count ?? 0, lead_id: r.lead_id, campaign: r.campaigns?.name ?? null, from_email: r.from_email,
      lead: r.leads ? { name, company: r.leads.company ?? "" } : null, replyId: latestReply?.id ?? null,
    },
    thread,
    latestReplyId: latestReply?.id ?? null,
  };
}
