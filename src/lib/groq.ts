import { env } from "./env";
import type { TemplateLead } from "./template";

export class RateLimitError extends Error {
  constructor(public retryAfterSec: number) {
    super(`Groq rate limit, retry in ${retryAfterSec}s`);
  }
}

interface ChatOptions {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  /** A specific model, or a pool to fall back through when one model's daily limit is used up. */
  model?: string;
  pool?: "write" | "research";
  json?: boolean;
}

/** Latest rate-limit state Groq reported for each model (per process). */
export interface ModelLimits {
  remainingRequests: number | null; // requests left today
  limitRequests: number | null;
  requestsResetAt: number;          // ms epoch when the daily request quota refills
  remainingTokens: number | null;   // tokens left this minute
  tokensResetAt: number;            // ms epoch
  blockedUntil: number;             // ms epoch, set after a 429 (incl. tokens-per-day)
  tokensToday: number;              // tokens this process has used today
  day: string;
  updatedAt: number;
}
const limits = new Map<string, ModelLimits>();
export function groqLimits(): Record<string, ModelLimits> {
  return Object.fromEntries(limits);
}

const QWEN = "qwen/qwen3.8-27b";
const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];
/**
 * Groq's free plan gives each model its own daily budget (≈1,000 requests, 200K tokens),
 * so spreading work across models roughly triples free capacity.
 */
export function modelPool(pool: "write" | "research"): string[] {
  const extra = (process.env.GROQ_EXTRA_MODELS ?? "").split(",").map((x) => x.trim());
  return pool === "write"
    ? uniq([env.groqModel, QWEN, env.groqFastModel, ...extra])
    : uniq([env.groqFastModel, QWEN, env.groqModel, ...extra]);
}

/** Parses Groq durations like "577ms", "7.66s", "1m26.4s", "2h3m". */
function durationMs(v: string | null): number {
  if (!v) return 0;
  let ms = 0;
  for (const [, n, unit] of v.matchAll(/([\d.]+)(ms|h|m|s)/g)) {
    const x = Number(n);
    ms += unit === "ms" ? x : unit === "s" ? x * 1000 : unit === "m" ? x * 60_000 : x * 3_600_000;
  }
  return ms;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

/** Model-specific request options (reasoning models think before answering). */
function modelParams(m: string, maxTokens: number) {
  if (m.includes("gpt-oss")) return { max_tokens: maxTokens + 700, reasoning_effort: "low", include_reasoning: false };
  if (m.startsWith("qwen/")) return { max_tokens: maxTokens, reasoning_effort: "none" };
  return { max_tokens: maxTokens };
}

async function chatOnce(m: string, o: ChatOptions): Promise<string> {
  const params = modelParams(m, o.maxTokens ?? 300);
  const estimate = Math.ceil((o.system.length + o.user.length) / 3.5) + params.max_tokens;
  const now = Date.now();
  const st = limits.get(m);
  if (st) {
    if (st.blockedUntil > now) throw new RateLimitError(Math.ceil((st.blockedUntil - now) / 1000));
    // Daily request quota used up — but only until it refills (otherwise we'd never ask again).
    if (st.remainingRequests !== null && st.remainingRequests <= 0 && st.requestsResetAt > now) {
      throw new RateLimitError(Math.ceil((st.requestsResetAt - now) / 1000));
    }
    if (st.remainingTokens !== null && st.remainingTokens < estimate && st.tokensResetAt > now) {
      const wait = st.tokensResetAt - now + 250;
      if (wait > 20_000) throw new RateLimitError(Math.ceil(wait / 1000));
      await sleep(wait);
    }
  }

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.groqKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: m,
      temperature: o.temperature ?? 0.7,
      ...params,
      messages: [
        { role: "system", content: o.system },
        { role: "user", content: o.user },
      ],
      ...(o.json ? { response_format: { type: "json_object" } } : {}),
    }),
    signal: AbortSignal.timeout(45_000),
  });

  const h = res.headers;
  const num = (k: string) => (h.get(k) === null ? null : Number(h.get(k)));
  const prev = limits.get(m);
  const next: ModelLimits = {
    remainingRequests: num("x-ratelimit-remaining-requests"),
    limitRequests: num("x-ratelimit-limit-requests"),
    requestsResetAt: Date.now() + (durationMs(h.get("x-ratelimit-reset-requests")) || 3_600_000),
    remainingTokens: num("x-ratelimit-remaining-tokens"),
    tokensResetAt: Date.now() + durationMs(h.get("x-ratelimit-reset-tokens")),
    blockedUntil: 0,
    tokensToday: prev?.day === today() ? prev.tokensToday : 0,
    day: today(),
    updatedAt: Date.now(),
  };
  if (res.status === 429) {
    const body = await res.text();
    // Tokens-per-day exhaustion comes back as a 429 with a long retry-after.
    const retry = Number(h.get("retry-after")) || Math.ceil(durationMs(body.match(/try again in ([\dhms.]+)/i)?.[1] ?? "") / 1000) || 60;
    limits.set(m, { ...next, blockedUntil: Date.now() + retry * 1000 });
    throw new RateLimitError(retry);
  }
  if (!res.ok) {
    limits.set(m, next);
    throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  next.tokensToday += Number(data.usage?.total_tokens ?? 0);
  limits.set(m, next);
  return String(data.choices?.[0]?.message?.content ?? "").trim();
}

