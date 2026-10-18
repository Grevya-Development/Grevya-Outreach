// Template rendering shared by the engine and the live preview (no server-only imports).
//
//   {{first_name}}            lead field
//   {{first_name|there}}      field with fallback when empty
//   {{ai_line}}               Groq-written personalised line
//   {Hi|Hello|Hey}            spintax — one option picked per lead, stable across retries

export interface TemplateLead {
  email: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  title?: string;
  website?: string;
  linkedin?: string;
  phone?: string;
  city?: string;
  notes?: string;
  custom?: Record<string, string>;
}

export interface TemplateContext {
  lead: TemplateLead;
  aiLine?: string;
  senderName?: string;
  signature?: string;
  unsubscribeUrl?: string;
  seed: string;
}

export const TEMPLATE_VARIABLES = [
  "first_name", "last_name", "full_name", "company", "title", "website",
  "city", "ai_line", "sender_name", "signature", "unsubscribe_url",
] as const;

const VAR_RE = /\{\{\s*([\w.-]+)\s*(?:\|([^}]*))?\}\}/g;
const SPIN_RE = /\{([^{}]*\|[^{}]*)\}/;

export function usesVariable(text: string, name: string): boolean {
  for (const m of text.matchAll(VAR_RE)) if (m[1] === name) return true;
  return false;
}

function vars(ctx: TemplateContext): Record<string, string> {
  const l = ctx.lead;
  const first = (l.first_name ?? "").trim();
  const v: Record<string, string> = {
    email: l.email,
    first_name: first ? first[0].toUpperCase() + first.slice(1) : "",
    last_name: l.last_name ?? "",
    full_name: [l.first_name, l.last_name].filter(Boolean).join(" "),
    company: l.company ?? "",
    title: l.title ?? "",
    website: l.website ?? "",
    linkedin: l.linkedin ?? "",
    phone: l.phone ?? "",
    city: l.city ?? "",
    notes: l.notes ?? "",
    ai_line: ctx.aiLine ?? "",
    sender_name: ctx.senderName ?? "",
    signature: ctx.signature ?? "",
    unsubscribe_url: ctx.unsubscribeUrl ?? "",
  };
  for (const [k, val] of Object.entries(l.custom ?? {})) {
    v[k] = String(val ?? "");
    v[`custom.${k}`] = String(val ?? "");
  }
  return v;
}

/** Deterministic PRNG so a lead always gets the same spintax choice. */
function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

export function render(template: string, ctx: TemplateContext): string {
  const v = vars(ctx);
  let out = template.replace(VAR_RE, (_, name: string, fallback?: string) => {
    const val = (v[name] ?? "").trim();
    return val || (fallback ?? "").trim();
  });
  const rand = rng(ctx.seed);
  // Resolve innermost spintax groups first so nesting works.
  for (let i = 0; i < 200 && SPIN_RE.test(out); i++) {
    out = out.replace(SPIN_RE, (_, group: string) => {
      const opts = group.split("|");
      return opts[Math.floor(rand() * opts.length)];
    });
  }
  // Tidy up blank lines left behind by empty variables (e.g. no ai_line).
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Variables used in a template that are empty for this lead (shown as warnings in preview). */
export function missingVariables(template: string, ctx: TemplateContext): string[] {
  const v = vars(ctx);
  const missing = new Set<string>();
  for (const m of template.matchAll(VAR_RE)) {
    if (m[2] === undefined && !(v[m[1]] ?? "").trim()) missing.add(m[1]);
  }
  return [...missing];
}
