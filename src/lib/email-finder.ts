// Email finder: name + company domain → the person's most likely address.
// Evidence, strongest first:
//   • the mail server confirms the mailbox (SMTP, when port 25 is reachable)
//   • Hunter.io's finder (when a key is set)
//   • the address is published on the company's website
//   • the company's email pattern, learned from leads you already have there or from
//     addresses published on its website
//   • how common each pattern is across companies in general
import { randomBytes } from "node:crypto";
import { canProbeSmtp, hunterEnabled, mxHosts, probeAny, providerFromMxHosts } from "./email-verify";
import { fetchPublic, FREE_MAIL } from "./research";
import { db } from "./supabase";

export interface Candidate {
  email: string;
  pattern: string;
  confidence: number; // 0–100
  evidence: string[];
  mailbox: "exists" | "missing" | "unknown";
}

export interface FindResult {
  ok: true;
  name: string;
  domain: string;
  provider: string | null;
  acceptAll: boolean | null;
  best: Candidate | null;
  candidates: Candidate[];
  method: "smtp" | "hunter" | "pattern";
  notes: string[];
}

/** Share of companies using each pattern (rough industry averages) — the starting prior. */
const PATTERNS: { key: string; prior: number; make: (f: string, l: string) => string | null }[] = [
  { key: "{first}.{last}", prior: 30, make: (f, l) => (l ? `${f}.${l}` : null) },
  { key: "{first}", prior: 20, make: (f) => f },
  { key: "{f}{last}", prior: 15, make: (f, l) => (l ? `${f[0]}${l}` : null) },
  { key: "{first}{last}", prior: 8, make: (f, l) => (l ? `${f}${l}` : null) },
  { key: "{f}.{last}", prior: 5, make: (f, l) => (l ? `${f[0]}.${l}` : null) },
  { key: "{first}_{last}", prior: 4, make: (f, l) => (l ? `${f}_${l}` : null) },
  { key: "{first}{l}", prior: 4, make: (f, l) => (l ? `${f}${l[0]}` : null) },
  { key: "{first}.{l}", prior: 3, make: (f, l) => (l ? `${f}.${l[0]}` : null) },
  { key: "{last}", prior: 3, make: (_f, l) => l || null },
  { key: "{last}.{first}", prior: 2, make: (f, l) => (l ? `${l}.${f}` : null) },
  { key: "{last}{f}", prior: 2, make: (f, l) => (l ? `${l}${f[0]}` : null) },
  { key: "{first}-{last}", prior: 2, make: (f, l) => (l ? `${f}-${l}` : null) },
  { key: "{f}{l}", prior: 1, make: (f, l) => (l ? `${f[0]}${l[0]}` : null) },
];

const clean = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");

/** "Dr. Priya K. Sharma" → { first: "priya", last: "sharma" } */
export function splitPersonName(full: string): { first: string; last: string } {
  const parts = full.replace(/\b(dr|mr|mrs|ms|prof|sir|er|ca|adv)\.?\s+/gi, " ").split(/[\s,]+/).map(clean).filter(Boolean);
  return { first: parts[0] ?? "", last: parts.length > 1 ? parts[parts.length - 1] : "" };
}

export function normaliseDomain(input: string): string {
  const s = input.trim().toLowerCase();
  const fromEmail = s.includes("@") && !s.includes("/") ? s.split("@")[1] : s;
  return fromEmail.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#:]/)[0];
}

/** Which pattern produced this local part for this person (null if none). */
function patternOf(local: string, first: string, last: string): string | null {
  const f = clean(first), l = clean(last);
  if (!f) return null;
  for (const p of PATTERNS) if (p.make(f, l) === local) return p.key;
  return null;
}

const ROLE_LOCAL = /^(info|admin|support|help|sales|contact|hello|office|team|hr|jobs|careers|billing|accounts|noreply|no-reply|marketing|press|media|enquiry|enquiries|service|privacy|legal|partners?|investors?|ir|feedback|orders)$/;

