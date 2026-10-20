// Writes a lead's whole sequence (first email + follow-ups) from company research, our
// profile and each step's instructions. Output is checked and regenerated once if it fails.
import { chat, parseJson } from "./groq";
import { industryText, type IndustryBrief } from "./industry";
import { DEFAULT_PLAYBOOK, lengthBounds, playbookText, type Playbook } from "./playbook";
import { profileText, type Analysis, type CompanyProfile } from "./research";
import { checkContent } from "./spamcheck";

export interface WrittenEmail {
  subject: string;
  body: string;
}

export interface WriteInput {
  lead: { email: string; first_name?: string; last_name?: string; title?: string; company?: string; notes?: string; custom?: Record<string, string> };
  analysis: Analysis | null;
  tech: string[];
  profile: CompanyProfile;
  senderName: string;
  steps: { brief: string; delay_days: number }[];
  extraInstructions: string;
  model?: string;
  playbook?: Playbook;
  industryBrief?: IndustryBrief | null;
  /** A note from the user for this one lead ("mention their new plant in Hosur"). */
  leadInstruction?: string;
}

const SYSTEM = `You write hyper-personalised B2B cold email sequences that get replies and land in the inbox.
Return JSON: {"emails": [{"subject": string, "body": string}, ...]} — exactly one item per step requested.

Hard rules (breaking any = rejected):
- Plain text. No links, no URLs, no images, no markdown, no bullet symbols, no emojis, no placeholders like [Name].
- Email 1: {{LENGTH}} words. Follow-ups: 25–70 words. Short paragraphs separated by a blank line.
- Email 1 follows the PLAYBOOK structure and is built around USE CASE 1: name their problem concretely (the workflow, who does it, the friction), say what we'd build and which solution area it is (Gen AI / Agentic AI / Technology / Digital Transformation, in plain words), give the outcome, then the ask. Follow-ups each use the NEXT use case unless the playbook says otherwise.
- Email 1 subject: 2–6 words, lowercase except names, specific to them, no "Re:", no "!" — looks like a colleague wrote it.
- Follow-up subjects must be "" (they are sent as replies in the same thread).
- Start with "Hi {first name}," on its own line (or "Hi there," if no name). Do not use their name again.
- The first sentence after the greeting must reference something specific and true from the research FACTS or detected tech — restate only what the fact literally says; never add how they use it, what it powers, or how well it works. Never invent facts, news, numbers, funding, growth or initiatives about them.
- Pick the fact most relevant to the service you're pitching — what they sell, how they operate, their scale, markets, tech, hiring. Never open with awards, certifications, rankings or "great place to work".
- Connect ONE of their likely needs to ONE of our services in their language.
- Email 1 subject is about their likely need or area of work (e.g. "dealer data at tvs", "rto workflows"), not about the fact you opened with.
- Our proof: use a result from the list, phrased naturally in a full sentence, keeping its exact number, metric and who it was for (e.g. "we cut inventory costs 45% for a supply-chain platform"). Never relabel the client ("a logistics partner"), never change numbers, never invent case studies, clients, or "we recently helped/enabled/built…" stories that are not in the proof list, never add adjectives about the client ("large", "leading", "enterprise") unless listed, and never claim a result will carry over to them ("translates to similar gains", "you can expect"). If no proof fits, describe what we could do for them instead (hypothetical "we could…", no numbers).
- Every number in the email must come from our proof list or their research facts.
- One low-friction ask as a question (e.g. "Worth a quick look?"). Never ask for a 30-minute call in email 1.
- No flattery ("impressive", "love what you're doing"), no "I hope this finds you well", no "I came across", no "synergy", no "game-changer", no "revolutionise".
- Each follow-up adds something new (a different use case, a relevant result, or a simple question) and stays polite. The last one is a brief, friendly close-out that says you won't follow up again.
- Do NOT add a sign-off, name or signature at the end — it is appended automatically.`;

