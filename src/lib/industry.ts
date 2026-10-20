// Industry research: one cached brief per industry (what hurts in that industry, where Gen AI /
// Agentic AI / Technology / Digital Transformation apply, the numbers buyers care about). The
// per-lead use cases are grounded in this plus the company's own website.
import { chat, parseJson } from "./groq";
import { PILLARS, type Pillar } from "./playbook";
import { db } from "./supabase";

export interface IndustryBrief {
  industry: string;
  summary: string;
  challenges: string[];                       // 4-6 common operational pains
  opportunities: Record<Pillar, string[]>;    // 1-3 concrete applications per pillar
  kpis: string[];                             // metrics this industry's buyers track
  buyers: string[];                           // roles who own these problems
  generated_at: string;
}

const slug = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const TTL_MS = 60 * 86_400_000;
const inflight = new Map<string, Promise<IndustryBrief | null>>();

const SYSTEM = `You are a management consultant briefing a Gen AI services company before it emails prospects in one industry.
Return JSON: {"summary": string (2 sentences on how this industry operates today),
 "challenges": string[] (4-6 specific, operational pains common in this industry — name the workflow, e.g. "manual matching of purchase orders to invoices across 3 ERPs"),
 "opportunities": {"Gen AI": string[], "Agentic AI": string[], "Technology": string[], "Digital Transformation": string[]} (1-3 concrete, deployable applications each; name the workflow and the outcome, no hype),
 "kpis": string[] (4-6 metrics buyers in this industry track),
 "buyers": string[] (3-5 job titles who own these problems)}
Be specific to the industry, not generic. No marketing language. Plain English.`;

/** Returns the brief for an industry, generating and caching it on first use. Null if the AI is unavailable. */
export async function industryBrief(industry: string): Promise<IndustryBrief | null> {
  const name = industry.trim();
  if (!name || name.length < 3) return null;
  const key = `industry:${slug(name)}`;
  const supa = db();
  const { data } = await supa.from("app_state").select("value, updated_at").eq("key", key).maybeSingle();
  if (data && Date.now() - new Date(data.updated_at).getTime() < TTL_MS) return data.value as IndustryBrief;

  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      try {
        const raw = await chat({ system: SYSTEM, user: `Industry: ${name}`, temperature: 0.3, maxTokens: 900, json: true, pool: "research" });
        const b = parseJson<Partial<IndustryBrief>>(raw);
        const opp = (b.opportunities ?? {}) as Partial<Record<Pillar, unknown>>;
        const brief: IndustryBrief = {
          industry: name,
          summary: String(b.summary ?? ""),
          challenges: Array.isArray(b.challenges) ? b.challenges.map(String).slice(0, 6) : [],
          opportunities: Object.fromEntries(PILLARS.map((pl) => [pl, Array.isArray(opp[pl]) ? (opp[pl] as unknown[]).map(String).slice(0, 3) : []])) as Record<Pillar, string[]>,
          kpis: Array.isArray(b.kpis) ? b.kpis.map(String).slice(0, 6) : [],
          buyers: Array.isArray(b.buyers) ? b.buyers.map(String).slice(0, 5) : [],
          generated_at: new Date().toISOString(),
        };
        await supa.from("app_state").upsert({ key, value: brief, updated_at: new Date().toISOString() });
        return brief;
      } catch {
        return null;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
  }
  return p;
}

/** The cached brief only (no AI call). Null if this industry hasn't been researched yet. */
export async function cachedIndustryBrief(industry: string): Promise<IndustryBrief | null> {
  if (!industry.trim()) return null;
  const { data } = await db().from("app_state").select("value").eq("key", `industry:${slug(industry.trim())}`).maybeSingle();
  return (data?.value as IndustryBrief | undefined) ?? null;
}

export function industryText(b: IndustryBrief | null, pillars: Pillar[]): string {
  if (!b) return "";
  return [
    `INDUSTRY BRIEF (${b.industry}; general knowledge, not facts about this company):`,
    b.summary,
    `Common pains: ${b.challenges.join(" | ")}`,
    ...pillars.map((p) => (b.opportunities[p]?.length ? `${p} applications: ${b.opportunities[p].join(" | ")}` : "")),
    b.kpis.length ? `Metrics they track: ${b.kpis.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}