/** Calls Groq, falling back through the model pool when a model is rate-limited. */
export async function chat(o: ChatOptions): Promise<string> {
  if (!env.groqKey) throw new Error("GROQ_API_KEY is not set");
  const models = o.model ? [o.model] : modelPool(o.pool ?? "write");
  let shortest = Infinity;
  for (const m of models) {
    try {
      return await chatOnce(m, o);
    } catch (err) {
      if (!(err instanceof RateLimitError)) throw err;
      shortest = Math.min(shortest, err.retryAfterSec);
    }
  }
  throw new RateLimitError(Number.isFinite(shortest) ? shortest : 60);
}

/** Parses a JSON reply, tolerating code fences or stray text around the object. */
export function parseJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("AI did not return JSON");
    return JSON.parse(m[0]) as T;
  }
}

function describeLead(lead: TemplateLead): string {
  const rows: [string, string | undefined][] = [
    ["Name", [lead.first_name, lead.last_name].filter(Boolean).join(" ")],
    ["Title", lead.title],
    ["Company", lead.company],
    ["Website", lead.website],
    ["LinkedIn", lead.linkedin],
    ["City", lead.city],
    ["Notes", lead.notes],
    ...Object.entries(lead.custom ?? {}),
  ];
  return rows.filter(([, v]) => v && String(v).trim()).map(([k, v]) => `${k}: ${v}`).join("\n");
}

const LINE_SYSTEM = `You write the single personalised opening line of a B2B cold email.
Rules:
- 1 sentence, max 30 words. Plain text, no greeting, no sign-off, no quotes, no emojis.
- Refer to something specific about the person or company from the data given. Never invent facts, numbers, awards, news, launches, "recent pushes", expansions or initiatives that are not literally in the data.
- The sender's description is about the SENDER (you). Never describe the recipient using it.
- If the recipient data is thin (no company, title, website or notes), write a short, neutral, honest line that makes no claims about them at all.
- Do not start with the recipient's name — the greeting already uses it.
- Sound like a real person writing one email, not marketing copy. Avoid "I hope this finds you well", "I came across", "impressive", "game-changer".
- Output only the line.`;

/** Writes the {{ai_line}} for one lead. */
export async function generateLine(opts: { lead: TemplateLead; instructions: string; senderContext: string }): Promise<string> {
  const known = describeLead(opts.lead);
  const thin = !opts.lead.company && !opts.lead.title && !opts.lead.website && !opts.lead.notes && !Object.keys(opts.lead.custom ?? {}).length;
  const user = [
    opts.senderContext && `About the SENDER (me) and my offer — not the recipient:\n${opts.senderContext}`,
    opts.instructions && `Extra instructions:\n${opts.instructions}`,
    `RECIPIENT data (the only facts you may use about them):\n${known || `Email: ${opts.lead.email}`}${thin ? "\n(Very little is known about this recipient — make no claims about them.)" : ""}`,
  ].filter(Boolean).join("\n\n");
  const line = await chat({ system: LINE_SYSTEM, user, temperature: 0.5, maxTokens: 120 });
  return line.replace(/^["'“]+|["'”]+$/g, "").split("\n")[0].trim();
}

/** Drafts a sequence step from a short brief. */
export async function draftStep(opts: { brief: string; senderContext: string; stepNumber: number; isFollowUp: boolean }) {
  const system = `You write short, plain-text B2B cold emails that get replies.
Return JSON: {"subject": string, "body": string}.
- Body under 110 words. Short paragraphs separated by a blank line (\\n\\n). One clear, low-friction ask (a question, not a meeting link).
- Use these placeholders where natural: {{first_name|there}}, {{company}}, {{ai_line}} (a personalised opening line written separately — put it as the first line after the greeting in step 1), {{sender_name}}.
- Use spintax for the greeting, e.g. {Hi|Hey|Hello} {{first_name|there}},
- No links, no images, no "I hope this finds you well".
- ${opts.isFollowUp ? 'This is a follow-up in the same thread: subject must be "" (empty) so it threads as a reply. Keep it to 2-4 sentences and add something new.' : "Subject: 2-5 words, lowercase-ish, looks like a normal email between colleagues."}`;
  const user = [
    opts.senderContext && `Sender and offer:\n${opts.senderContext}`,
    `Step ${opts.stepNumber} brief:\n${opts.brief || "Write a good first-touch email."}`,
  ].filter(Boolean).join("\n\n");
  const raw = await chat({ system, user, temperature: 0.7, maxTokens: 600, json: true });
  const parsed = JSON.parse(raw) as { subject?: string; body?: string };
  return { subject: opts.isFollowUp ? "" : String(parsed.subject ?? ""), body: String(parsed.body ?? "") };
}

/** Classifies a reply. Falls back to "neutral" on any error so syncing never breaks. */
export async function classifyReply(text: string): Promise<"interested" | "not_interested" | "neutral"> {
  if (!env.groqKey) return "neutral";
  try {
    const raw = await chat({
      system: 'Classify a reply to a cold email. Return JSON {"label": "interested" | "not_interested" | "neutral"}. interested = wants to talk/learn more/asks pricing or a call. not_interested = no, not now, remove me, wrong person with no referral. neutral = anything else.',
      user: text.slice(0, 2000),
      temperature: 0,
      maxTokens: 30,
      pool: "research",
      json: true,
    });
    const label = JSON.parse(raw).label;
    return label === "interested" || label === "not_interested" ? label : "neutral";
  } catch {
    return "neutral";
  }
}
