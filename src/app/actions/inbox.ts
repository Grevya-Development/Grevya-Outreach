"use server";

import { randomUUID } from "node:crypto";
import { refresh } from "next/cache";
import type { ActionResult } from "@/components/client";
import { appendToSent, sendEmail } from "@/lib/mailer";
import { getProfile } from "@/lib/profile";
import { leadDomain, type Research } from "@/lib/research";
import { db, must } from "@/lib/supabase";
import type { Mailbox, Reply } from "@/lib/types";
import { isEmailSyntax } from "@/lib/verify";
import { draftReply } from "@/lib/writer";
import { requireAuth } from "./auth";

/** Stays a little under the provider's 500/day so manual mail never trips it. */
const PROVIDER_DAILY_MAX = 490;

async function sentToday(mb: Mailbox): Promise<number> {
  const rows = must(await db().rpc("mailbox_sent_today")) as { mailbox_id: string; sent: number }[];
  return Number(rows.find((r) => r.mailbox_id === mb.id)?.sent ?? 0);
}

async function sendManual(opts: {
  mailbox: Mailbox; to: string; subject: string; body: string; leadId: string | null; campaignId: string | null;
  inReplyTo?: string | null; references?: string | null; replyId?: string | null;
}) {
  const { mailbox: mb } = opts;
  if (mb.status === "error") throw new Error(`${mb.email} has a login problem — fix it on the Mailboxes page first`);
  if ((await sentToday(mb)) >= PROVIDER_DAILY_MAX) throw new Error(`${mb.email} has reached today's sending limit`);
  const supa = db();
  const id = randomUUID();
  const signature = mb.signature || mb.from_name.split(" ")[0] || "";
  const text = signature && !opts.body.includes(signature) ? `${opts.body.trim()}\n\n${signature}` : opts.body.trim();
  const { messageIdHeader, raw } = await sendEmail({
    mailbox: mb, to: opts.to, subject: opts.subject, text, messageId: id,
    inReplyTo: opts.inReplyTo ?? null, references: opts.references ?? null, trackOpens: false, trackClicks: false,
  });
  must(await supa.from("messages").insert({
    id, kind: "manual", lead_id: opts.leadId, campaign_id: opts.campaignId, mailbox_id: mb.id, from_email: mb.email,
    step_number: 0, to_email: opts.to, subject: opts.subject, body: text, message_id: messageIdHeader, status: "sent", reply_id: opts.replyId ?? null,
  }));
  await appendToSent(mb, raw);
}

