// Server-only readers for the engine/sending state kept in `app_state`. Never import this from a
// client component (it uses the service-role database client).
import { db } from "./supabase";

export const SENDING_PAUSED_KEY = "sending_paused";
export const SCHEDULE_KEY = "sending_schedule";
export const VERIFIER_KEY = "verifier";
const ENGINE_KEY = "engine";

/** The engine counts as running when its heartbeat is newer than this. */
const ALIVE_MS = 3 * 60_000;

export type EngineState = {
  lastTick: string | null;
  lastPrepare: string | null;
  /** Heartbeat less than 3 minutes old. */
  alive: boolean;
  /** Sending paused by the user (app_state.sending_paused). */
  paused: boolean;
  pausedAt: string | null;
  prepRateLimitedFor: number;
  /** Whether this network can talk to mail servers on port 25 (null = not checked yet). */
  smtp: { ok: boolean; checkedAt: string } | null;
  lastVerify: string | null;
};

export type SendingSchedule = { timezone: string; window_start: number; window_end: number; send_days: number[] };

export const DEFAULT_SCHEDULE: SendingSchedule = { timezone: "Asia/Kolkata", window_start: 9, window_end: 18, send_days: [1, 2, 3, 4, 5] };

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** Engine heartbeat, pause switch and SMTP capability, read in one query. */
export async function getEngineState(): Promise<EngineState> {
  const { data } = await db().from("app_state").select("key, value").in("key", [ENGINE_KEY, SENDING_PAUSED_KEY, VERIFIER_KEY]);
  const byKey = new Map((data ?? []).map((r) => [r.key as string, (r.value ?? {}) as Json]));
  const engine = byKey.get(ENGINE_KEY) ?? {};
  const pause = byKey.get(SENDING_PAUSED_KEY) ?? {};
  const verifier = byKey.get(VERIFIER_KEY);
  const lastTick = str(engine.last_tick);
  const paused = pause.paused === true;
  return {
    lastTick,
    lastPrepare: str(engine.last_prepare),
    alive: !!lastTick && Date.now() - new Date(lastTick).getTime() < ALIVE_MS,
    paused,
    pausedAt: paused ? str(pause.at) : null,
    prepRateLimitedFor: Number(engine.prep_rate_limited_for) || 0,
    smtp: verifier && typeof verifier.smtp === "boolean" ? { ok: verifier.smtp, checkedAt: str(verifier.checked_at) ?? "" } : null,
    lastVerify: str(engine.last_verify),
  };
}

/** The global sending schedule (Settings → Sending), or the default 9–18 Mon–Fri. */
export async function getSendingSchedule(): Promise<SendingSchedule> {
  const { data } = await db().from("app_state").select("value").eq("key", SCHEDULE_KEY).maybeSingle();
  const v = (data?.value ?? {}) as Partial<SendingSchedule>;
  const hour = (n: unknown, fallback: number) => (Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 24 ? (n as number) : fallback);
  return {
    timezone: typeof v.timezone === "string" && v.timezone ? v.timezone : DEFAULT_SCHEDULE.timezone,
    window_start: hour(v.window_start, DEFAULT_SCHEDULE.window_start),
    window_end: hour(v.window_end, DEFAULT_SCHEDULE.window_end),
    send_days: Array.isArray(v.send_days) && v.send_days.length ? v.send_days.map(Number) : DEFAULT_SCHEDULE.send_days,
  };
}

/** True when the user has paused all sending. */
export async function isSendingPaused(): Promise<boolean> {
  const { data } = await db().from("app_state").select("value").eq("key", SENDING_PAUSED_KEY).maybeSingle();
  return (data?.value as { paused?: unknown } | undefined)?.paused === true;
}