function brief(input: WriteInput): string {
  const a = input.analysis;
  const l = input.lead;
  const lines = [
    `OUR COMPANY:\n${profileText(input.profile)}`,
    input.profile.tone && `Tone: ${input.profile.tone}`,
    input.profile.cta && `Preferred ask: ${input.profile.cta}`,
    // No sender name: emails rotate across mailboxes, and the signature (added later) carries the name.
    `SENDER: someone at ${input.profile.name || "our company"}${input.profile.sender_title ? ` (${input.profile.sender_title.replace(/^[^,]*,\s*/, "")})` : ""}. Never mention the sender's name.`,
    `RECIPIENT: ${[l.first_name, l.last_name].filter(Boolean).join(" ") || "(name unknown)"}${l.title ? `, ${l.title}` : ""}${l.company || a?.company_name ? ` at ${l.company || a?.company_name}` : ""}`,
    l.notes && `Notes about recipient: ${l.notes}`,
    l.custom && Object.keys(l.custom).length ? `Other data: ${Object.entries(l.custom).map(([k, v]) => `${k}=${v}`).join("; ")}` : "",
    a
      ? `RESEARCH:\nWhat they do: ${a.what_they_do}\nIndustry: ${a.industry}\nBusiness model: ${a.business_model}\nCustomers: ${a.customers}\nFACTS (true, from their site): ${a.facts.join(" | ") || "none"}\nLikely needs (inference): ${a.likely_needs.join(" | ")}${a.pain_points?.length ? `\nLikely pain points (inference): ${a.pain_points.join(" | ")}` : ""}\nBest service for them: ${a.best_service}\nSuggested angle: ${a.angle}`
      : "RESEARCH: none available — keep the opener about their role/industry and make no claims about the company.",
    input.tech.length ? `Detected on their website: ${input.tech.join(", ")}` : "",
    `PLAYBOOK:\n${playbookText(input.playbook ?? DEFAULT_PLAYBOOK)}`,
    industryText(input.industryBrief ?? null, (input.playbook ?? DEFAULT_PLAYBOOK).pillars),
    a?.industry_context && `Industry context: ${a.industry_context}`,
    a?.use_cases?.length
      ? `USE CASES (write Email 1 around #1; ${(input.playbook ?? DEFAULT_PLAYBOOK).follow_up_strategy === "same_use_case" ? "follow-ups nudge #1 from new angles" : "follow-up 2 uses #2, follow-up 3 uses #3, later ones close out"}):\n` +
        a.use_cases.map((u, i) => `#${i + 1} ${u.title} [${u.pillar}; grounded in ${u.grounded_in}]\n   Problem: ${u.problem}\n   What we'd build: ${u.solution}\n   Outcome: ${u.outcome}\n   First step: ${u.first_step}`).join("\n")
      : "",
    input.extraInstructions && `Campaign instructions: ${input.extraInstructions}`,
    input.leadInstruction && `INSTRUCTION FOR THIS LEAD (must follow): ${input.leadInstruction}`,
    `STEPS (${input.steps.length}):\n${input.steps.map((s, i) => `${i + 1}. ${i === 0 ? "First email" : `Follow-up after ${s.delay_days} days`}: ${s.brief || (i === 0 ? "Personalised intro." : i === input.steps.length - 1 ? "Short, friendly close-out." : "Add a new angle.")}`).join("\n")}`,
  ];
  return lines.filter(Boolean).join("\n\n");
}

/** Normalises the odd Unicode punctuation some models emit (non-breaking hyphens etc.). */
function tidy(s: string): string {
  return s.replace(/[\u2010\u2011\u2012\u2043]/g, "-").replace(/\u00a0|\u202f|\u2009/g, " ").replace(/[\u200b-\u200d\ufeff]/g, "");
}

