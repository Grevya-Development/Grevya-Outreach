// The sending engine. `tick()` sends at most one email per available mailbox.
// Safety properties:
//  - A mailbox's send slot is reserved atomically in Postgres (pacing + daily cap can't race).
//  - Each (lead, step) gets one messages row *before* SMTP; a unique index means a crash or a
//    second engine can never send the same step twice.
//  - Pacing spreads the daily quota over the sending window with jitter.
//  - Mailboxes auto-pause when bounces spike; leads at the same company and leads contacted by
//    another campaign recently are deferred.
import { randomUUID } from "node:crypto";
import { isSendingPaused } from "./app-state";
import { composeEmail, NotPreparedError } from "./compose";
import { generateLine, groqLimits, RateLimitError } from "./groq";
import { syncMailbox } from "./imap";
import { checkBounceRate } from "./bounces";
import { missingMigrations } from "./schema";
import { appendToSent, classifySendError, sendEmail } from "./mailer";
import { prepareBatch, type PrepResult } from "./prepare";
import { getProfile } from "./profile";
import { FREE_MAIL } from "./research";
import { env } from "./env";
import { effectiveDailyLimit, inSendingWindow, isPublicUrl, nextGapSeconds, randomBetween, secondsLeftInWindow } from "./schedule";
import { db, must } from "./supabase";
import { usesVariable } from "./template";
import type { Campaign, CampaignLead, CampaignStep, Lead, Mailbox } from "./types";
import { verifyEmail } from "./verify";

const IMAP_SYNC_EVERY_MS = 5 * 60_000;
const RECONTACT_DAYS = 7;      // don't start a new sequence with someone emailed this recently
const SAME_COMPANY_HOURS = 24; // one first-touch per company domain per day
const consecutiveFailures = new Map<string, number>();

export interface TickResult {
  sent: number;
  skipped: Record<string, string>;
  errors: string[];
  synced: number;
  prep?: PrepResult;
}

type CampaignBundle = { campaign: Campaign; steps: CampaignStep[] };

export async function tick(opts: { syncInbox?: boolean; prepareMs?: number } = {}): Promise<TickResult> {
  const result: TickResult = { sent: 0, skipped: {}, errors: [], synced: 0 };
  const supa = db();

  const missing = await missingMigrations();
  if (missing.length) {
    result.errors.push(`Database needs updating — run ${missing.join(", ")} in the Supabase SQL editor. Nothing is sent until then.`);
    await heartbeat({ last_tick: new Date().toISOString(), errors: result.errors });
    return result;
  }

  const allMailboxes = must(await supa.from("mailboxes").select("*")) as Mailbox[];
  const mailboxes = allMailboxes.filter((m) => m.status === "active");
  const counts = new Map(
    (must(await supa.rpc("mailbox_sent_today")) as { mailbox_id: string; sent: number }[]).map((r) => [r.mailbox_id, Number(r.sent)]),
  );
  const now = new Date();
  const cache = new Map<string, CampaignBundle>();
  const address = (await getProfile()).address.trim();

  // Check inboxes *before* sending so a fresh reply stops its follow-up. Paused/errored
  // mailboxes are still synced — replies to emails they already sent still matter.
  if (opts.syncInbox !== false) {
    for (const mb of allMailboxes) {
      if (!mb.imap_host || mb.status === "error") continue; // known-bad password: don't hammer the login
      if (mb.imap_synced_at && now.getTime() - new Date(mb.imap_synced_at).getTime() < IMAP_SYNC_EVERY_MS) continue;
      try {
        result.synced += await syncMailbox(mb);
        mb.imap_synced_at = new Date().toISOString();
      } catch (err) {
        result.errors.push(`${mb.email} inbox sync: ${(err as Error).message}`);
        await supa.from("mailboxes").update({ imap_synced_at: new Date().toISOString() }).eq("id", mb.id);
      }
    }
  }

  // Paused by the user (the switch in the sidebar): replies are still picked up above and AI
  // writing carries on, but nothing is sent.
  if (await isSendingPaused()) {
    if (opts.prepareMs) result.prep = await prepareBatch(opts.prepareMs);
    result.skipped["all"] = "paused by you";
    await heartbeat({
      last_tick: new Date().toISOString(), paused: true, sent: 0, errors: result.errors.slice(0, 5), skipped: result.skipped,
      ...(result.prep ? { last_prepare: new Date().toISOString(), prep_rate_limited_for: result.prep.rateLimitedFor } : {}),
    });
    return result;
  }

  await Promise.all(
    mailboxes.map(async (mb) => {
      try {
        if (new Date(mb.next_available_at) > now) return void (result.skipped[mb.email] = "pacing delay");
        if (!inSendingWindow(mb, now)) return void (result.skipped[mb.email] = "outside sending window");
        const limit = effectiveDailyLimit(mb, now);
        const sent = counts.get(mb.id) ?? 0;
        if (sent >= limit) return void (result.skipped[mb.email] = `daily limit reached (${limit})`);

        const gap = nextGapSeconds(limit - sent - 1, secondsLeftInWindow(mb, now), mb.min_delay_sec);
        const slot = must(await supa.rpc("reserve_mailbox_slot", { p_mailbox: mb.id, p_limit: limit, p_gap_sec: gap })) as string | null;
        if (!slot) return void (result.skipped[mb.email] = "slot taken / cap reached");

        const claimed = must(await supa.rpc("claim_next_lead", { p_mailbox: mb.id })) as CampaignLead[];
        const cl = claimed[0];
        if (!cl) {
          await releaseSlot(mb.id, slot);
          return void (result.skipped[mb.email] = "nothing due");
        }
        const outcome = await processLead(mb, cl, cache, address);
        if (outcome === "sent") result.sent++;
        else if (outcome === "bounced") result.skipped[mb.email] = "recipient bounced";
        else {
          await releaseSlot(mb.id, slot); // didn't use the slot — let the next lead have it
          result.skipped[mb.email] = outcome;
        }
      } catch (err) {
        result.errors.push(`${mb.email}: ${(err as Error).message}`);
      }
    }),
  );

  if (opts.prepareMs) result.prep = await prepareBatch(opts.prepareMs);

  await completeFinishedCampaigns();
  const groq = groqLimits();
  await heartbeat({
    last_tick: new Date().toISOString(), paused: false, sent: result.sent, errors: result.errors.slice(0, 5), skipped: result.skipped,
    ...(Object.keys(groq).length ? { groq } : {}),
    ...(result.prep ? { last_prepare: new Date().toISOString(), prep_rate_limited_for: result.prep.rateLimitedFor } : {}),
  });
  return result;
}