/** Replies to a prospect's reply from inside the app, in the same email thread. */
export async function replyTo(replyId: string, body: string): Promise<ActionResult> {
  await requireAuth();
  if (!body.trim()) return { ok: false, error: "Write a reply first" };
  const supa = db();
  const r = must(await supa.from("replies").select("*").eq("id", replyId).single()) as Reply;
  let mb = r.mailbox_id ? ((await supa.from("mailboxes").select("*").eq("id", r.mailbox_id).maybeSingle()).data as Mailbox | null) : null;
  mb ??= (must(await supa.from("mailboxes").select("*").neq("status", "error").order("created_at").limit(1)) as Mailbox[])[0] ?? null;
  if (!mb) return { ok: false, error: "No mailbox to send from" };
  const subject = /^re:/i.test(r.subject) ? r.subject : `Re: ${r.subject || "your email"}`;
  try {
    await sendManual({
      mailbox: mb, to: r.from_email, subject, body, leadId: r.lead_id, campaignId: r.campaign_id,
      inReplyTo: r.message_id, references: r.references_header ?? r.message_id, replyId: r.id,
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  must(await supa.from("replies").update({ handled: true, is_read: true, answered_at: new Date().toISOString(), follow_up_at: null }).eq("id", r.id));
  refresh();
  return { ok: true, message: `Reply sent to ${r.from_email}` };
}

/** AI-drafted answer to a reply (not sent — the user edits it first). */
export async function suggestReply(replyId: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  await requireAuth();
  const supa = db();
  const r = must(await supa.from("replies").select("*").eq("id", replyId).single()) as Reply;
  const [profile, lastSent, mb] = await Promise.all([
    getProfile(),
    r.lead_id
      ? supa.from("messages").select("body").eq("lead_id", r.lead_id).eq("status", "sent").order("sent_at", { ascending: false }).limit(1).then((x) => x.data?.[0]?.body ?? "")
      : Promise.resolve(""),
    r.mailbox_id ? supa.from("mailboxes").select("from_name").eq("id", r.mailbox_id).maybeSingle().then((x) => x.data?.from_name ?? "") : Promise.resolve(""),
  ]);
  if (!profile.services.trim()) return { ok: false, error: "Fill in your company profile (Settings) so the AI knows what to say" };
  let analysis: Research["analysis"] = null;
  const domain = leadDomain({ email: r.from_email });
  if (domain) analysis = ((await supa.from("company_research").select("analysis").eq("domain", domain).maybeSingle()).data?.analysis as Research["analysis"]) ?? null;
  try {
    const text = await draftReply({
      profile, senderName: String(mb).split(" ")[0], theirReply: r.body || r.snippet, theirName: r.from_name || r.from_email,
      ourLastEmail: lastSent, sentiment: r.sentiment, analysis,
    });
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Sets (or clears) a reminder to follow up on a conversation. */
export async function setFollowUp(replyId: string, when: string | null): Promise<ActionResult> {
  await requireAuth();
  const at = when ? new Date(when) : null;
  if (at && Number.isNaN(at.getTime())) return { ok: false, error: "Pick a valid date" };
  must(await db().from("replies").update({ follow_up_at: at?.toISOString() ?? null, handled: false }).eq("id", replyId));
  refresh();
  return { ok: true, message: at ? `Reminder set for ${at.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}` : "Reminder cleared" };
}

export async function setHandled(replyId: string, handled: boolean): Promise<ActionResult> {
  await requireAuth();
  must(await db().from("replies").update({ handled, is_read: true, ...(handled ? { follow_up_at: null } : {}) }).eq("id", replyId));
  refresh();
  return { ok: true, message: handled ? "Marked done" : "Moved back to open" };
}

export async function saveNote(replyId: string, note: string): Promise<ActionResult> {
  await requireAuth();
  must(await db().from("replies").update({ note: note.slice(0, 5000) }).eq("id", replyId));
  return { ok: true };
}

/** Writes and sends a one-off email (not part of a campaign). */
export async function sendOneOff(input: { mailboxId: string; to: string; subject: string; body: string; firstName?: string; company?: string }): Promise<ActionResult> {
  await requireAuth();
  const to = input.to.trim().toLowerCase();
  if (!isEmailSyntax(to)) return { ok: false, error: "Enter a valid email address" };
  if (!input.subject.trim() || !input.body.trim()) return { ok: false, error: "Subject and message are required" };
  const supa = db();
  const { data: blocked } = await supa.from("suppressions").select("reason").eq("email", to).maybeSingle();
  if (blocked) return { ok: false, error: `${to} is on your block list (${blocked.reason}) — they asked not to be emailed` };
  const mb = must(await supa.from("mailboxes").select("*").eq("id", input.mailboxId).single()) as Mailbox;

  // Keep everyone you email in Leads, so replies are matched and they can join campaigns later.
  const { data: existing } = await supa.from("leads").select("id, tags").eq("email", to).maybeSingle();
  let leadId = existing?.id as string | undefined;
  if (!leadId) {
    leadId = (must(await supa.from("leads").insert({
      email: to, first_name: input.firstName?.trim() ?? "", company: input.company?.trim() ?? "", tags: ["manual"],
    }).select("id").single()) as { id: string }).id;
  }
  try {
    await sendManual({ mailbox: mb, to, subject: input.subject.trim(), body: input.body, leadId, campaignId: null });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  refresh();
  return { ok: true, message: `Sent to ${to}` };
}

export interface ThreadItem {
  id: string;
  direction: "out" | "in";
  at: string;
  subject: string;
  body: string;
  who: string;
  label: string;
}

/** The whole conversation with this person: what we sent (campaign + manual) and what they replied. */
export async function getThread(replyId: string): Promise<ThreadItem[]> {
  await requireAuth();
  const supa = db();
  const r = must(await supa.from("replies").select("lead_id, from_email").eq("id", replyId).single()) as { lead_id: string | null; from_email: string };
  const [sent, received] = await Promise.all([
    (r.lead_id ? supa.from("messages").select("id, sent_at, subject, body, from_email, kind, step_number, status").eq("lead_id", r.lead_id)
      : supa.from("messages").select("id, sent_at, subject, body, from_email, kind, step_number, status").eq("to_email", r.from_email))
      .in("status", ["sent", "bounced"]).order("sent_at").limit(50).then(must),
    (r.lead_id ? supa.from("replies").select("id, received_at, subject, body, snippet, from_name, from_email, kind").eq("lead_id", r.lead_id)
      : supa.from("replies").select("id, received_at, subject, body, snippet, from_name, from_email, kind").eq("from_email", r.from_email))
      .order("received_at").limit(50).then(must),
  ]);
  const items: ThreadItem[] = [
    ...(sent as { id: string; sent_at: string; subject: string; body: string; from_email: string | null; kind: string; step_number: number; status: string }[]).map((m) => ({
      id: m.id, direction: "out" as const, at: m.sent_at, subject: m.subject, body: m.body, who: m.from_email ?? "you",
      label: m.kind === "manual" ? "You wrote" : `Campaign email ${m.step_number}${m.status === "bounced" ? " (bounced)" : ""}`,
    })),
    ...(received as { id: string; received_at: string; subject: string; body: string; snippet: string; from_name: string; from_email: string; kind: string }[]).map((x) => ({
      id: x.id, direction: "in" as const, at: x.received_at, subject: x.subject, body: x.body || x.snippet, who: x.from_name || x.from_email,
      label: x.kind === "auto_reply" ? "Auto-reply" : x.kind === "bounce" ? "Bounce" : "Reply",
    })),
  ];
  return items.sort((a, b) => a.at.localeCompare(b.at));
}
