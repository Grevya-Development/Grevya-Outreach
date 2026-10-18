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
