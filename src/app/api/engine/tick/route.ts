import { timingSafeEqual } from "node:crypto";
import { tick } from "@/lib/engine";

export const maxDuration = 300;

// Call this every minute from any cron (Vercel Cron, cron-job.org, GitHub Actions…)
// with header `Authorization: Bearer $CRON_SECRET`.
async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (!secret || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await tick({ prepareMs: 45_000 });
  return Response.json(result);
}

export const GET = handle;
export const POST = handle;
