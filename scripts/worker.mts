// Optional. The engine starts automatically with the app (npm run dev / npm start). Use this only
// to run sending on a separate machine, with ENGINE_IN_APP=off on the web app.
// `npm run worker` runs the same loops as the app (src/lib/engine-runner.ts):
//   send        every 20s — sends due emails, checks inboxes for replies/bounces
//   prepare     continuous — researches companies and writes AI emails ahead of time
//   verify      checks new leads' email addresses in the background
//   capability  every 30 min — checks whether this network can reach mail servers on port 25
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

// Never let one bad socket or promise take the whole engine down.
process.on("unhandledRejection", (e) => console.error(`[${new Date().toLocaleTimeString()}] unhandled rejection:`, e));
process.on("uncaughtException", (e) => console.error(`[${new Date().toLocaleTimeString()}] uncaught exception:`, e));

const { startEngine, stopEngine } = await import("../src/lib/engine-runner");

let stopping = false;
const stop = async () => {
  if (stopping) process.exit(1); // second Ctrl+C: don't wait
  stopping = true;
  console.log("\nStopping after current work… (Ctrl+C again to quit now)");
  await stopEngine();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

startEngine({ log: (msg) => console.log(`${new Date().toLocaleTimeString()} ${msg}`) });
console.log("Ctrl+C to stop.");
