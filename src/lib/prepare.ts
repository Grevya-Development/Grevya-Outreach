// Preparation pipeline for AI campaigns: research each lead's company, score fit, and
// write the whole sequence ahead of send time. Runs in the background (worker / cron)
// and is paced to Groq's limits, so sending never waits on the AI.
import { env } from "./env";
import { RateLimitError } from "./groq";
import { getProfile } from "./profile";
import { missingMigrations } from "./schema";
import { leadDomain, researchDomain, type Research } from "./research";
import { db, must } from "./supabase";
import type { Campaign, CampaignLead, CampaignStep, Lead } from "./types";
import { writeSequence } from "./writer";

export interface PrepResult {
  prepared: number;
  skipped: number;
  failed: number;
  rateLimitedFor: number; // seconds, 0 if not limited
  errors: string[];
}

export interface Personalization {
  emails: { subject: string; body: string }[];
  research_domain: string | null;
  angle?: string;
  best_service?: string;
  fit_score?: number;
  generated_at: string;
  ai_line?: string;
}

/**
 * Prepares one claimed lead (prep_status = 'working', prep_locked_until = this claim's token).
 * Results are only saved if the claim is still current — if the sequence was edited or the
 * lead was sent back for rewriting meanwhile, the stale draft is discarded.
 */
export async function prepareLead(cl: CampaignLead, opts: { force?: boolean } = {}): Promise<"ready" | "review" | "skipped" | "superseded"> {
  const supa = db();
  const [campaign, steps, lead, profile] = await Promise.all([
    supa.from("campaigns").select("*").eq("id", cl.campaign_id).single().then(must) as Promise<Campaign>,
    supa.from("campaign_steps").select("*").eq("campaign_id", cl.campaign_id).order("step_number").then(must) as Promise<CampaignStep[]>,
    supa.from("leads").select("*").eq("id", cl.lead_id).single().then(must) as Promise<Lead>,
    getProfile(),
  ]);
  if (!steps.length) throw new Error("Campaign has no steps");

  if (!profile.services.trim()) throw new Error("Company profile is empty — fill it in under Settings before AI emails can be written");

  // Only the claim that started this work may save its result.
  const finish = async (patch: Record<string, unknown>) => {
    let q = supa.from("campaign_leads").update({ ...patch, prep_locked_until: null }).eq("id", cl.id).eq("prep_status", "working");
    q = cl.prep_locked_until ? q.eq("prep_locked_until", cl.prep_locked_until) : q.is("prep_locked_until", null);
    const { data, error } = await q.select("id");
    if (error) throw new Error(error.message);
    return (data?.length ?? 0) > 0;
  };

  const domain = leadDomain(lead);
  let research: Research | null = null;
  if (domain) research = await researchDomain(domain, profile, { force: opts.force });
  const analysis = research?.status === "ok" ? research.analysis : null;

  // Skip clear non-fits before spending a send on them.
  if (campaign.min_fit_score > 0 && analysis && analysis.confidence !== "low" && analysis.fit_score < campaign.min_fit_score) {
    const saved = await finish({
      prep_status: "skipped", status: "skipped", fit_score: analysis.fit_score,
      skip_reason: `Low fit (${analysis.fit_score}/10): ${analysis.fit_reason}`.slice(0, 300),
    });
    return saved ? "skipped" : "superseded";
  }

  const emails = await writeSequence({
    lead,
    analysis,
    tech: research?.tech ?? [],
    profile,
    senderName: "",
    steps: steps.map((s) => ({ brief: s.body, delay_days: s.delay_days })),
    extraInstructions: [campaign.ai_prompt, campaign.sender_context && `Context: ${campaign.sender_context}`].filter(Boolean).join("\n"),
  });

  const personalization: Personalization = {
    emails,
    research_domain: domain,
    angle: analysis?.angle,
    best_service: analysis?.best_service,
    fit_score: analysis?.fit_score,
    generated_at: new Date().toISOString(),
  };
  const status = campaign.require_approval ? "review" : "ready";
  const saved = await finish({ personalization, prep_status: status, prep_error: null, fit_score: analysis?.fit_score ?? null });
  return saved ? status : "superseded";
}

/** Prepares leads until the time budget runs out or Groq asks us to slow down. */
export async function prepareBatch(timeBudgetMs: number): Promise<PrepResult> {
  const out: PrepResult = { prepared: 0, skipped: 0, failed: 0, rateLimitedFor: 0, errors: [] };
  if (!env.groqKey) return out;
  const supa = db();
  const deadline = Date.now() + timeBudgetMs;

  // Respect a backoff recorded by a previous run (shared across worker + cron).
  if ((await missingMigrations()).length) return { ...out, errors: ["Database needs updating (see dashboard)."] };
  if (!(await getProfile()).services.trim()) {
    return { ...out, errors: ["Company profile is empty — AI writing is paused until you fill it in (Settings)."] };
  }
  const { data: backoff } = await supa.from("app_state").select("value").eq("key", "groq_backoff").maybeSingle();
  const until = Number((backoff?.value as { until?: number } | undefined)?.until ?? 0);
  if (until > Date.now()) return { ...out, rateLimitedFor: Math.ceil((until - Date.now()) / 1000) };

  while (Date.now() < deadline) {
    const claimed = must(await supa.rpc("claim_prep", { p_limit: 1 })) as CampaignLead[];
    const cl = claimed[0];
    if (!cl) break;
    try {
      const status = await prepareLead(cl);
      if (status === "skipped") out.skipped++;
      else if (status !== "superseded") out.prepared++;
    } catch (err) {
      if (err instanceof RateLimitError) {
        // Put it back and pause the whole pipeline until Groq's window resets.
        await supa.from("campaign_leads").update({ prep_status: "pending", prep_locked_until: null, prep_attempts: Math.max(0, cl.prep_attempts - 1) }).eq("id", cl.id);
        await supa.from("app_state").upsert({ key: "groq_backoff", value: { until: Date.now() + err.retryAfterSec * 1000 }, updated_at: new Date().toISOString() });
        out.rateLimitedFor = err.retryAfterSec;
        break;
      }
      const msg = (err as Error).message.slice(0, 300);
      const giveUp = cl.prep_attempts >= 3;
      // Back off before retrying this lead (prep_locked_until doubles as "not before" for pending leads).
      await supa.from("campaign_leads").update({
        prep_status: giveUp ? "failed" : "pending", prep_error: msg,
        prep_locked_until: giveUp ? null : new Date(Date.now() + 10 * 60_000 * cl.prep_attempts).toISOString(),
      }).eq("id", cl.id).eq("prep_status", "working");
      if (giveUp) out.failed++;
      out.errors.push(msg);
    }
  }
  return out;
}