// The send, prepare and verify loops all write the same row (read, merge, write). Running those
// one after another stops one loop from overwriting another's fields with stale values.
let beat: Promise<unknown> = Promise.resolve();

export function heartbeat(value: Record<string, unknown>): Promise<void> {
  const write = beat.then(async () => {
    const supa = db();
    const { data } = await supa.from("app_state").select("value").eq("key", "engine").maybeSingle();
    await supa.from("app_state").upsert({ key: "engine", value: { ...(data?.value ?? {}), ...value }, updated_at: new Date().toISOString() });
  });
  beat = write.catch(() => {});
  return write;
}

/** Gives back an unused slot — only if no other engine has reserved a newer one since. */
function releaseSlot(mailboxId: string, slot: string) {
  return db().from("mailboxes").update({ next_available_at: new Date().toISOString() }).eq("id", mailboxId).eq("next_available_at", slot);
}

/** Retries a DB write a few times (Supabase hiccups must not turn a sent email into a re-send). */
async function persist(fn: () => Promise<unknown>) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= 3) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
}

async function loadCampaign(id: string, cache: Map<string, CampaignBundle>): Promise<CampaignBundle> {
  let hit = cache.get(id);
  if (!hit) {
    const supa = db();
    const [campaign, steps] = await Promise.all([
      supa.from("campaigns").select("*").eq("id", id).single().then(must),
      supa.from("campaign_steps").select("*").eq("campaign_id", id).order("step_number").then(must),
    ]);
    hit = { campaign: campaign as Campaign, steps: steps as CampaignStep[] };
    cache.set(id, hit);
  }
  return hit;
}

function release(clId: string, patch: Partial<CampaignLead>) {
  return db().from("campaign_leads").update({ ...patch, locked_until: null }).eq("id", clId);
}

const later = (ms: number) => new Date(Date.now() + ms).toISOString();

