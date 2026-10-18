import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import { imapClient } from "./imap";
import { db } from "./supabase";
import { decrypt, sign } from "./crypto";
import { env } from "./env";
import type { Mailbox } from "./types";

export function transportFor(mb: Pick<Mailbox, "smtp_host" | "smtp_port" | "smtp_secure" | "username" | "password_enc">) {
  return nodemailer.createTransport({
    host: mb.smtp_host,
    port: mb.smtp_port,
    secure: mb.smtp_secure,
    auth: { user: mb.username, pass: decrypt(mb.password_enc) },
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')]+[^\s<>"').,;:!?]/g;

export function clickUrl(messageId: string, target: string): string {
  const s = sign(`click:${messageId}:${target}`);
  return `${env.appUrl}/t/c/${messageId}?u=${encodeURIComponent(target)}&s=${s}`;
}

/** Minimal HTML version of a plain-text email — looks like a normal client-written message. */
function toHtml(text: string, opts: { messageId: string; trackClicks: boolean; trackOpens: boolean; unsubscribeUrl?: string }) {
  let html = escapeHtml(text).replace(URL_RE, (raw) => {
    const url = raw.replace(/&amp;/g, "&");
    // Never rewrite our own unsubscribe link.
    const href = opts.trackClicks && url !== opts.unsubscribeUrl ? clickUrl(opts.messageId, url) : url;
    return `<a href="${escapeHtml(href)}">${raw}</a>`;
  });
  html = html.split(/\n{2,}/).map((p) => `<p style="margin:0 0 1em">${p.replace(/\n/g, "<br>")}</p>`).join("");
  const pixel = opts.trackOpens
    ? `<img src="${env.appUrl}/t/o/${opts.messageId}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">`
    : "";
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">${html}${pixel}</div>`;
}

export interface OutgoingEmail {
  mailbox: Mailbox;
  to: string;
  subject: string;
  text: string;
  messageId: string; // our messages.id (uuid)
  inReplyTo?: string | null;
  /** Full References chain for replies (defaults to inReplyTo). */
  references?: string | null;
  trackOpens: boolean;
  trackClicks: boolean;
  /** Add a List-Unsubscribe header (mailto always; https one-click when a public URL is given). */
  listUnsubscribe?: boolean;
  unsubscribeUrl?: string;
  oneClickUnsubscribeUrl?: string;
}

export async function sendEmail(e: OutgoingEmail): Promise<{ messageIdHeader: string; raw: Buffer }> {
  const domain = e.mailbox.email.split("@")[1] ?? "localhost";
  const messageIdHeader = `<${e.messageId}@${domain}>`;
  const headers: Record<string, string> = {};
  if (e.listUnsubscribe || e.oneClickUnsubscribeUrl) {
    const mailto = `<mailto:${e.mailbox.email}?subject=unsubscribe>`;
    headers["List-Unsubscribe"] = e.oneClickUnsubscribeUrl ? `<${e.oneClickUnsubscribeUrl}>, ${mailto}` : mailto;
    if (e.oneClickUnsubscribeUrl) headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  // Plain text only unless tracking needs HTML — plain text lands in the inbox more often.
  const html = e.trackOpens || e.trackClicks
    ? toHtml(e.text, { messageId: e.messageId, trackClicks: e.trackClicks, trackOpens: e.trackOpens, unsubscribeUrl: e.unsubscribeUrl })
    : undefined;

  // Build the MIME once: the exact same bytes are sent and saved to the Sent folder.
  const raw = await buildRaw({
    from: e.mailbox.from_name ? { name: e.mailbox.from_name, address: e.mailbox.email } : e.mailbox.email,
    to: e.to,
    subject: e.subject,
    text: e.text,
    html,
    messageId: messageIdHeader,
    inReplyTo: e.inReplyTo ?? undefined,
    references: e.references ?? e.inReplyTo ?? undefined,
    headers,
  });

  const transport = transportFor(e.mailbox);
  try {
    await transport.sendMail({ envelope: { from: e.mailbox.email, to: [e.to] }, raw });
  } finally {
    transport.close();
  }
  return { messageIdHeader, raw };
}

function buildRaw(opts: ConstructorParameters<typeof MailComposer>[0]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    new MailComposer(opts).compile().build((err, msg) => (err ? reject(err) : resolve(msg)));
  });
}

