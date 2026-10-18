// Pure scheduling helpers, safe for both server and client components.
import type { PublicMailbox } from "./types";

export const MAILBOX_HARD_CAP = 400;

/** Today's allowed sends for a mailbox, including the warm-up ramp. */
export function effectiveDailyLimit(mb: Pick<PublicMailbox, "daily_limit" | "warmup_enabled" | "warmup_start" | "warmup_increment" | "warmup_started_at">, now = new Date()): number {
  const cap = Math.min(mb.daily_limit, MAILBOX_HARD_CAP);
  if (!mb.warmup_enabled) return cap;
  const started = new Date(`${mb.warmup_started_at}T00:00:00Z`).getTime();
  const days = Math.max(0, Math.floor((now.getTime() - started) / 86_400_000));
  return Math.min(cap, mb.warmup_start + days * mb.warmup_increment);
}

/** Local hour (0-23) and weekday (0=Sun) in a timezone. */
export function localTime(tz: string, now = new Date()): { hour: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23", weekday: "short" }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  return { hour, day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd) };
}

export function inSendingWindow(mb: Pick<PublicMailbox, "timezone" | "window_start" | "window_end" | "send_days">, now = new Date()): boolean {
  const { hour, day } = localTime(mb.timezone, now);
  return mb.send_days.includes(day) && hour >= mb.window_start && hour < mb.window_end;
}

/** Seconds left in today's sending window (0 if outside it). */
export function secondsLeftInWindow(mb: Pick<PublicMailbox, "timezone" | "window_start" | "window_end" | "send_days">, now = new Date()): number {
  if (!inSendingWindow(mb, now)) return 0;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: mb.timezone, hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const elapsed = get("hour") * 3600 + get("minute") * 60 + get("second");
  return Math.max(0, mb.window_end * 3600 - elapsed);
}

/**
 * Gap before this mailbox's next email: spreads the remaining daily quota evenly over the
 * rest of the sending window, with ±40% jitter, never faster than the minimum gap.
 * (A fixed 60–180s gap can't reach 400/day in a 9-hour window — this can.)
 */
export function nextGapSeconds(remainingQuota: number, secondsLeft: number, minGap: number): number {
  if (remainingQuota <= 0 || secondsLeft <= 0) return Math.max(minGap, 600);
  const even = secondsLeft / remainingQuota;
  const jittered = even * (0.6 + Math.random() * 0.8);
  return Math.round(Math.min(1800, Math.max(minGap, jittered)));
}

/** Max emails a mailbox can physically send per day given its window and minimum gap. */
export function windowCapacity(mb: Pick<PublicMailbox, "window_start" | "window_end" | "min_delay_sec">): number {
  return Math.floor(((mb.window_end - mb.window_start) * 3600) / Math.max(10, mb.min_delay_sec));
}

export function isPublicUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return !/^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/.test(h) && !h.endsWith(".local") && h.includes(".");
  } catch {
    return false;
  }
}

export function randomBetween(min: number, max: number): number {
  return Math.round(min + Math.random() * (max - min));
}

type WindowFields = Pick<PublicMailbox, "timezone" | "window_start" | "window_end" | "send_days">;
type LimitFields = Pick<PublicMailbox, "daily_limit" | "warmup_enabled" | "warmup_start" | "warmup_increment" | "warmup_started_at">;

/** The next moment this mailbox may send: `now` when inside its window, else the start of the next window hour (within 8 days). */
export function nextWindowStart(mb: WindowFields, now = new Date()): Date | null {
  if (inSendingWindow(mb, now)) return now;
  // Step to the next full local hour (timezones like IST are offset by half an hour), then hour by hour.
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: mb.timezone, minute: "numeric", second: "numeric" }).formatToParts(now);
  const min = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const sec = Number(parts.find((p) => p.type === "second")?.value ?? 0);
  let t = now.getTime() - sec * 1000 - now.getMilliseconds() + (60 - min) * 60_000;
  for (let i = 0; i < 8 * 24; i++, t += 3_600_000) {
    if (inSendingWindow(mb, new Date(t))) return new Date(t);
  }
  return null;
}

/** Day of the warm-up (1 = first day) and the date it reaches the account's daily limit; null when warm-up is off or finished. */
export function warmupInfo(mb: LimitFields, now = new Date()): { day: number; fullOn: string } | null {
  if (!mb.warmup_enabled) return null;
  const cap = Math.min(mb.daily_limit, MAILBOX_HARD_CAP);
  if (effectiveDailyLimit(mb, now) >= cap) return null;
  const started = new Date(`${mb.warmup_started_at}T00:00:00Z`).getTime();
  const day = Math.max(0, Math.floor((now.getTime() - started) / 86_400_000)) + 1;
  const daysToCap = mb.warmup_increment > 0 ? Math.ceil((cap - mb.warmup_start) / mb.warmup_increment) : 0;
  return { day, fullOn: new Date(started + daysToCap * 86_400_000).toISOString().slice(0, 10) };
}