/** Returns "sent", or a short reason why nothing was sent. */
async function processLead(mb: Mailbox, cl: CampaignLead, cache: Map<string, CampaignBundle>, address: string): Promise<string> {
  const supa = db();
  const { campaign, steps } = await loadCampaign(cl.campaign_id, cache);
  const lead = must(await supa.from("leads").select("*").eq("id", cl.lead_id).single()) as Lead;
  const unpin = cl.current_step === 0 ? { mailbox_id: null } : {};

  // Lead may have unsubscribed / bounced since being enrolled.
  const { data: suppressed } = await supa.from("suppressions").select("email").eq("email", lead.email).maybeSingle();
  if (lead.status !== "active" || suppressed) {
    await release(cl.id, lead.status === "bounced" ? { status: "bounced" } : lead.status === "invalid"
      ? { status: "skipped", skip_reason: "Invalid email address" } : { status: "unsubscribed" });
    return "lead blocked";
  }

  const step = steps[cl.current_step];
  if (!step) {
    await release(cl.id, { status: "completed" });
    return "sequence finished";
  }

  // Follow-up: re-check this mailbox's inbox if it hasn't been read in the last 2 minutes,
  // then re-read the lead — a reply that just arrived must stop the follow-up.
  if (cl.current_step > 0 && mb.imap_host && (!mb.imap_synced_at || Date.now() - new Date(mb.imap_synced_at).getTime() > 120_000)) {
    try {
      await syncMailbox(mb);
      mb.imap_synced_at = new Date().toISOString();
    } catch { /* sync errors are reported by the tick-level sync */ }
    const fresh = must(await supa.from("campaign_leads").select("status").eq("id", cl.id).single()) as { status: string };
    if (!["queued", "in_progress"].includes(fresh.status)) {
      await release(cl.id, {});
      return "lead replied — follow-up cancelled";
    }
  }

  // Crash recovery: a messages row for this step means it was already (probably) sent.
  const { data: existing } = await supa.from("messages").select("id, status, message_id, subject")
    .eq("campaign_lead_id", cl.id).eq("step_number", step.step_number).neq("status", "failed").maybeSingle();
  if (existing) {
    if (existing.status === "sending") await supa.from("messages").update({ status: "sent" }).eq("id", existing.id);
    await advance(cl, steps, existing.message_id, existing.subject);
    return "step already sent (recovered)";
  }

  if (cl.current_step === 0) {
    // Free, last-moment address check (syntax + MX) for never-verified leads.
    if (!lead.verify_status) {
      const v = await verifyEmail(lead.email);
      await supa.from("leads").update({ verify_status: v, ...(v === "invalid" ? { status: "invalid" } : {}) }).eq("id", lead.id);
      if (v === "invalid") {
        await release(cl.id, { status: "skipped", skip_reason: "Invalid email address (no mail server)", ...unpin });
        return "invalid address";
      }
    }
    // Recently contacted by another campaign? Wait.
    const { data: recent } = await supa.from("messages").select("sent_at").eq("lead_id", lead.id).neq("status", "failed")
      .gte("sent_at", later(-RECONTACT_DAYS * 86_400_000)).order("sent_at", { ascending: false }).limit(1);
    if (recent?.length) {
      await release(cl.id, { next_send_at: new Date(new Date(recent[0].sent_at).getTime() + RECONTACT_DAYS * 86_400_000).toISOString(), ...unpin });
      return "contacted recently by another campaign";
    }
    // One new conversation per company per day.
    const domain = lead.email.split("@")[1]?.toLowerCase();
    if (domain && !FREE_MAIL.has(domain)) {
      const { data: colleague } = await supa.from("messages").select("id").eq("to_domain", domain).neq("lead_id", lead.id)
        .neq("status", "failed").gte("sent_at", later(-SAME_COMPANY_HOURS * 3_600_000)).limit(1);
      if (colleague?.length) {
        await release(cl.id, { next_send_at: later(SAME_COMPANY_HOURS * 3_600_000 + randomBetween(0, 7200) * 1000), ...unpin });
        return "colleague at same company emailed today";
      }
    }
  }

  // Per-campaign daily cap.
  const sentToday = Number(must(await supa.rpc("campaign_sent_today", { p_campaign: campaign.id, p_tz: mb.timezone })));
  if (sentToday >= campaign.daily_limit) {
    await release(cl.id, { next_send_at: later(30 * 60_000), ...unpin });
    return "campaign daily limit reached";
  }

  // Template mode: Groq-written {{ai_line}}, generated once and reused for follow-ups.
  if (campaign.mode === "template" && campaign.ai_enabled && !cl.personalization?.ai_line &&
      steps.some((s) => usesVariable(s.body, "ai_line") || usesVariable(s.subject, "ai_line"))) {
    try {
      const { profileText } = await import("./research");
      const ai_line = await generateLine({ lead, instructions: campaign.ai_prompt, senderContext: campaign.sender_context || profileText(await getProfile()) });
      if (!ai_line.trim()) throw new Error("AI returned an empty line");
      cl.personalization = { ...(cl.personalization ?? {}), ai_line, generated_at: new Date().toISOString() };
      must(await supa.from("campaign_leads").update({ personalization: cl.personalization }).eq("id", cl.id));
    } catch (err) {
      const rate = err instanceof RateLimitError;
      const attempts = rate ? cl.attempts : cl.attempts + 1;
      await release(cl.id, {
        next_send_at: later((rate ? (err as RateLimitError).retryAfterSec : 300 * attempts) * 1000),
        last_error: `AI line: ${(err as Error).message}`.slice(0, 300),
        attempts,
        status: attempts >= 5 ? "failed" : cl.status,
        ...unpin,
      });
      if (!rate) throw new Error(`AI line failed for ${lead.email}: ${(err as Error).message}`);
      return "AI rate-limited";
    }
  }

  let composed;
  try {
    composed = composeEmail({ campaign, steps, stepIndex: cl.current_step, cl, lead, mailbox: mb, address });
  } catch (err) {
    if (err instanceof NotPreparedError) {
      await supa.from("campaign_leads").update({ prep_status: "pending", locked_until: null, ...unpin }).eq("id", cl.id);
      return "AI email missing — re-queued for writing";
    }
    throw err;
  }

  // Reserve the (lead, step) before SMTP. If another engine got here first, stop.
  const messageId = randomUUID();
  const { error: dup } = await supa.from("messages").insert({
    id: messageId, campaign_lead_id: cl.id, campaign_id: campaign.id, lead_id: lead.id, mailbox_id: mb.id,
    step_number: step.step_number, to_email: lead.email, from_email: mb.email, subject: composed.subject, body: composed.text, status: "sending",
  });
  if (dup) {
    await release(cl.id, {});
    return dup.code === "23505" ? "already being sent elsewhere" : `db error: ${dup.message}`;
  }

  let sent: { messageIdHeader: string; raw: Buffer };
  try {
    sent = await sendEmail({
      mailbox: mb,
      to: lead.email,
      subject: composed.subject,
      text: composed.text,
      messageId,
      inReplyTo: cl.current_step > 0 ? cl.last_message_id : null,
      // Tracking links/pixels must point at a public URL, or they're just broken images/links.
      trackOpens: campaign.track_opens && isPublicUrl(env.appUrl),
      trackClicks: campaign.track_clicks && isPublicUrl(env.appUrl),
      listUnsubscribe: campaign.include_unsubscribe,
      unsubscribeUrl: composed.unsubscribeUrl ?? undefined,
      oneClickUnsubscribeUrl: composed.oneClickUnsubscribeUrl ?? undefined,
    });
  } catch (err) {
    return handleSendError(err, { mb, cl, lead, campaign, messageId, unpin });
  }

  // The email is out. From here on, a DB failure must never mark it failed (that would re-send):
  // retry, and if it still fails leave the row as 'sending' — recovery treats that as sent.
  await persist(async () => must(await supa.from("messages").update({ status: "sent", message_id: sent.messageIdHeader, sent_at: new Date().toISOString() }).eq("id", messageId)));
  await persist(() => advance(cl, steps, sent.messageIdHeader, composed.subject));
  await Promise.all([
    supa.from("mailboxes").update({ last_error: null }).eq("id", mb.id),
    supa.from("events").insert({ type: "sent", message_id: messageId, campaign_id: campaign.id, lead_id: lead.id, mailbox_id: mb.id }),
  ]);
  consecutiveFailures.delete(mb.id);
  // Copy to the Sent folder so the thread is visible in the user's own mail app. Gmail and
  // Microsoft 365 already do this for SMTP mail, so skip them to avoid duplicates.
  if (!/gmail|google|office365|outlook/i.test(mb.smtp_host)) await appendToSent(mb, sent.raw);
  return "sent";
}

