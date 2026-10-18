// Long-running engine: `npm run worker`. Keep it running on an always-on machine (a small
// VPS, Railway, Render… or your laptop while it's awake). It runs two loops:
//   send loop     every 20s — sends due emails, checks inboxes for replies/bounces
//   prepare loop  continuous — researches companies and writes AI emails ahead of time
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

const SEND_EVERY_MS = 20_000;
const PREP_IDLE_MS = 30_000;
let stopping = false;
const stop = () => { if (!stopping) console.log("\nStopping after current work…"); stopping = true; };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// Never let one bad socket or promise take the whole engine down.
process.on("unhandledRejection", (e) => console.error(`[${new Date().toLocaleTimeString()}] unhandled rejection:`, e));
process.on("uncaughtException", (e) => console.error(`[${new Date().toLocaleTimeString()}] uncaught exception:`, e));

const { tick, heartbeat } = await import("../src/lib/engine");
const { prepareBatch } = await import("../src/lib/prepare");
const { groqLimits } = await import("../src/lib/groq");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toLocaleTimeString();

async function sendLoop() {
  while (!stopping) {
    const started = Date.now();
    try {
      const r = await tick();
      if (r.sent || r.synced || r.errors.length) {
        console.log(`[${stamp()}] sent ${r.sent}, inbox +${r.synced}${r.errors.length ? `, errors: ${r.errors.join(" | ")}` : ""}`);
      }
    } catch (err) {
      console.error(`[${stamp()}] send tick failed:`, (err as Error).message);
    }
    await sleep(Math.max(1000, SEND_EVERY_MS - (Date.now() - started)));
  }
}

async function prepareLoop() {
  while (!stopping) {
    try {
      const r = await prepareBatch(60_000);
      if (r.prepared || r.skipped || r.failed) console.log(`[${stamp()}] AI prepared ${r.prepared}, skipped ${r.skipped} (low fit), failed ${r.failed}`);
      await heartbeat({ last_prepare: new Date().toISOString(), prep_rate_limited_for: r.rateLimitedFor, groq: groqLimits() });
      if (r.rateLimitedFor) {
        console.log(`[${stamp()}] Groq limit reached — pausing AI writing for ${r.rateLimitedFor}s`);
        await sleep(Math.min(r.rateLimitedFor, 600) * 1000);
      } else if (!r.prepared && !r.skipped && !r.failed) {
        await sleep(PREP_IDLE_MS);
      }
    } catch (err) {
      console.error(`[${stamp()}] prepare failed:`, (err as Error).message);
      await sleep(PREP_IDLE_MS);
    }
  }
}

console.log("Engine running (send loop + AI prepare loop). Ctrl+C to stop.");
await Promise.all([sendLoop(), prepareLoop()]);
process.exit(0);
