// The background engine. It starts with the app (src/instrumentation.ts) or on its own machine
// (`npm run worker`); both run these same four loops:
//   send        every 20s: checks inboxes for replies/bounces, then sends due emails
//   prepare     continuous: researches companies and writes AI emails ahead of time
//   verify      checks new leads' email addresses in the background (25 per pass)
//   capability  every 30 min: can this network reach mail servers on port 25?
// Each loop catches its own errors, so one failure never stops the others. It only logs when
// something happened, so `next dev` output stays quiet.
import { refreshSmtpCapability } from "./email-verify";
import { heartbeat, tick } from "./engine";
import { env } from "./env";
import { groqLimits } from "./groq";
import { prepareBatch } from "./prepare";
import { verifyPending } from "./verify-queue";

const SEND_EVERY_MS = 20_000;
const PREP_IDLE_MS = 30_000;
const VERIFY_BUSY_MS = 5_000;
const VERIFY_IDLE_MS = 60_000;
const VERIFY_BATCH = 25;
const CAPABILITY_EVERY_MS = 30 * 60_000;
const REPEAT_ERROR_MS = 10 * 60_000; // the same error is logged at most this often

type Engine = { stopping: boolean; wake: Set<() => void>; done: Promise<void> };
// One engine per process: dev hot reloads re-run modules, but globalThis survives them.
const g = globalThis as { __grevyaEngine?: Engine };

/** Waits `ms`, or less if the engine is stopping. */
function sleep(e: Engine, ms: number): Promise<void> {
  if (e.stopping) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); e.wake.delete(done); resolve(); };
    const timer = setTimeout(done, ms);
    e.wake.add(done);
  });
}

/** Starts the engine's loops in the background. Calling it again while it runs does nothing. */
export function startEngine(opts: { log?: (msg: string) => void } = {}): void {
  if (g.__grevyaEngine && !g.__grevyaEngine.stopping) return;
  const e: Engine = { stopping: false, wake: new Set(), done: Promise.resolve() };
  g.__grevyaEngine = e;

  const say = (msg: string) => opts.log?.(`[engine] ${msg}`);
  const lastLogged = new Map<string, number>();
  const warn = (msg: string) => {
    const at = lastLogged.get(msg);
    if (at && Date.now() - at < REPEAT_ERROR_MS) return;
    lastLogged.set(msg, Date.now());
    say(msg);
  };
  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

  /** Runs `body` until stopped; `body` returns how long to wait before the next pass. */
  const loop = async (name: string, firstDelay: number, onError: number, body: () => Promise<number>) => {
    await sleep(e, firstDelay);
    while (!e.stopping) {
      let wait = onError;
      try {
        wait = await body();
      } catch (err) {
        warn(`${name} failed: ${message(err)}`);
      }
      await sleep(e, wait);
    }
  };

  let paused: boolean | null = null;
  const send = loop("sending", 2_000, SEND_EVERY_MS, async () => {
    const started = Date.now();
    const r = await tick();
    const nowPaused = r.skipped["all"] === "paused by you";
    if (paused !== null && nowPaused !== paused) say(nowPaused ? "sending paused" : "sending resumed");
    paused = nowPaused;
    if (r.sent || r.synced) say(`sent ${r.sent}, new in inbox ${r.synced}`);
    for (const err of r.errors) warn(err);
    return Math.max(1000, SEND_EVERY_MS - (Date.now() - started));
  });

  const prepare = loop("AI writing", 4_000, PREP_IDLE_MS, async () => {
    const r = await prepareBatch(60_000);
    if (r.prepared || r.skipped || r.failed) say(`AI wrote ${r.prepared}, skipped ${r.skipped} (low fit), couldn't write ${r.failed}`);
    await heartbeat({ last_prepare: new Date().toISOString(), prep_rate_limited_for: r.rateLimitedFor, groq: groqLimits() });
    if (r.rateLimitedFor) {
      warn("AI usage limit reached — AI writing waits until it resets");
      return Math.min(r.rateLimitedFor, 600) * 1000;
    }
    return r.prepared || r.skipped || r.failed ? 0 : PREP_IDLE_MS;
  });

  const verify = loop("email checks", 10_000, VERIFY_IDLE_MS, async () => {
    const r = await verifyPending(VERIFY_BATCH);
    if (r.error) warn(`email checks: ${r.error}`);
    if (r.checked) say(`checked ${r.checked} new email address${r.checked === 1 ? "" : "es"}`);
    await heartbeat({ last_verify: new Date().toISOString() });
    return r.checked ? VERIFY_BUSY_MS : VERIFY_IDLE_MS;
  });

  let port25: boolean | null = null;
  const capability = loop("port 25 check", 1_000, CAPABILITY_EVERY_MS, async () => {
    const ok = await refreshSmtpCapability();
    if (port25 !== null && ok !== port25) {
      say(ok ? "port 25 is open again: email checks ask mail servers directly" : "port 25 is now blocked on this network: email checks can't ask mail servers");
    }
    port25 = ok;
    return CAPABILITY_EVERY_MS;
  });

  e.done = Promise.all([send, prepare, verify, capability]).then(() => {});
  say(`started (links in emails point to ${appUrlNote()})`);
}

/** Stops the loops after their current work. Resolves once they have all finished. */
export async function stopEngine(): Promise<void> {
  const e = g.__grevyaEngine;
  if (!e) return;
  e.stopping = true;
  for (const wake of [...e.wake]) wake();
  await e.done;
  if (g.__grevyaEngine === e) g.__grevyaEngine = undefined;
}

/** APP_URL, with a warning when it points at a different local port than this server. */
function appUrlNote(): string {
  const url = env.appUrl;
  const port = process.env.PORT;
  try {
    const u = new URL(url);
    const local = ["localhost", "127.0.0.1", "0.0.0.0"].includes(u.hostname);
    const urlPort = u.port || (u.protocol === "https:" ? "443" : "80");
    if (local && port && urlPort !== port) return `${url} — but this app runs on port ${port}; set APP_URL in .env.local`;
  } catch { /* not a URL: shown as is */ }
  return url;
}
