// Email finder: a person's name + their company → their most likely work address.
//
// Evidence, strongest first:
//   1. The company's mail server confirms the mailbox (SMTP RCPT, port 25) on a domain that
//      does NOT accept every address.
//   2. The address has a public Gravatar profile (proves it exists — works on accept-all domains).
//   3. The exact address is published on the company's website.
//   4. The company's format, learned from (a) people + emails published together on its site,
//      (b) leads you already have there, (c) earlier lookups at the same company.
//   5. How common each format is across companies in general (the prior).
// Each candidate gets a confidence score with the evidence behind it.
import { randomBytes } from "node:crypto";
import { hasGravatar, crawlSitePeople, domainAgeDays, resolveCompanyDomain, type CompanyMatch } from "./email-intel";
import { canProbeSmtp, mxHosts, probeAny, providerFromMxHosts } from "./email-verify";
import { FREE_MAIL } from "./research";
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
  companyMatches: CompanyMatch[];
  provider: string | null;
  acceptAll: boolean | null;
  domainAgeDays: number | null;
  best: Candidate | null;
  candidates: Candidate[];
  method: "smtp" | "gravatar" | "website" | "pattern";
  verdict: "confirmed" | "likely" | "guess";
  learnedPattern: string | null;
  notes: string[];
}

type Name = { first: string; middle: string; last: string };

/** Share of companies using each format (rough industry averages) — the starting prior. */
const PATTERNS: { key: string; prior: number; make: (n: Name) => string | null }[] = [
  { key: "{first}.{last}", prior: 30, make: (n) => (n.last ? `${n.first}.${n.last}` : null) },
  { key: "{first}", prior: 20, make: (n) => n.first },
  { key: "{f}{last}", prior: 15, make: (n) => (n.last ? `${n.first[0]}${n.last}` : null) },
  { key: "{first}{last}", prior: 8, make: (n) => (n.last ? `${n.first}${n.last}` : null) },
  { key: "{f}.{last}", prior: 5, make: (n) => (n.last ? `${n.first[0]}.${n.last}` : null) },
  { key: "{first}_{last}", prior: 4, make: (n) => (n.last ? `${n.first}_${n.last}` : null) },
  { key: "{first}{l}", prior: 4, make: (n) => (n.last ? `${n.first}${n.last[0]}` : null) },
  { key: "{first}.{l}", prior: 3, make: (n) => (n.last ? `${n.first}.${n.last[0]}` : null) },
  { key: "{last}", prior: 3, make: (n) => n.last || null },
  { key: "{last}.{first}", prior: 2, make: (n) => (n.last ? `${n.last}.${n.first}` : null) },
  { key: "{last}{f}", prior: 2, make: (n) => (n.last ? `${n.last}${n.first[0]}` : null) },
  { key: "{first}-{last}", prior: 2, make: (n) => (n.last ? `${n.first}-${n.last}` : null) },
  { key: "{f}{l}", prior: 1, make: (n) => (n.last ? `${n.first[0]}${n.last[0]}` : null) },
  { key: "{f}{m}{last}", prior: 1, make: (n) => (n.last && n.middle ? `${n.first[0]}${n.middle[0]}${n.last}` : null) },
  { key: "{first}.{m}.{last}", prior: 1, make: (n) => (n.last && n.middle ? `${n.first}.${n.middle[0]}.${n.last}` : null) },
  { key: "{last}.{f}", prior: 1, make: (n) => (n.last ? `${n.last}.${n.first[0]}` : null) },
];

const clean = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");
const HONORIFIC = /^(dr|mr|mrs|ms|miss|prof|sir|er|ca|cs|adv|shri|smt|kumari|mx)\.?$/i;

/**
 * All sensible readings of a name. Indian names often end in initials ("Kavin N R", "K. Priya"),
 * so we also try the initials joined, the last initial alone, and initials-first forms.
 */
