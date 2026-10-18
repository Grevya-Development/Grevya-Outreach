"use server";

import { resolveMx } from "node:dns/promises";
import { refresh } from "next/cache";
import type { ActionResult } from "@/components/client";
import { encrypt } from "@/lib/crypto";
import { checkDomain, type HealthCheck } from "@/lib/domain-health";
import { imapClient } from "@/lib/imap";
import { transportFor } from "@/lib/mailer";
import { explainError, providerFromMx, type CheckResult, type ProviderKey } from "@/lib/providers";
import { MAILBOX_HARD_CAP } from "@/lib/schedule";
import { db, must } from "@/lib/supabase";
import type { Mailbox } from "@/lib/types";
import { requireAuth } from "./auth";

export interface MailboxInput {
  id?: string;
  email: string;
  from_name: string;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  imap_host: string;
  imap_port: number;
  username: string;
  password?: string; // blank on edit = keep existing
  daily_limit: number;
  warmup_enabled: boolean;
  warmup_start: number;
  warmup_increment: number;
  min_delay_sec: number;
  max_delay_sec: number;
  timezone: string;
  window_start: number;
  window_end: number;
  send_days: number[];
  signature: string;
  save_to_sent?: boolean;
}

function clean(input: MailboxInput) {
  const daily = Math.min(MAILBOX_HARD_CAP, Math.max(1, Math.round(input.daily_limit)));
  return {
    email: input.email.trim().toLowerCase(),
    from_name: input.from_name.trim(),
    smtp_host: input.smtp_host.trim(),
    smtp_port: Number(input.smtp_port),
    smtp_secure: input.smtp_secure,
    imap_host: input.imap_host.trim() || null,
    imap_port: Number(input.imap_port) || 993,
    username: (input.username || input.email).trim(),
    daily_limit: daily,
    warmup_enabled: input.warmup_enabled,
    warmup_start: Math.min(daily, Math.max(1, Math.round(input.warmup_start))),
    warmup_increment: Math.max(0, Math.min(100, Math.round(input.warmup_increment))),
    min_delay_sec: Math.max(10, Math.round(input.min_delay_sec)),
    max_delay_sec: Math.max(Math.max(10, Math.round(input.min_delay_sec)), Math.round(input.max_delay_sec)),
    timezone: input.timezone,
    window_start: input.window_start,
    window_end: Math.max(input.window_start + 1, input.window_end),
    send_days: input.send_days.length ? input.send_days : [1, 2, 3, 4, 5],
    signature: input.signature,
    save_to_sent: input.save_to_sent ?? true,
  };
}

export async function saveMailbox(input: MailboxInput): Promise<ActionResult> {
  await requireAuth();
  const row = clean(input);
  const supa = db();
  if (input.id) {
    const patch: Record<string, unknown> = { ...row };
    // A different IMAP server/login means old message UIDs are meaningless: resync.
    const prev = must(await supa.from("mailboxes").select("imap_host, username").eq("id", input.id).single()) as { imap_host: string | null; username: string };
    if (prev.imap_host !== row.imap_host || prev.username !== row.username) {
      patch.imap_last_uid = null;
      patch.imap_uidvalidity = null;
      patch.sent_folder = null;
      await supa.from("replies").update({ imap_uid: null }).eq("mailbox_id", input.id); // free old UIDs
    }
    if (input.password) {
      patch.password_enc = encrypt(input.password);
      patch.status = "active";
      patch.last_error = null;
    }
    const { error } = await supa.from("mailboxes").update(patch).eq("id", input.id);
    if (error) return { ok: false, error: error.message };
  } else {
    if (!input.password) return { ok: false, error: "Password is required" };
    const { error } = await supa.from("mailboxes").insert({ ...row, password_enc: encrypt(input.password) });
    if (error) return { ok: false, error: error.message.includes("duplicate") ? "This mailbox already exists" : error.message };
  }
  refresh();
  return { ok: true, message: "Mailbox saved" };
}

export interface ConnectionTest {
  smtp: CheckResult;
  imap: CheckResult | null; // null when no IMAP server is configured
}

