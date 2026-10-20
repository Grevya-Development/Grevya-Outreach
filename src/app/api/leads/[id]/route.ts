import { apiAuth } from "@/lib/api-auth";
import { cachedIndustryBrief, type IndustryBrief } from "@/lib/industry";
import { leadDomain } from "@/lib/research";
import { db } from "@/lib/supabase";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Everything the lead drawer shows: the lead, its campaigns (with step counts) and recent activity. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const deny = await apiAuth();
  if (deny) return deny;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "not found" }, { status: 404 });

  const supa = db();
  const [lead, enrolments, messages, replies] = await Promise.all([
    supa.from("leads").select("*").eq("id", id).maybeSingle(),
    // `campaign_steps(count)` gives each campaign's number of emails in the same query.
    supa.from("campaign_leads")
      .select("id, status, current_step, next_send_at, prep_status, skip_reason, last_error, created_at, campaigns(id, name, status, mode, campaign_steps(count))")
      .eq("lead_id", id).order("created_at", { ascending: false }),
    supa.from("messages").select("id, sent_at, subject, step_number, status, kind, campaign_id")
      .eq("lead_id", id).order("sent_at", { ascending: false }).limit(50),
    supa.from("replies").select("id, received_at, subject, snippet, kind, sentiment, campaign_id")
      .eq("lead_id", id).order("received_at", { ascending: false }).limit(50),
  ]);
  const failed = lead.error ?? enrolments.error ?? messages.error ?? replies.error;
  if (failed) return Response.json({ error: failed.message }, { status: 500 });
  if (!lead.data) return Response.json({ error: "not found" }, { status: 404 });

  type Row = Record<string, unknown> & { campaigns: (Record<string, unknown> & { campaign_steps?: { count: number }[] }) | null };
  const steps: Record<string, number> = {};
  const campaigns = ((enrolments.data ?? []) as unknown as Row[]).map(({ campaigns: c, ...cl }) => {
    if (c) steps[c.id as string] = Number(c.campaign_steps?.[0]?.count) || 0;
    const campaign = c ? { id: c.id, name: c.name, status: c.status, mode: c.mode } : null;
    return { ...cl, campaign };
  });

  // Company research for the lead's domain (from their website, else their email), plus the cached industry brief.
  const domain = leadDomain(lead.data as { email: string; website?: string });
  let research: Record<string, unknown> | null = null;
  let industry: IndustryBrief | null = null;
  if (domain) {
    research = (await supa.from("company_research").select("domain, status, url, title, analysis, error, fetched_at, analyzed_at").eq("domain", domain).maybeSingle()).data;
    const ind = (research?.analysis as { industry?: string } | null)?.industry;
    if (ind) industry = await cachedIndustryBrief(ind);
  }

  return Response.json(
    { lead: lead.data, campaigns, steps, messages: messages.data ?? [], replies: replies.data ?? [], domain, research, industry },
    { headers: { "Cache-Control": "no-store" } },
  );
}
