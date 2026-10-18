// Runs once when the server starts. It starts the sending engine inside the app, so
// `npm run dev` / `npm start` is all you need. Not started:
//  - on Vercel and other serverless hosts (a cron calls /api/engine/tick there instead),
//  - during `next build`,
//  - with ENGINE_IN_APP=off (when `npm run worker` runs the engine on another machine),
//  - before Supabase is configured.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.ENGINE_IN_APP === "off" || process.env.VERCEL || process.env.NEXT_PHASE === "phase-production-build") return;
    if (!process.env.SUPABASE_URL) {
      console.log("[engine] not started: SUPABASE_URL is not set (see .env.example)");
      return;
    }
    try {
      const { startEngine } = await import("./lib/engine-runner");
      startEngine({ log: console.log }); // starts the loops in the background; never awaited
    } catch (err) {
      console.log(`[engine] not started: ${(err as Error).message}`);
    }
  }
}
