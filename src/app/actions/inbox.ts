"use server";

import { randomUUID } from "node:crypto";
import type { ActionResult } from "@/components/client";
import { fmtDay } from "@/lib/format";
import { blockReasonLabel, REPLY_LABELS } from "@/lib/labels";
import { appendToSent, sendEmail } from "@/lib/mailer";
import { db, must } from "@/lib/supabase";
import type { Mailbox, Reply, ReplyLabel } from "@/lib/types";
import { isEmailSyntax } from "@/lib/verify";
import { requireAuth } from "./auth";

// Inbox writes. None of them refresh the page: the inbox updates its own state optimistically.
// Reads (the thread, AI suggestions) are GET routes under /api/inbox.

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
  if (mb.status === "error") throw new Error(`${mb.email} has a login problem. Fix it on the Email accounts page first`);
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
  if (!mb) return { ok: false, error: "No email account to send from" };
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
  return { ok: true, message: `Reply sent to ${r.from_email}` };
}

/** Sets (or clears) a reminder to follow up on a conversation. */
export async function setFollowUp(replyId: string, when: string | null): Promise<ActionResult> {
  await requireAuth();
  const at = when ? new Date(when) : null;
  if (at && Number.isNaN(at.getTime())) return { ok: false, error: "Pick a valid date" };
  must(await db().from("replies").update({ follow_up_at: at?.toISOString() ?? null, handled: false }).eq("id", replyId));
  return { ok: true, message: at ? `Reminder set for ${fmtDay(at)}` : "Reminder cleared" };
}

export async function setHandled(replyId: string, handled: boolean): Promise<ActionResult> {
  await requireAuth();
  must(await db().from("replies").update({ handled, is_read: true, ...(handled ? { follow_up_at: null } : {}) }).eq("id", replyId));
  return { ok: true, message: handled ? "Marked done" : "Reopened" };
}

export async function saveNote(replyId: string, note: string): Promise<ActionResult> {
  await requireAuth();
  must(await db().from("replies").update({ note: note.slice(0, 5000) }).eq("id", replyId));
  return { ok: true };
}

/** Writes and sends a one-off email (not part of a campaign). firstName/company are optional extras for the new lead. */
export async function sendOneOff(input: { mailboxId: string; to: string; subject: string; body: string; firstName?: string; company?: string }): Promise<ActionResult> {
  await requireAuth();
  const to = input.to.trim().toLowerCase();
  if (!isEmailSyntax(to)) return { ok: false, error: "Enter a valid email address" };
  if (!input.subject.trim() || !input.body.trim()) return { ok: false, error: "Subject and message are required" };
  const supa = db();
  const { data: blocked } = await supa.from("suppressions").select("reason").eq("email", to).maybeSingle();
  if (blocked) return { ok: false, error: `${to} is on your block list (${blockReasonLabel(blocked.reason)}), so it can't be emailed` };
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
  return { ok: true, message: `Sent to ${to}` };
}

const BLOCKING_LABELS: ReplyLabel[] = ["not_interested", "wrong_person"];
const KNOWN_LABELS = new Set<string>(REPLY_LABELS.map((l) => l.key));
const NEEDS_0004 = "This label needs the optional database update (supabase/migrations/0004_flow.sql).";

/** Lead ids for a reply's sender: the matched lead, or any lead with that email. */
async function senderLeadIds(r: { lead_id: string | null; from_email: string }): Promise<string[]> {
  if (r.lead_id) return [r.lead_id];
  const { data } = await db().from("leads").select("id").eq("email", r.from_email.trim().toLowerCase());
  return (data ?? []).map((l) => l.id as string);
}

/**
 * Labels a reply (null clears it). Not interested / Wrong person also block the address, like
 * reply detection does: block list, lead status, and their waiting campaign emails. Returns the
 * previous label so the inbox can offer Undo.
 */
export async function setReplyLabel(replyId: string, label: ReplyLabel | null): Promise<ActionResult & { blocked?: string; previous?: string | null }> {
  await requireAuth();
  if (label && !KNOWN_LABELS.has(label)) return { ok: false, error: "Unknown label" };
  const supa = db();
  const r = must(await supa.from("replies").select("sentiment, lead_id, from_email").eq("id", replyId).single()) as Pick<Reply, "sentiment" | "lead_id" | "from_email">;
  const previous = r.sentiment ?? null;
  const { error } = await supa.from("replies").update({ sentiment: label ?? "neutral" }).eq("id", replyId);
  if (error) return { ok: false, error: error.code === "23514" ? NEEDS_0004 : error.message };
  if (!label || !BLOCKING_LABELS.includes(label)) return { ok: true, previous };

  const email = r.from_email.trim().toLowerCase();
  // Keep an existing block (e.g. they unsubscribed) as it is, so Undo never removes it.
  must(await supa.from("suppressions").upsert({ email, reason: label }, { onConflict: "email", ignoreDuplicates: true }));
  const ids = await senderLeadIds(r);
  if (ids.length) {
    const block = (status: string) => supa.from("leads").update({ status }).in("id", ids).eq("status", "active");
    const res = await block("blocked");
    if (res.error?.code === "23514") await block("unsubscribed"); // 'blocked' needs 0004
    await supa.from("campaign_leads").update({ status: "unsubscribed", locked_until: null }).in("lead_id", ids).in("status", ["queued", "in_progress"]);
  }
  return { ok: true, blocked: email, previous };
}

/**
 * Undo for a block made by setReplyLabel: removes that block-list entry (not one with another
 * reason), lets the lead be emailed again, and restores the previous label. Campaign emails that
 * were stopped stay stopped.
 */
export async function undoBlock(replyId: string, previous: string | null): Promise<ActionResult> {
  await requireAuth();
  const supa = db();
  const r = must(await supa.from("replies").select("lead_id, from_email").eq("id", replyId).single()) as Pick<Reply, "lead_id" | "from_email">;
  const email = r.from_email.trim().toLowerCase();
  must(await supa.from("suppressions").delete().eq("email", email).in("reason", BLOCKING_LABELS));
  const { data: still } = await supa.from("suppressions").select("email").eq("email", email).maybeSingle();
  if (!still) {
    const ids = await senderLeadIds(r);
    if (ids.length) must(await supa.from("leads").update({ status: "active" }).in("id", ids).in("status", ["blocked", "unsubscribed"]));
  }
  const restore = previous && (KNOWN_LABELS.has(previous) || previous === "neutral") ? previous : null;
  must(await supa.from("replies").update({ sentiment: restore }).eq("id", replyId));
  return { ok: true, message: "Unblocked. They can be added to campaigns again." };
}