/**
 * Saves a sent message into the mailbox's Sent folder over IMAP, so the conversation shows up
 * complete in webmail / Outlook / Gmail. Best effort: failures never affect sending.
 */
export async function appendToSent(mb: Pick<Mailbox, "id" | "imap_host" | "imap_port" | "username" | "password_enc" | "sent_folder" | "save_to_sent">, raw: Buffer): Promise<void> {
  if (!mb.imap_host || !mb.save_to_sent) return;
  const client = imapClient(mb);
  const timer = setTimeout(() => client.close(), 30_000);
  try {
    await client.connect();
    let folder = mb.sent_folder;
    if (!folder) {
      const boxes = await client.list();
      folder = boxes.find((b) => b.specialUse === "\\Sent")?.path
        ?? boxes.find((b) => /^(inbox[./])?(sent|sent items|sent messages|sent mail)$/i.test(b.path))?.path
        ?? null;
      if (!folder) return;
      await db().from("mailboxes").update({ sent_folder: folder }).eq("id", mb.id);
    }
    await client.append(folder, raw, ["\\Seen"]);
  } catch {
    // ignore — the email itself was delivered
  } finally {
    clearTimeout(timer);
    await client.logout().catch(() => {});
  }
}

export type SendFailure =
  | "recipient"  // hard bounce: the address doesn't exist → suppress the lead
  | "rejected"   // the recipient's server refused us for policy/blocklist reasons → the lead's problem, retry a few times
  | "transient"  // 4xx for this recipient (greylisting, full mailbox) → retry the lead later
  | "throttle"   // our provider is rate-limiting us → back the mailbox off briefly
  | "mailbox"    // auth / quota / sender rejected → the mailbox's problem
  | "connection";// network, DNS, TLS, timeout, local config

/**
 * Decides what an SMTP error means. Recipient-stage (RCPT TO) errors are about that one
 * address; sender-stage errors (AUTH, MAIL FROM, connection 421, quota) are about the mailbox.
 */
export function classifySendError(err: unknown): SendFailure {
  const e = err as { code?: string; responseCode?: number; command?: string; response?: string; message?: string };
  if (e.code === "EAUTH") return "mailbox";
  const text = `${e.response ?? ""} ${e.message ?? ""}`;
  const enhanced = text.match(/\b([245])\.(\d{1,3})\.(\d{1,3})\b/);
  const cls = enhanced ? `${enhanced[2]}.${enhanced[3]}` : "";
  const code = e.responseCode ?? 0;
  const command = (e.command ?? "").toUpperCase();
  const atRcpt = command.startsWith("RCPT");
  const senderQuota = /quota|daily (sending )?limit|sending limit|too many (messages|emails|recipients)|rate limit|suspend|account (is )?(disabled|locked)|not allowed to send|sender (address )?rejected|relay(ing)? (access )?denied/i;

  if (code >= 500 && code < 600) {
    if (atRcpt) {
      const noSuchUser = /no such user|user unknown|does not exist|unknown (user|recipient)|recipient (address )?rejected|mailbox (unavailable|not found)|invalid (recipient|mailbox|address)|address rejected|disabled|inactive|no mailbox/i;
      if (senderQuota.test(text)) return "mailbox";
      if (cls.startsWith("1.") || cls === "2.1" || cls === "2.2" || (!cls.startsWith("7.") && noSuchUser.test(text))) return "recipient";
      return "rejected"; // 5.7.x policy, blocklists, reputation — specific to that destination
    }
    return "mailbox"; // MAIL FROM / DATA / AUTH stage
  }
  if (code >= 400 && code < 500) {
    if (atRcpt && !senderQuota.test(text)) return "transient";
    return "throttle"; // 421 at connect/MAIL FROM, "too many messages", rate limits
  }
  return "connection";
}
