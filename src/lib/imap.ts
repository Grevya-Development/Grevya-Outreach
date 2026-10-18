import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { checkBounceRate } from "./bounces";
import { decrypt } from "./crypto";
import { classifyReply } from "./groq";
import { db, must } from "./supabase";
import type { Mailbox } from "./types";

const BOUNCE_FROM = /^(mailer-daemon|postmaster|mail-daemon|mailerdaemon)@/i;
const BOUNCE_SUBJECT = /(undeliver|delivery status notification|delivery failure|returned mail|failure notice|mail delivery failed|could not be delivered)/i;
const DELAY_NOTICE = /(\(delay\)|delivery (is )?delayed|delayed delivery|will (be )?retr(y|ied)|action:\s*delayed|temporar(y|ily) (failure|deferred))/i;
const AUTO_SUBJECT = /(out of (the )?office|automatic reply|auto.?reply|autoreply|on vacation|away from|abwesen|on leave)/i;
const UNSUB_TEXT = /\b(unsubscribe|remove me|take me off|stop emailing|do not contact|don'?t contact|opt.?out)\b/i;
const NO_REPLY = /^\s*(no|nope|no thanks|no thank you|not interested)[\s.!,]*$/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

export function imapClient(mb: Pick<Mailbox, "imap_host" | "imap_port" | "username" | "password_enc">) {
  const client = new ImapFlow({
    host: mb.imap_host!,
    port: mb.imap_port,
    secure: mb.imap_port === 993,
    auth: { user: mb.username, pass: decrypt(mb.password_enc) },
    logger: false,
    socketTimeout: 60_000,
  });
  // Socket errors after connect arrive as 'error' events; without a listener Node crashes the
  // whole worker. The failing command rejects on its own, so logging here is enough.
  client.on("error", () => {});
  return client;
}

/** Strips quoted history so we store and classify only what the person wrote. */
function stripQuoted(text: string): string {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^On .+wrote:\s*$/.test(line) || /^-{2,}\s*Original Message/i.test(line) || /^From: /.test(line) || /^_{5,}/.test(line)) break;
    if (line.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

interface Candidate {
  uid: number;
  from: string;
  subject: string;
  inReplyTo: string;
}

/**
 * Pulls new INBOX messages, records replies/bounces, and stops sequences. Progress is saved
 * one message at a time: if processing fails, the next sync resumes at that message instead
 * of skipping it. Returns how many replies/bounces were recorded.
 */
export async function syncMailbox(mb: Mailbox): Promise<number> {
  const supa = db();
  const client = imapClient(mb);
  await client.connect();
  let recorded = 0;
  let lastUid = mb.imap_last_uid ?? 0;
  let uidValidity: number | null = mb.imap_uidvalidity ?? null;
  let failure: Error | null = null;

  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const box = client.mailbox as { uidValidity?: bigint | number; uidNext?: number } | false;
      const currentValidity = box && box.uidValidity !== undefined ? Number(box.uidValidity) : null;
      // UIDVALIDITY changed (mailbox recreated / different server): old UIDs mean nothing.
      if (currentValidity !== null && uidValidity !== null && currentValidity !== uidValidity) {
        lastUid = 0;
        // Old UIDs can be reused by the new mailbox — release them so new replies aren't "duplicates".
        await supa.from("replies").update({ imap_uid: null }).eq("mailbox_id", mb.id);
      }
      uidValidity = currentValidity;

      const range = lastUid ? { uid: `${lastUid + 1}:*` } : { since: new Date(Date.now() - 7 * 86_400_000) };
      const uids = ((await client.search(range, { uid: true })) || []).filter((u) => u > lastUid).sort((a, b) => a - b);
      if (!uids.length) {
        if (!lastUid && box && box.uidNext) lastUid = box.uidNext - 1; // start tracking from here
        return 0;
      }

      // Envelopes only (cheap) to decide which messages matter.
      const candidates: Candidate[] = [];
      for await (const msg of client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
        candidates.push({
          uid: msg.uid,
          from: msg.envelope?.from?.[0]?.address?.toLowerCase() ?? "",
          subject: msg.envelope?.subject ?? "",
          inReplyTo: msg.envelope?.inReplyTo ?? "",
        });
      }
      candidates.sort((a, b) => a.uid - b.uid);

      // Match senders to leads by address, and by In-Reply-To → a message we sent
      // (catches replies from a colleague, an alias, or a forwarded address).
      const fromAddrs = [...new Set(candidates.map((c) => c.from).filter(Boolean))];
      const replyIds = [...new Set(candidates.map((c) => c.inReplyTo).filter(Boolean))];
      const [leads, threads] = await Promise.all([
        fromAddrs.length ? supa.from("leads").select("id, email").in("email", fromAddrs).then(must) : [],
        replyIds.length ? supa.from("messages").select("message_id, lead_id").in("message_id", replyIds).then(must) : [],
      ]);
      const leadByEmail = new Map((leads as { id: string; email: string }[]).map((l) => [l.email.toLowerCase(), l.id]));
      const leadByThread = new Map((threads as { message_id: string; lead_id: string | null }[]).filter((t) => t.lead_id).map((t) => [t.message_id, t.lead_id!]));

      for (const c of candidates) {
        try {
          const isBounce = BOUNCE_FROM.test(c.from) || BOUNCE_SUBJECT.test(c.subject);
          const leadId = leadByEmail.get(c.from) ?? leadByThread.get(c.inReplyTo);
          if (isBounce || leadId) {
            const full = await client.fetchOne(String(c.uid), { source: true, headers: ["auto-submitted", "x-autoreply", "x-autorespond", "x-failed-recipients", "precedence"] }, { uid: true });
            if (full && full.source) {
              const parsed = await simpleParser(full.source);
              const text = parsed.text ?? "";
              const headerBlob = full.headers?.toString().toLowerCase() ?? "";
              if (isBounce) {
                recorded += await recordBounce(mb, c.uid, c.subject, text, headerBlob);
              } else {
                const isAuto = AUTO_SUBJECT.test(c.subject) || /auto-submitted:\s*auto-(replied|generated)/.test(headerBlob)
                  || headerBlob.includes("x-autoreply") || headerBlob.includes("x-autorespond") || /precedence:\s*(auto_reply|bulk|junk)/.test(headerBlob);
                const refs = parsed.references ? ([] as string[]).concat(parsed.references).join(" ") : "";
                recorded += await recordReply(mb, {
                  uid: c.uid, leadId: leadId!, fromEmail: c.from, fromName: parsed.from?.value?.[0]?.name ?? "",
                  subject: c.subject, body: stripQuoted(text), receivedAt: (parsed.date ?? new Date()).toISOString(), isAuto,
                  messageId: parsed.messageId ?? null, references: [refs, parsed.messageId].filter(Boolean).join(" ").trim() || null,
                });
              }
            }
          }
          lastUid = c.uid; // only after this message is fully handled
        } catch (err) {
          // Retry this message next time — but after 3 failures skip it, so one bad email
          // can't stop reply detection for this mailbox forever.
          const key = `imap_fail:${mb.id}`;
          const { data } = await supa.from("app_state").select("value").eq("key", key).maybeSingle();
          const prev = data?.value as { uid?: number; count?: number } | undefined;
          const count = prev?.uid === c.uid ? (prev.count ?? 0) + 1 : 1;
          if (count >= 3) {
            await supa.from("events").insert({ type: "error", mailbox_id: mb.id, meta: { error: `Skipped inbox message ${c.uid} after 3 failures: ${(err as Error).message}`, subject: c.subject } });
            await supa.from("app_state").delete().eq("key", key);
            lastUid = c.uid;
            continue;
          }
          await supa.from("app_state").upsert({ key, value: { uid: c.uid, count }, updated_at: new Date().toISOString() });
          failure = new Error(`message uid ${c.uid}: ${(err as Error).message}`);
          break;
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await supa.from("mailboxes").update({
      imap_last_uid: lastUid || null, imap_uidvalidity: uidValidity, imap_synced_at: new Date().toISOString(),
    }).eq("id", mb.id);
    await client.logout().catch(() => {});
  }
  if (failure) throw failure;
  return recorded;
}

/** Inserts a reply row; returns false if it was already recorded (duplicate UID). */
async function insertReply(row: Record<string, unknown>): Promise<boolean> {
  for (const [k, v] of Object.entries(row)) if (typeof v === "string") row[k] = v.replace(/\u0000/g, "");
  const { error } = await db().from("replies").insert(row);
  if (!error) return true;
  if (error.code === "23505") return false;
  throw new Error(error.message);
}

async function recordReply(
  mb: Mailbox,
  r: {
    uid: number; leadId: string; fromEmail: string; fromName: string; subject: string; body: string; receivedAt: string; isAuto: boolean;
    messageId: string | null; references: string | null;
  },
): Promise<number> {
  const supa = db();
  const enrollments = must(
    await supa.from("campaign_leads").select("id, campaign_id, mailbox_id, status, campaigns(stop_on_reply)").eq("lead_id", r.leadId).order("created_at", { ascending: false }),
  ) as unknown as { id: string; campaign_id: string; mailbox_id: string | null; status: string; campaigns: { stop_on_reply: boolean } | null }[];
  const cl = enrollments.find((e) => e.mailbox_id === mb.id) ?? enrollments[0];

  // "Unsubscribe" may be only in the subject (mailto: List-Unsubscribe sends an empty body).
  const wantsOut = !r.isAuto && (UNSUB_TEXT.test(r.subject) || UNSUB_TEXT.test(r.body.slice(0, 500)) || NO_REPLY.test(r.body));
  const sentiment = r.isAuto ? null : wantsOut ? "not_interested" : await classifyReply(`${r.subject}\n${r.body}`);

  const inserted = await insertReply({
    mailbox_id: mb.id, lead_id: r.leadId, campaign_id: cl?.campaign_id ?? null, from_email: r.fromEmail, from_name: r.fromName,
    subject: r.subject, snippet: r.body.replace(/\s+/g, " ").slice(0, 200), body: r.body.slice(0, 20_000),
    kind: r.isAuto ? "auto_reply" : "reply", sentiment, received_at: r.receivedAt, imap_uid: r.uid,
    // Auto-replies and "remove me" need no answer; everything else lands in "Needs reply".
    message_id: r.messageId, references_header: r.references, handled: r.isAuto || wantsOut,
  });
  if (!inserted) return 0;

  if (!r.isAuto) {
    // A human reply stops this person's active sequences (when the campaign says so).
    const toStop = enrollments.filter((e) => ["queued", "in_progress", "completed"].includes(e.status) && (e.campaigns?.stop_on_reply ?? true));
    if (toStop.length) must(await supa.from("campaign_leads").update({ status: "replied", locked_until: null }).in("id", toStop.map((e) => e.id)));
    await supa.from("events").insert({ type: "reply", campaign_id: cl?.campaign_id ?? null, lead_id: r.leadId, mailbox_id: mb.id, meta: { sentiment } });
  }
  // Our opt-out line promises: reply "no" and we won't email again. Keep that promise.
  if (wantsOut || sentiment === "not_interested") {
    const lead = must(await supa.from("leads").select("email").eq("id", r.leadId).single()) as { email: string };
    must(await supa.from("leads").update({ status: "unsubscribed" }).eq("id", r.leadId));
    must(await supa.from("suppressions").upsert({ email: lead.email, reason: wantsOut ? "asked to unsubscribe" : "replied not interested" }));
    await supa.from("campaign_leads").update({ status: "unsubscribed", locked_until: null }).eq("lead_id", r.leadId).in("status", ["queued", "in_progress"]);
  }
  return 1;
}

async function recordBounce(mb: Mailbox, uid: number, subject: string, text: string, headers: string): Promise<number> {
  // Delay notices ("will retry") are not bounces — the email usually arrives later.
  const permanent = /action:\s*failed|status:\s*5\.\d+\.\d+|\b5\.\d\.\d+\b|permanent(ly)? (failure|error)/i.test(text);
  if (!permanent && DELAY_NOTICE.test(`${subject}\n${text}`)) return 0;
  if (/status:\s*4\.\d+\.\d+/i.test(text) && !/status:\s*5\.\d+\.\d+/i.test(text)) return 0;

  const supa = db();
  const ownDomain = mb.email.split("@")[1]?.toLowerCase();
  const failedHeader = headers.match(/x-failed-recipients:\s*([^\n]+)/i)?.[1] ?? "";
  const source = failedHeader || text;
  const addresses = [...new Set((source.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()))].filter(
    (e) => !e.endsWith(`@${ownDomain}`) && !BOUNCE_FROM.test(e),
  );
  if (!addresses.length) return 0;

  // Only trust addresses we actually emailed from this mailbox recently.
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const sent = must(
    await supa.from("messages").select("id, lead_id, campaign_id, campaign_lead_id, to_email").eq("mailbox_id", mb.id).gte("sent_at", since).in("to_email", addresses),
  ) as { id: string; lead_id: string | null; campaign_id: string | null; campaign_lead_id: string | null; to_email: string }[];
  if (!sent.length) return 0;

  const target = sent[0];
  const inserted = await insertReply({
    mailbox_id: mb.id, lead_id: target.lead_id, campaign_id: target.campaign_id, from_email: target.to_email,
    subject, snippet: text.replace(/\s+/g, " ").slice(0, 200), body: text.slice(0, 20_000), kind: "bounce", imap_uid: uid,
  });
  if (!inserted) return 0;

  const emails = [...new Set(sent.map((s) => s.to_email))];
  const results = await Promise.all([
    supa.from("messages").update({ status: "bounced" }).in("id", sent.map((s) => s.id)),
    supa.from("leads").update({ status: "bounced" }).in("email", emails),
    supa.from("suppressions").upsert(emails.map((email) => ({ email, reason: "bounce" }))),
    supa.from("campaign_leads").update({ status: "bounced", locked_until: null }).in("id", sent.map((s) => s.campaign_lead_id).filter(Boolean) as string[]),
    supa.from("events").insert(sent.map((s) => ({ type: "bounce", message_id: s.id, campaign_id: s.campaign_id, lead_id: s.lead_id, mailbox_id: mb.id }))),
  ]);
  const err = results.find((r) => r.error)?.error;
  if (err) throw new Error(err.message);
  await checkBounceRate(mb); // late bounces count toward the auto-pause too
  return 1;
}