const NUM_RE = /\d+(?:[.,]\d+)*(?:\s*(?:%|percent|x\b|\+))?/gi;
/** "45%", "45 percent", "45" all compare as 45; "1,000+" as 1000. */
const bare = (t: string) => t.toLowerCase().replace(/percent|%|x$|\+/g, "").replace(/[\s,]/g, "").replace(/\.$/, "");

/** Numbers in the email that don't appear in any source we gave the model = invented stats. */
export function inventedNumbers(text: string, sources: string): string[] {
  const allowed = new Set((sources.match(NUM_RE) ?? []).map(bare));
  return [...new Set((text.match(NUM_RE) ?? []).map((n) => n.trim()))]
    .filter((n) => !allowed.has(bare(n)) && !/^[0-9]$/.test(bare(n))); // single digits ("2 minutes") are fine
}

const RESULT_VERB = /\b(we|our [a-z0-9 -]{1,40}?)\s+(recently\s+|also\s+|have\s+|already\s+)*(helped|enabled|streamlined|delivered|achieved|cut|reduced|saved|built|automated|improved|halved|doubled|tripled|increased|boosted|transformed|worked with|partnered with)\b/i;
const THIRD_PARTY = /\b(for|at|with|helped|enabled|worked with|partnered with)\s+(a|an|one|another|one of|several|many)\b|\b(client|customer|partner|provider|company|firm|brand|manufacturer|retailer|bank|insurer|startup|enterprise|oem|team at)s?\b/i;

/** Sentences claiming a past result for some client, without a number from our proof list. */
export function unprovenClaims(body: string, proof: string): string[] {
  const proofNums = new Set((proof.match(NUM_RE) ?? []).map(bare));
  return body.split(/(?<=[.!?])\s+/).filter((sentence) => {
    if (!RESULT_VERB.test(sentence) || !THIRD_PARTY.test(sentence)) return false;
    const nums = (sentence.match(NUM_RE) ?? []).map(bare);
    return !nums.some((n) => proofNums.has(n));
  });
}

function validate(emails: WrittenEmail[], stepCount: number, sources = "", proof = "", bounds: [number, number] = [35, 150]): string[] {
  const problems: string[] = [];
  const src = sources.toLowerCase();
  if (emails.length !== stepCount) problems.push(`expected ${stepCount} emails, got ${emails.length}`);
  emails.forEach((e, i) => {
    const words = e.body.split(/\s+/).filter(Boolean).length;
    if (i === 0 && (words < bounds[0] - 10 || words > bounds[1] + 25)) problems.push(`email 1 has ${words} words (wanted ${bounds[0]}–${bounds[1]})`);
    if (i > 0 && words > 100) problems.push(`email ${i + 1} has ${words} words`);
    const r = checkContent(e.subject, e.body, { allowLinks: 0, isFollowUp: i > 0 });
    for (const issue of r.issues) {
      if (issue.level === "low") continue;
      // Quoting our own proof verbatim ("100% uptime") isn't spam-bait.
      const words = issue.message.startsWith("Spam trigger words:") ? issue.message.slice(20).split(",").map((w) => w.trim().toLowerCase()) : null;
      if (words && words.every((w) => src.includes(w))) continue;
      problems.push(`email ${i + 1}: ${issue.message}`);
    }
    const invented = inventedNumbers(`${e.subject} ${e.body}`, sources);
    if (invented.length) problems.push(`email ${i + 1} uses numbers not in our proof or their facts (${invented.join(", ")}) — remove them or quote proof exactly`);
    for (const c of unprovenClaims(e.body, proof)) {
      problems.push(`email ${i + 1} claims a past result that is not in our proof list ("${c.slice(0, 70)}") — use a listed result exactly, or say what we could do instead`);
    }
  });
  return problems;
}