/**
 * How many emails a campaign can send per day: the sum of its active accounts' limits today
 * (warm-up included), capped by the campaign daily limit (10000 = no extra limit).
 */
export function effectiveCampaignCapacity(
  mailboxes: (LimitFields & Pick<PublicMailbox, "id" | "email" | "status">)[], campaignLimit: number, now = new Date(),
): { perDay: number; accountsTotal: number; cappedByCampaign: boolean; breakdown: { id: string; email: string; perDay: number; warmupDay: number | null }[] } {
  const breakdown = mailboxes.filter((m) => m.status === "active").map((m) => ({
    id: m.id, email: m.email, perDay: effectiveDailyLimit(m, now), warmupDay: warmupInfo(m, now)?.day ?? null,
  }));
  const accountsTotal = breakdown.reduce((s, m) => s + m.perDay, 0);
  const capped = campaignLimit > 0 && campaignLimit < 10000 && campaignLimit < accountsTotal;
  return { perDay: capped ? campaignLimit : accountsTotal, accountsTotal, cappedByCampaign: capped, breakdown };
}

/** Adds `n` sending days (days in `sendDays`, 0=Sun) to a date; n = 0 returns the first sending day on or after it. */
function addSendDays(from: Date, n: number, sendDays: number[]): Date {
  const days = sendDays.length ? sendDays : [0, 1, 2, 3, 4, 5, 6];
  const d = new Date(from.getTime());
  let left = n;
  for (let guard = 0; guard < 3660; guard++) {
    if (days.includes(d.getUTCDay())) {
      if (left <= 0) return d;
      left--;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}

/** Sending days needed until everyone has had Email 1. */
export function daysForFirstEmails(leadsRemaining: number, perDay: number): number {
  return perDay > 0 ? Math.max(1, Math.ceil(leadsRemaining / perDay)) : 0;
}

/**
 * Rough date the whole sequence finishes: the last lead gets Email 1 once the daily capacity has
 * worked through everyone, then waits the sequence's delays. Never earlier than all emails
 * (leads × steps) divided by the daily capacity. Null when nothing can be sent.
 */
export function estimateFinish(args: { leadsRemaining: number; steps: number[]; perDay: number; startDate: Date; sendDays: number[] }): Date | null {
  const { leadsRemaining, steps, perDay, startDate, sendDays } = args;
  if (perDay <= 0 || !steps.length) return null;
  if (leadsRemaining <= 0) return startDate;
  const firstWave = addSendDays(startDate, daysForFirstEmails(leadsRemaining, perDay) - 1, sendDays);
  const delays = steps.slice(1).reduce((s, d) => s + Math.max(0, d), 0);
  const byDelays = addSendDays(new Date(firstWave.getTime() + delays * 86_400_000), 0, sendDays);
  const byVolume = addSendDays(startDate, Math.max(0, Math.ceil((leadsRemaining * steps.length) / perDay) - 1), sendDays);
  return byDelays > byVolume ? byDelays : byVolume;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TZ_SHORT: Record<string, string> = {
  "Asia/Kolkata": "IST", "Asia/Calcutta": "IST", UTC: "UTC", "Etc/UTC": "UTC", "Europe/London": "UK time",
  "America/New_York": "US Eastern", "America/Chicago": "US Central", "America/Denver": "US Mountain", "America/Los_Angeles": "US Pacific",
  "Asia/Dubai": "Gulf time", "Asia/Singapore": "Singapore time", "Australia/Sydney": "Sydney time", "Europe/Berlin": "Central Europe",
};

/** 'Mon–Fri' / 'Mon, Wed, Fri' / 'Every day'. */
export function describeDays(sendDays: number[]): string {
  const days = [...new Set(sendDays)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
  if (days.length === 7) return "Every day";
  if (!days.length) return "No days";
  // Weeks start on Monday: Sunday counts as day 7.
  const ordered = days[0] === 0 ? [...days.slice(1), 7] : days;
  const runs: number[][] = [];
  for (const d of ordered) {
    const last = runs.at(-1);
    if (last && d === last.at(-1)! + 1) last.push(d);
    else runs.push([d]);
  }
  return runs.map((r) => (r.length >= 3 ? `${DAY_NAMES[r[0] % 7]}–${DAY_NAMES[r.at(-1)! % 7]}` : r.map((d) => DAY_NAMES[d % 7]).join(", "))).join(", ");
}

/** 'Mon–Fri · 09:00–18:00 · IST' */
export function describeWindow(mb: WindowFields): string {
  const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
  return `${describeDays(mb.send_days)} · ${hh(mb.window_start)}–${hh(mb.window_end)} · ${TZ_SHORT[mb.timezone] ?? mb.timezone}`;
}