/** Emails at the domain published on its homepage / contact / about / team pages. */
async function websiteEmails(domain: string): Promise<string[]> {
  const found = new Set<string>();
  const re = new RegExp(`[a-z0-9._%+-]+@(?:[a-z0-9-]+\\.)*${domain.replace(/\./g, "\\.")}`, "gi");
  for (const path of ["", "/contact", "/contact-us", "/about", "/about-us", "/team", "/our-team", "/leadership"]) {
    try {
      const { html } = await fetchPublic(`https://${domain}${path}`, 2);
      for (const m of html.replace(/&#64;|\[at\]|\(at\)/gi, "@").match(re) ?? []) found.add(m.toLowerCase());
    } catch { /* page missing — fine */ }
    if (found.size >= 25) break;
  }
  return [...found];
}

async function hunterFind(domain: string, first: string, last: string): Promise<{ email: string; score: number } | null> {
  const key = process.env.HUNTER_API_KEY;
  if (!key || !first) return null;
  const url = `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(first)}&last_name=${encodeURIComponent(last)}&api_key=${key}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
  if (!res?.ok) return null;
  const d = (await res.json()).data as { email?: string; score?: number } | undefined;
  return d?.email ? { email: d.email.toLowerCase(), score: Number(d.score ?? 0) } : null;
}

export async function findEmail(input: { name?: string; first?: string; last?: string; domain: string }): Promise<FindResult | { ok: false; error: string }> {
  const split = input.name ? splitPersonName(input.name) : { first: clean(input.first ?? ""), last: clean(input.last ?? "") };
  const first = input.first ? clean(input.first) : split.first;
  const last = input.last ? clean(input.last) : split.last;
  const domain = normaliseDomain(input.domain);
  const name = [input.first ?? "", input.last ?? ""].join(" ").trim() || input.name || "";
  if (!first) return { ok: false, error: "Enter at least a first name" };
  if (!domain.includes(".")) return { ok: false, error: "Enter the company's website or domain (e.g. acme.com)" };
  if (FREE_MAIL.has(domain)) return { ok: false, error: `${domain} is a personal email provider — enter the person's company domain instead` };

  const mx = await mxHosts(domain);
  if (!mx.length) return { ok: false, error: `${domain} doesn't receive email (no mail server found). Check the domain.` };
  const provider = providerFromMxHosts(mx);
  const notes: string[] = [];

  // Start from general priors.
  const scores = new Map<string, number>(PATTERNS.map((p) => [p.key, p.prior]));
  const evidence = new Map<string, string[]>();
  const add = (key: string, pts: number, why: string) => {
    scores.set(key, (scores.get(key) ?? 0) + pts);
    evidence.set(key, [...(evidence.get(key) ?? []), why]);
  };

  // 1) Learn the pattern from people you already have at this company.
  const { data: known } = await db().from("leads").select("email, first_name, last_name").ilike("email", `%@${domain}`).limit(200);
  const learned = new Map<string, number>();
  for (const l of known ?? []) {
    const p = patternOf(l.email.split("@")[0], l.first_name ?? "", l.last_name ?? "");
    if (p) learned.set(p, (learned.get(p) ?? 0) + 1);
  }
  for (const [p, n] of learned) add(p, 40 + n * 10, `${n} of your leads at ${domain} use this format`);

  // 2) Addresses published on their website.
  const published = await websiteEmails(domain).catch(() => [] as string[]);
  const personal = published.filter((e) => !ROLE_LOCAL.test(e.split("@")[0]));
  const directHit = published.find((e) => patternOf(e.split("@")[0], first, last));
  if (directHit) add(patternOf(directHit.split("@")[0], first, last)!, 80, "This exact address appears on their website");
  for (const e of personal) {
    const local = e.split("@")[0];
    if (/^[a-z]+\.[a-z]+$/.test(local)) add("{first}.{last}", 12, `Their site lists ${e} (first.last style)`);
    else if (/^[a-z]\.[a-z]+$/.test(local)) add("{f}.{last}", 12, `Their site lists ${e}`);
    else if (/^[a-z]+_[a-z]+$/.test(local)) add("{first}_{last}", 12, `Their site lists ${e}`);
  }
  if (published.length) notes.push(`Found ${published.length} address${published.length === 1 ? "" : "es"} on ${domain}${personal.length ? "" : " (all shared/role addresses)"}.`);

  // Build candidates.
  let candidates: Candidate[] = [];
  for (const p of PATTERNS) {
    const local = p.make(first, last);
    if (local) candidates.push({ email: `${local}@${domain}`, pattern: p.key, confidence: 0, evidence: evidence.get(p.key) ?? [], mailbox: "unknown" });
  }
  const total = [...scores.values()].reduce((a, b) => a + b, 0) || 1;
  for (const c of candidates) c.confidence = Math.round(((scores.get(c.pattern) ?? 0) / total) * 100);
  candidates.sort((a, b) => b.confidence - a.confidence);

  let method: FindResult["method"] = "pattern";
  let acceptAll: boolean | null = null;

  // 3) Hunter.io, if configured.
  if (hunterEnabled()) {
    const h = await hunterFind(domain, first, last);
    if (h) {
      const hit = candidates.find((c) => c.email === h.email);
      if (hit) { hit.confidence = Math.max(hit.confidence, h.score); hit.evidence.unshift(`Hunter.io found it (score ${h.score})`); }
      else candidates.unshift({ email: h.email, pattern: "hunter", confidence: h.score, evidence: [`Hunter.io found it (score ${h.score})`], mailbox: "unknown" });
      method = "hunter";
    }
  }

  // 4) Ask the mail server (strongest evidence), when port 25 works.
  if (await canProbeSmtp()) {
    try {
      const top = candidates.slice(0, 8);
      const fake = `zz${randomBytes(6).toString("hex")}@${domain}`;
      const probe = await probeAny(mx, [fake, ...top.map((c) => c.email)]);
      if (!probe.replies) throw new Error(probe.refused ? "refused" : "no answer");
      const replies = probe.replies;
      acceptAll = (replies.get(fake)?.code ?? 0) === 250;
      if (acceptAll) {
        notes.push(`${domain} accepts every address (accept-all), so the mail server can't confirm which one is right — the best guess is based on patterns.`);
      } else {
        for (const c of top) {
          const r = replies.get(c.email);
          if (!r) continue;
          if (r.code === 250 || r.code === 251) { c.mailbox = "exists"; c.confidence = 97; c.evidence.unshift("The mail server confirmed this mailbox exists"); method = "smtp"; }
          else if (r.code >= 500 && !/5\.7\.\d|spam|block|policy/i.test(r.text)) { c.mailbox = "missing"; c.confidence = 1; }
        }
      }
    } catch (err) {
      notes.push((err as Error).message === "refused"
        ? `${provider ?? domain}'s mail server blocks verification checks from your current internet connection, so the best guess is ranked by pattern. A free Hunter.io key (HUNTER_API_KEY) can confirm it.`
        : "The company's mail server didn't respond to the mailbox check — ranked by pattern instead.");
    }
  } else {
    notes.push("Mailbox confirmation needs outgoing port 25, which this network blocks. Results are ranked by evidence instead" +
      (hunterEnabled() ? "." : " — add a free Hunter.io key (HUNTER_API_KEY) or run the app on a server to confirm addresses."));
  }

  candidates = candidates.filter((c) => c.mailbox !== "missing").sort((a, b) => b.confidence - a.confidence);
  return { ok: true, name, domain, provider, acceptAll, best: candidates[0] ?? null, candidates: candidates.slice(0, 8), method, notes };
}