/** Logs in to SMTP and IMAP without sending anything, and explains any failure. */
export async function testMailbox(input: MailboxInput, providerLabel?: string): Promise<ConnectionTest> {
  await requireAuth();
  let password_enc: string;
  if (input.password) password_enc = encrypt(input.password);
  else if (input.id) password_enc = (must(await db().from("mailboxes").select("password_enc").eq("id", input.id).single()) as { password_enc: string }).password_enc;
  else return { smtp: { ok: false, message: "Enter the mailbox password first." }, imap: null };
  if (!input.email.includes("@")) return { smtp: { ok: false, message: "Enter the email address first." }, imap: null };

  const row = { ...clean(input), password_enc };
  const smtpCheck = async (): Promise<CheckResult> => {
    if (!row.smtp_host) return explainError(new Error("no host"), "smtp", "", row.smtp_port, providerLabel);
    const t = transportFor(row);
    try {
      await t.verify();
      return { ok: true, message: `Can send email through ${row.smtp_host}` };
    } catch (err) {
      return explainError(err, "smtp", row.smtp_host, row.smtp_port, providerLabel);
    } finally {
      t.close();
    }
  };
  const imapCheck = async (): Promise<CheckResult | null> => {
    if (!row.imap_host) return null;
    const c = imapClient(row);
    c.on("error", () => {}); // errors surface through connect()
    try {
      await c.connect();
      await c.logout();
      return { ok: true, message: "Can read the inbox to detect replies and bounces" };
    } catch (err) {
      return explainError(err, "imap", row.imap_host, row.imap_port, providerLabel);
    }
  };
  const [smtp, imap] = await Promise.all([smtpCheck(), imapCheck()]);
  return { smtp, imap };
}

/** Guesses the mail provider from the domain's MX records (e.g. grevya.com → GoDaddy). */
export async function detectProvider(email: string): Promise<ProviderKey | null> {
  await requireAuth();
  const domain = email.split("@")[1]?.trim().toLowerCase();
  if (!domain || !domain.includes(".")) return null;
  try {
    const mx = await resolveMx(domain);
    return providerFromMx(mx.map((m) => m.exchange));
  } catch {
    return null;
  }
}

export async function sendTestEmail(id: string, to: string): Promise<ActionResult> {
  await requireAuth();
  const mb = must(await db().from("mailboxes").select("*").eq("id", id).single()) as Mailbox;
  try {
    const t = transportFor(mb);
    await t.sendMail({
      from: mb.from_name ? { name: mb.from_name, address: mb.email } : mb.email,
      to,
      subject: "Test from Grevya Outreach",
      text: `This is a test email sent through ${mb.smtp_host}.\n\nIf it landed in spam, check SPF/DKIM/DMARC for ${mb.email.split("@")[1]}.\n\n${mb.signature}`,
    });
    t.close();
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return { ok: true, message: `Test sent to ${to}` };
}

export async function setMailboxStatus(id: string, status: "active" | "paused"): Promise<ActionResult> {
  await requireAuth();
  must(await db().from("mailboxes").update({ status, last_error: status === "active" ? null : undefined }).eq("id", id));
  refresh();
  return { ok: true, message: status === "active" ? "Mailbox resumed" : "Mailbox paused" };
}

export async function restartWarmup(id: string): Promise<ActionResult> {
  await requireAuth();
  must(await db().from("mailboxes").update({ warmup_started_at: new Date().toISOString().slice(0, 10) }).eq("id", id));
  refresh();
  return { ok: true, message: "Warm-up restarted from day 1" };
}

export async function deleteMailbox(id: string): Promise<ActionResult> {
  await requireAuth();
  // Follow-ups in flight from this mailbox can't continue its thread from another address:
  // they'll go out from another mailbox as fresh emails (no "Re:", no In-Reply-To).
  must(await db().from("campaign_leads").update({ last_message_id: null, mailbox_id: null, locked_until: null })
    .eq("mailbox_id", id).in("status", ["queued", "in_progress"]));
  must(await db().from("mailboxes").delete().eq("id", id));
  refresh();
  return { ok: true, message: "Mailbox removed" };
}

/** SPF / DKIM / DMARC / MX check for a mailbox's domain. */
export async function checkMailboxDomain(email: string, smtpHost: string, selector?: string): Promise<HealthCheck[]> {
  await requireAuth();
  const domain = email.split("@")[1];
  if (!domain) return [];
  return checkDomain(domain, smtpHost, selector?.trim() || undefined);
}