export function nameVariants(input: { name?: string; first?: string; last?: string }): Name[] {
  const raw = input.name?.trim() || [input.first, input.last].filter(Boolean).join(" ");
  const tokens = raw.replace(/[,()]/g, " ").split(/\s+/).filter((t) => t && !HONORIFIC.test(t));
  const parts = tokens.map((t) => clean(t)).filter(Boolean);
  if (!parts.length) return [];
  const isInitial = (t: string) => t.length === 1;
  const out: Name[] = [];
  const push = (first: string, middle: string, last: string) => {
    if (first && !out.some((n) => n.first === first && n.last === last && n.middle === middle)) out.push({ first, middle, last });
  };

  // Explicit first/last fields win.
  if (input.first && input.last && !input.name) {
    const f = clean(input.first.split(/\s+/)[0]);
    const lastTokens = input.last.split(/\s+/).map(clean).filter(Boolean);
    push(f, "", lastTokens.join(""));
    if (lastTokens.length > 1) push(f, lastTokens[0], lastTokens[lastTokens.length - 1]);
  }

  const words = parts.filter((p) => !isInitial(p));
  const initials = parts.filter(isInitial);
  if (parts.length === 1) push(parts[0], "", "");
  if (words.length >= 2) {
    push(words[0], words.length > 2 ? words[1] : initials[0] ?? "", words[words.length - 1]);
    if (words.length > 2) push(words[0], "", words.slice(1).join("")); // compound surnames
  }
  if (words.length === 1 && initials.length) {
    const w = words[0];
    if (parts[0] === w) {
      push(w, "", initials.join(""));                      // Kavin N R → kavin + nr
      push(w, initials[0], initials[initials.length - 1]);  // → kavin + r (middle n)
    } else {
      push(w, "", "");                                      // K. Priya → priya
      push(w, "", initials.join(""));                       // → priya + k
    }
  }
  if (!out.length && words[0]) push(words[0], "", "");
  return out.slice(0, 3);
}

/** Which format produced this local part for this person (null if none). */
function patternOf(local: string, n: Name): string | null {
  for (const p of PATTERNS) if (p.make(n) === local) return p.key;
  return null;
}

const ROLE_LOCAL = /^(info|admin|support|help|sales|contact|hello|hi|office|team|hr|jobs|careers|billing|accounts|finance|noreply|no-reply|marketing|press|media|enquiry|enquiries|inquiry|service|services|privacy|legal|partners?|investors?|ir|feedback|orders|webmaster|security|abuse|postmaster|grievance|compliance|customercare|care)$/;

/** Formats remembered from earlier confirmed lookups at the same company. */
async function rememberedPattern(domain: string): Promise<{ pattern: string; votes: number } | null> {
  const { data } = await db().from("app_state").select("value").eq("key", `pattern:${domain}`).maybeSingle();
  return (data?.value as { pattern: string; votes: number } | undefined) ?? null;
}

async function rememberPattern(domain: string, pattern: string) {
  const prev = await rememberedPattern(domain);
  const votes = prev?.pattern === pattern ? prev.votes + 1 : 1;
  await db().from("app_state").upsert({ key: `pattern:${domain}`, value: { pattern, votes }, updated_at: new Date().toISOString() });
}

export interface FindInput {
  name?: string;
  first?: string;
  last?: string;
  /** Company name, website, domain or any email at the company. */
  company?: string;
  domain?: string;
}

