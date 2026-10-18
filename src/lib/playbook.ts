// The AI playbook: how a campaign's emails should be built. Stored per campaign in app_state
// (`playbook:<campaignId>`) on top of a global default (`playbook:default`), so no migration is
// needed and every field is optional.
import { db } from "./supabase";

export type Pillar = "Gen AI" | "Agentic AI" | "Technology" | "Digital Transformation";
export const PILLARS: Pillar[] = ["Gen AI", "Agentic AI", "Technology", "Digital Transformation"];

export type EmailStyle = "use_case" | "question" | "insight" | "story";
export type EmailLength = "short" | "medium" | "long";
export type Section = "opener" | "problem" | "solution" | "proof" | "ask";

export interface Playbook {
  /** Which solution areas the AI may pitch. */
  pillars: Pillar[];
  /** What we actually do under each pillar, in our words (the AI never invents beyond this). */
  pillar_notes: Partial<Record<Pillar, string>>;
  /** Who this campaign targets: industries, company sizes, roles. */
  target: string;
  /** Problems to look for in the lead's business (e.g. "manual document processing, slow quoting"). */
  problem_focus: string;
  style: EmailStyle;
  /** Order of sections in Email 1. */
  structure: Section[];
  length: EmailLength;
  tone: string;
  cta: string;
  /** Follow-ups: pitch a different use case each time, or keep nudging the same one. */
  follow_up_strategy: "new_use_case" | "same_use_case";
  avoid: string;
  must_mention: string;
}

export const DEFAULT_PLAYBOOK: Playbook = {
  pillars: ["Gen AI", "Agentic AI", "Technology", "Digital Transformation"],
  pillar_notes: {
    "Gen AI": "Custom LLM applications: document understanding, content generation, natural-language-to-SQL, copilots for internal teams.",
    "Agentic AI": "Multi-agent systems that run real workflows end to end — claims, support, procurement, scheduling — with human approval gates.",
    "Technology": "Production engineering: integrations with ERP/CRM, data pipelines, APIs, secure cloud deployment, monitoring.",
    "Digital Transformation": "Replacing manual, spreadsheet and email-driven processes with automated, measurable digital workflows — pilot in weeks, then scale.",
  },
  target: "",
  problem_focus: "",
  style: "use_case",
  structure: ["opener", "problem", "solution", "proof", "ask"],
  length: "medium",
  tone: "Direct, warm, plain English. Like a sharp colleague, not a brochure.",
  cta: "Worth a quick look?",
  follow_up_strategy: "new_use_case",
  avoid: "",
  must_mention: "",
};

const KEY = (campaignId: string | null) => (campaignId ? `playbook:${campaignId}` : "playbook:default");

function merge(base: Playbook, over: Partial<Playbook> | null | undefined): Playbook {
  if (!over) return base;
  const out: Playbook = { ...base, ...over, pillar_notes: { ...base.pillar_notes, ...(over.pillar_notes ?? {}) } };
  if (!Array.isArray(out.pillars) || !out.pillars.length) out.pillars = base.pillars;
  out.pillars = out.pillars.filter((p): p is Pillar => PILLARS.includes(p));
  if (!Array.isArray(out.structure) || !out.structure.length) out.structure = base.structure;
  return out;
}

/** Effective playbook for a campaign: built-in defaults ← your default ← this campaign's overrides. */
export async function getPlaybook(campaignId: string | null): Promise<Playbook> {
  const supa = db();
  const keys = campaignId ? [KEY(null), KEY(campaignId)] : [KEY(null)];
  const { data } = await supa.from("app_state").select("key, value").in("key", keys);
  const byKey = new Map((data ?? []).map((r) => [r.key as string, r.value as Partial<Playbook>]));
  return merge(merge(DEFAULT_PLAYBOOK, byKey.get(KEY(null))), campaignId ? byKey.get(KEY(campaignId)) : null);
}

/** Saves a playbook for one campaign, or (campaignId = null) as the default for new campaigns. */
export async function savePlaybook(campaignId: string | null, pb: Partial<Playbook>): Promise<void> {
  const clean = merge(DEFAULT_PLAYBOOK, pb);
  const { error } = await db().from("app_state").upsert({ key: KEY(campaignId), value: clean, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

const LENGTH_WORDS: Record<EmailLength, [number, number]> = { short: [45, 80], medium: [70, 110], long: [100, 150] };
export function lengthBounds(len: EmailLength): [number, number] {
  return LENGTH_WORDS[len] ?? LENGTH_WORDS.medium;
}

/** The playbook as instructions for the model. */
export function playbookText(pb: Playbook): string {
  const pillars = pb.pillars.map((p) => `- ${p}: ${pb.pillar_notes[p] ?? ""}`.trim()).join("\n");
  const styleText: Record<EmailStyle, string> = {
    use_case: "Lead with a concrete use case: their problem → what we'd build → the outcome.",
    question: "Lead with one sharp question about a problem they likely have, then one line on how we solve it.",
    insight: "Lead with an industry insight relevant to them, connect it to one use case.",
    story: "Lead with a short, true story from our proof list (no invented details), connect it to them.",
  };
  return [
    `SOLUTION AREAS we may pitch (only these):\n${pillars}`,
    pb.target && `Target for this campaign: ${pb.target}`,
    pb.problem_focus && `Problems to look for: ${pb.problem_focus}`,
    `Style: ${styleText[pb.style] ?? styleText.use_case}`,
    `Email 1 structure, in this order: ${pb.structure.join(" → ")}. (opener = one specific true thing about them; problem = the pain, named concretely; solution = what we'd build and which solution area; proof = one listed result, exact; ask = the call to action.)`,
    `Length: ${pb.length} (${lengthBounds(pb.length).join("–")} words for Email 1).`,
    pb.tone && `Tone: ${pb.tone}`,
    pb.cta && `Call to action: ${pb.cta}`,
    `Follow-ups: ${pb.follow_up_strategy === "same_use_case" ? "keep nudging the same use case from a new angle." : "each follow-up pitches the NEXT use case from the research — never repeat one."}`,
    pb.avoid && `Never: ${pb.avoid}`,
    pb.must_mention && `Always mention: ${pb.must_mention}`,
  ].filter(Boolean).join("\n");
}