async function handleSendError(err: unknown, ctx: { mb: Mailbox; cl: CampaignLead; lead: Lead; campaign: Campaign; messageId: string; unpin: { mailbox_id?: null } }): Promise<string> {
  const { mb, cl, lead, campaign, messageId, unpin } = ctx;
  const supa = db();
  const msg = (err as Error).message.slice(0, 500);
  const kind = classifySendError(err);

  if (kind === "recipient") {
    await Promise.all([
      supa.from("messages").update({ status: "bounced", error: msg }).eq("id", messageId),
      release(cl.id, { status: "bounced", last_error: msg }),
      supa.from("leads").update({ status: "bounced" }).eq("id", lead.id),
      supa.from("suppressions").upsert({ email: lead.email, reason: "bounce" }),
      supa.from("events").insert({ type: "bounce", message_id: messageId, campaign_id: campaign.id, lead_id: lead.id, mailbox_id: mb.id, meta: { error: msg } }),
    ]);
    await checkBounceRate(mb);
    return "bounced";
  }

  // Free the step so it can be retried (the unique index ignores failed rows).
  await supa.from("messages").update({ status: "failed", error: msg }).eq("id", messageId);
  await supa.from("events").insert({ type: "error", campaign_id: campaign.id, lead_id: lead.id, mailbox_id: mb.id, meta: { error: msg, kind } });

  if (kind === "transient" || kind === "rejected") {
    // About this recipient only: retry the lead a few times, never pause the mailbox for it.
    const attempts = cl.attempts + 1;
    const max = kind === "rejected" ? 3 : 5;
    await release(cl.id, {
      attempts, status: attempts >= max ? "failed" : cl.status, last_error: msg, ...unpin,
      next_send_at: later((kind === "rejected" ? 6 * 3_600_000 : 15 * 60_000) * attempts),
    });
    return kind === "rejected" ? "recipient's server refused (will retry later)" : "recipient asked to retry later";
  }

  // Mailbox / connection / throttling problems aren't the lead's fault: don't burn its retries.
  await release(cl.id, { next_send_at: later(10 * 60_000), last_error: msg, ...unpin });
  const failures = consecutiveFailures.get(mb.id) ?? 0;
  consecutiveFailures.set(mb.id, failures + 1);
  const authFail = (err as { code?: string }).code === "EAUTH";
  const backoffMin = Math.min(240, 5 * 2 ** failures); // 5, 10, 20 … 240 min
  await supa.from("mailboxes").update(
    authFail
      ? { status: "error", last_error: `Login failed — update the password on the Mailboxes page: ${msg}` }
      : kind === "mailbox"
        ? { last_error: `Your provider refused to send (paused 1h): ${msg}`, next_available_at: later(60 * 60_000) }
        : kind === "throttle"
          ? { last_error: `Provider is rate-limiting this mailbox (slowing down 15 min): ${msg}`, next_available_at: later(15 * 60_000) }
          : { last_error: `Can't reach the mail server (retry in ${backoffMin} min): ${msg}`, next_available_at: later(backoffMin * 60_000) },
  ).eq("id", mb.id);
  throw err;
}

