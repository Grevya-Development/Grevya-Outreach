import type { CampaignCount, LiveCounts } from "@/app/(app)/home-client";
import { apiAuth } from "@/lib/api-auth";
import { getEngineState } from "@/lib/app-state";
import { env } from "@/lib/env";
import { db, isMissingRpc } from "@/lib/supabase";

// Home's "Needs you" list polls this every minute (reading the session cookie makes it dynamic).
export async function GET() {
  const deny = await apiAuth();
  if (deny) return deny;
  const [counts, engine] = await Promise.all([liveCounts(), getEngineState()]);
  const body: LiveCounts = { ...counts, engine: { alive: engine.alive, paused: engine.paused } };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}

async function liveCounts(): Promise<Omit<LiveCounts, "engine">> {
  const supa = db();
  const { data, error } = await supa.rpc("home_summary", { p_tz: env.timezone });
  if (!error) {
    const s = (data ?? {}) as Record<string, unknown>;
    return {
      todo: Number(s.todo) || 0,
      reminders_due: Number(s.reminders_due) || 0,
      review_by_campaign: (s.review_by_campaign as CampaignCount[] | undefined) ?? [],
      failed_by_campaign: (s.failed_by_campaign as CampaignCount[] | undefined) ?? [],
      error_accounts: Number(s.error_accounts) || 0,
      unchecked: Number(s.unchecked) || 0,
    };
  }
  if (!isMissingRpc(error)) throw new Error(error.message);

  // Before migration 0004: only the counts this list needs, in parallel.
  const nowIso = new Date().toISOString();
  const count = (r: { count: number | null }) => r.count ?? 0;
  const byCampaign = (prep: string) => supa.from("campaigns").select("id, name, campaign_leads(count)")
    .eq("campaign_leads.prep_status", prep).eq("campaign_leads.status", "queued")
    .then((r) => ((r.data ?? []) as { id: string; name: string; campaign_leads: { count: number }[] }[])
      .map((c) => ({ id: c.id, name: c.name, n: Number(c.campaign_leads?.[0]?.count) || 0 }))
      .filter((c) => c.n > 0).sort((a, b) => b.n - a.n));
  const [todo, reminders, review, failed, errors, unchecked] = await Promise.all([
    supa.from("replies").select("id", { count: "exact", head: true }).eq("handled", false)
      .or(`follow_up_at.lte.${nowIso},and(kind.eq.reply,follow_up_at.is.null)`).then(count),
    supa.from("replies").select("id", { count: "exact", head: true }).eq("handled", false).lte("follow_up_at", nowIso).then(count),
    byCampaign("review"),
    byCampaign("failed"),
    supa.from("mailboxes").select("id", { count: "exact", head: true }).eq("status", "error").then(count),
    supa.from("leads").select("id", { count: "exact", head: true }).is("verify_status", null).then(count),
  ]);
  return { todo, reminders_due: reminders, review_by_campaign: review, failed_by_campaign: failed, error_accounts: errors, unchecked };
}