export async function findEmail(input: FindInput): Promise<FindResult | { ok: false; error: string }> {
  const variants = nameVariants(input);
  if (!variants.length) return { ok: false, error: "Enter the person's name" };
  const displayName = (input.name || [input.first, input.last].filter(Boolean).join(" ")).trim();

  const { domain, matches } = await resolveCompanyDomain(input.domain || input.company || "");
  if (!domain) return { ok: false, error: "Couldn't find that company — enter its website (e.g. acme.com)" };
  if (FREE_MAIL.has(domain)) return { ok: false, error: `${domain} is a personal email provider — enter the person's company instead` };

  const [mx, age, smtpOk] = await Promise.all([mxHosts(domain), domainAgeDays(domain), canProbeSmtp()]);
  if (!mx.length) return { ok: false, error: `${domain} doesn't receive email (no mail server). Check the company website.` };
  const provider = providerFromMxHosts(mx);
  const notes: string[] = [];
  if (age !== null && age < 60) notes.push(`${domain} was registered only ${age} days ago — new domains are often not real company mail.`);

  const score = new Map<string, number>(PATTERNS.map((p) => [p.key, p.prior]));
  const why = new Map<string, string[]>();
  const add = (key: string, pts: number, reason: string) => {
    score.set(key, (score.get(key) ?? 0) + pts);
    if (!why.get(key)?.includes(reason)) why.set(key, [...(why.get(key) ?? []), reason]);
  };

  // Everything that doesn't depend on ranking runs at the same time: the website crawl, the
  // mail-server check and Gravatar look-ups over every candidate address.
  const allCandidates = new Map<string, { pattern: string; variant: number }>();
  variants.forEach((n, vi) => {
    for (const p of PATTERNS) {
      const local = p.make(n);
      if (local && local.length >= 2 && !allCandidates.has(`${local}@${domain}`)) allCandidates.set(`${local}@${domain}`, { pattern: p.key, variant: vi });
    }
  });
  const emails = [...allCandidates.keys()].slice(0, 20);
  const fakes = [`zz${randomBytes(5).toString("hex")}@${domain}`, `qq.${randomBytes(4).toString("hex")}@${domain}`];
  const smtpTask = smtpOk
    ? (async () => {
        let probe = await probeAny(mx, [...fakes, ...emails]);
        // Greylisting ("try again later") — wait briefly and ask once more.
        if (probe.replies && [...probe.replies.values()].some((r) => r.code >= 400 && r.code < 500)) {
          await new Promise((r) => setTimeout(r, 12_000));
          probe = await probeAny(mx, [...fakes, ...emails]);
        }
        return probe;
      })().catch(() => ({ replies: null, refused: false }))
    : Promise.resolve(null);
  const [knownRes, site, remembered, probe, gravatars] = await Promise.all([
    db().from("leads").select("email, first_name, last_name").ilike("email", `%@${domain}`).limit(300),
    crawlSitePeople(domain).catch(() => [] as Awaited<ReturnType<typeof crawlSitePeople>>),
    rememberedPattern(domain).catch(() => null),
    smtpTask,
    Promise.all(emails.map((e) => hasGravatar(e))),
  ]);
  const gravatarHit = new Set(emails.filter((_, i) => gravatars[i]));

  // (a) People you already have at this company.
  for (const l of knownRes.data ?? []) {
    for (const n of nameVariants({ first: l.first_name ?? "", last: l.last_name ?? "" })) {
      const p = patternOf(l.email.split("@")[0], n);
      if (p) { add(p, 45, `Your leads at ${domain} use this format`); break; }
    }
  }
  // (b) Published on their website, paired with the name next to it.
  let siteMatches = 0;
  const personal = site.filter((s) => !ROLE_LOCAL.test(s.email.split("@")[0]));
  for (const s of personal) {
    const local = s.email.split("@")[0];
    if (s.nameNearby) {
      for (const n of nameVariants({ name: s.nameNearby })) {
        const p = patternOf(local, n);
        if (p) { add(p, 40, `${s.nameNearby} is listed as ${s.email} on their website`); siteMatches++; break; }
      }
    }
    // Shape-only hints when no name is next to the address.
    if (/^[a-z]+\.[a-z]+$/.test(local)) add("{first}.{last}", 6, `Their site lists ${s.email}`);
    else if (/^[a-z]\.[a-z]+$/.test(local)) add("{f}.{last}", 6, `Their site lists ${s.email}`);
    else if (/^[a-z]+_[a-z]+$/.test(local)) add("{first}_{last}", 6, `Their site lists ${s.email}`);
  }
  if (site.length) notes.push(`Read ${domain}'s website: ${site.length} published address${site.length === 1 ? "" : "es"}${personal.length ? `, ${personal.length} belonging to people` : " (all shared inboxes like info@)"}.`);
  // (c) Remembered from earlier confirmed lookups.
  if (remembered) add(remembered.pattern, 25 + Math.min(25, remembered.votes * 5), `Confirmed ${remembered.votes} time${remembered.votes === 1 ? "" : "s"} before at ${domain}`);

  // Candidates across all name readings (primary reading weighted highest).
  let candidates: Candidate[] = emails.map((email) => {
    const { pattern, variant } = allCandidates.get(email)!;
    return { email, pattern, confidence: (score.get(pattern) ?? 0) * (variant === 0 ? 1 : 0.6), evidence: [...(why.get(pattern) ?? [])], mailbox: "unknown" as const };
  });
  for (const c of candidates) {
    if (site.some((s) => s.email === c.email)) { c.confidence += 120; c.evidence.unshift("This exact address is published on their website"); }
  }
  const total = candidates.reduce((s, c) => s + c.confidence, 0) || 1;
  for (const c of candidates) c.confidence = Math.round((c.confidence / total) * 100);
  candidates.sort((a, b) => b.confidence - a.confidence);

  let method: FindResult["method"] = site.some((s) => s.email === candidates[0]?.email) ? "website" : "pattern";
  let acceptAll: boolean | null = null;

  // (1) The company's mail server (two random addresses detect accept-all domains).
  if (probe?.replies) {
    const replies = probe.replies;
    acceptAll = fakes.some((f) => (replies.get(f)?.code ?? 0) === 250);
    if (acceptAll) {
      notes.push(`${domain} accepts mail for any address, so its mail server can't tell which one is real — using other evidence.`);
    } else {
      for (const c of candidates) {
        const r = replies.get(c.email);
        if (!r) continue;
        if (r.code === 250 || r.code === 251) {
          c.mailbox = "exists"; c.confidence = 98; c.evidence.unshift("The company's mail server confirmed this mailbox exists");
          method = "smtp";
        } else if (r.code >= 500 && !/5\.7\.\d|spam|block|policy|reputation/i.test(r.text)) {
          c.mailbox = "missing"; c.confidence = 0;
        }
      }
    }
  } else if (probe) {
    notes.push(probe.refused
      ? `${provider ?? domain}'s mail server refuses checks from this internet connection — using other evidence. (It works when the app runs on a server.)`
      : `${domain}'s mail server didn't answer — using other evidence.`);
  } else {
    notes.push("This network can't ask mail servers whether a mailbox exists — using other evidence.");
  }

  // (2) Gravatar: independent proof that an address is real (works on accept-all domains).
  for (const c of candidates) {
    if (gravatarHit.has(c.email) && c.mailbox !== "missing") {
      if (c.mailbox !== "exists") { c.confidence = Math.max(c.confidence, 95); if (method !== "smtp") method = "gravatar"; }
      c.mailbox = "exists";
      c.evidence.unshift("This address has a public Gravatar profile, so it's real and in use");
    }
  }

  candidates = candidates.filter((c) => c.mailbox !== "missing").sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0] ?? null;
  // Nothing confirmed, but the company's format is well evidenced → a strong guess.
  if (best && best.mailbox !== "exists" && siteMatches >= 2) best.confidence = Math.max(best.confidence, 80);
  const verdict: FindResult["verdict"] = best?.mailbox === "exists" ? "confirmed" : best && best.confidence >= 60 ? "likely" : "guess";

  // Remember confirmed formats so the next lookup at this company is instant and accurate.
  if (best?.mailbox === "exists" && best.pattern) await rememberPattern(domain, best.pattern).catch(() => {});
  const learned = [...score.entries()].sort((a, b) => b[1] - a[1])[0];
  const learnedPattern = learned && (why.get(learned[0])?.length ?? 0) > 0 ? learned[0] : null;

  return {
    ok: true, name: displayName, domain, companyMatches: matches, provider, acceptAll, domainAgeDays: age,
    best, candidates: candidates.slice(0, 8), method, verdict, learnedPattern, notes,
  };
}