/** Moves a lead to its next step (or completes it) after a send. */
async function advance(cl: CampaignLead, steps: CampaignStep[], messageIdHeader: string | null, subject: string) {
  const next = steps[cl.current_step + 1];
  // Status guard: if a reply/unsubscribe was recorded meanwhile, keep that status — but still
  // record that this step went out.
  const { error: guardErr } = await db().from("campaign_leads").update({
    current_step: cl.current_step + 1, last_message_id: messageIdHeader ?? cl.last_message_id,
    last_subject: cl.current_step > 0 ? cl.last_subject : subject, locked_until: null,
  }).eq("id", cl.id).not("status", "in", "(queued,in_progress)");
  if (guardErr) throw new Error(guardErr.message);
  const { error } = await db().from("campaign_leads").update({
    current_step: cl.current_step + 1,
    status: next ? "in_progress" : "completed",
    // Follow-ups go out N days later, jittered by up to 2h so they don't all fire together.
    next_send_at: later((next?.delay_days ?? 0) * 86_400_000 + randomBetween(0, 7200) * 1000),
    last_message_id: messageIdHeader ?? cl.last_message_id,
    last_subject: cl.current_step > 0 ? cl.last_subject : subject,
    attempts: 0,
    last_error: null,
    locked_until: null,
  }).eq("id", cl.id).in("status", ["queued", "in_progress"]);
  if (error) throw new Error(error.message);
}

async function completeFinishedCampaigns() {
  const supa = db();
  const active = must(await supa.from("campaigns").select("id").eq("status", "active")) as { id: string }[];
  for (const c of active) {
    // Done when it has leads and none of them is still waiting to send (two one-row reads).
    const { data: remaining, error } = await supa.from("campaign_leads").select("status")
      .eq("campaign_id", c.id).in("status", ["queued", "in_progress"]).limit(1);
    if (error || remaining.length) continue;
    const { data: enrolled } = await supa.from("campaign_leads").select("id").eq("campaign_id", c.id).limit(1);
    if (enrolled?.length) await supa.from("campaigns").update({ status: "completed" }).eq("id", c.id);
  }
}