/** Writes all steps for one lead. Throws if two attempts both fail validation. */
export async function writeSequence(input: WriteInput): Promise<WrittenEmail[]> {
  let feedback = "";
  // Everything the model is allowed to quote numbers from.
  const a = input.analysis;
  const p = input.profile;
  const pb = input.playbook ?? DEFAULT_PLAYBOOK;
  const bounds = lengthBounds(pb.length);
  const sources = [
    p.proof, p.services, p.one_liner, p.cta, p.ideal_customer, p.sender_title, p.name, input.extraInstructions, input.leadInstruction,
    playbookText(pb), industryText(input.industryBrief ?? null, pb.pillars), a?.industry_context,
    a?.use_cases?.map((u) => `${u.title} ${u.problem} ${u.solution} ${u.outcome} ${u.first_step}`).join(" "),
    a ? [...a.facts, ...a.likely_needs, ...(a.pain_points ?? []), a.what_they_do, a.customers, a.company_name, a.industry, a.business_model, a.best_service, a.angle].join(" ") : "",
    input.tech.join(" "),
    input.lead.title, input.lead.company, input.lead.notes, Object.values(input.lead.custom ?? {}).join(" "),
    input.steps.map((s) => `${s.brief} ${s.delay_days}`).join(" "),
  ].filter(Boolean).join(" ");
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await chat({
      system: SYSTEM.replace("{{LENGTH}}", bounds.join("–")),
      user: brief(input) + (feedback ? `\n\nYOUR PREVIOUS DRAFT WAS REJECTED: ${feedback}. Fix these problems.` : ""),
      temperature: 0.6,
      maxTokens: 300 + input.steps.length * 220,
      json: true,
      model: input.model,
      pool: "write",
    });
    const parsed = parseJson<{ emails?: { subject?: string; body?: string }[] }>(raw);
    const emails = (parsed.emails ?? []).slice(0, input.steps.length).map((e, i) => ({
      subject: i === 0 ? tidy(String(e.subject ?? "")).trim() : "",
      body: tidy(String(e.body ?? "")).replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim(),
    }));
    const problems = validate(emails, input.steps.length, sources, `${p.proof} ${p.one_liner} ${p.services}`, bounds);
    if (!problems.length) return emails;
    feedback = problems.join("; ");
  }
  throw new Error(`AI draft failed quality checks: ${feedback}`);
}

/** Drafts a reply to a prospect's reply: short, human, moves toward a next step. */
export async function draftReply(input: {
  profile: CompanyProfile;
  senderName: string;
  theirReply: string;
  theirName: string;
  ourLastEmail: string;
  sentiment: string | null;
  analysis: Analysis | null;
}): Promise<string> {
  const raw = await chat({
    system: `You write the sender's reply to a prospect who answered a cold email. Plain text, 30–110 words, warm and direct, no links unless the prospect asked for one, no placeholders, no sign-off or name at the end.
- If they're interested or asked a question: answer it plainly using only facts from OUR COMPANY, then propose one concrete next step (e.g. offer two time slots "this Thursday or Friday afternoon?" or offer to send a one-page outline).
- If they said not now / wrong person: thank them, ask (once) who the right person is or whether to check back in a few months.
- If they said no / unsubscribe: one short, gracious line confirming you won't email again.
- Never invent prices, timelines, clients or numbers that aren't in OUR COMPANY.
Return JSON: {"reply": string}`,
    user: [
      `OUR COMPANY:\n${profileText(input.profile)}`,
      `SENDER: ${input.senderName || input.profile.sender_name}`,
      input.analysis ? `ABOUT THEM: ${input.analysis.what_they_do}` : "",
      `OUR LAST EMAIL:\n${input.ourLastEmail.slice(0, 1500) || "(not available)"}`,
      `THEIR REPLY (${input.sentiment ?? "unclassified"}) from ${input.theirName}:\n${input.theirReply.slice(0, 2500)}`,
    ].filter(Boolean).join("\n\n"),
    temperature: 0.5,
    maxTokens: 400,
    json: true,
  });
  const reply = String(parseJson<{ reply?: string }>(raw).reply ?? "").replace(/[‐‑]/g, "-").trim();
  if (!reply) throw new Error("AI returned an empty reply");
  return reply;
}
