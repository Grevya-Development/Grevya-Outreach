// "Find emails by company" (company-wide search): everything we can legitimately learn about
// a company's addresses — people published on its own website, leads you already have there,
// the email format the company uses, and the mail setup — in one call.
import { crawlSitePeople, domainAgeDays, resolveCompanyDomain, type CompanyMatch } from "./email-intel";
import { nameVariants } from "./email-finder";
import { canProbeSmtp, mxHosts, providerFromMxHosts } from "./email-verify";
import { FREE_MAIL } from "./research";
import { db } from "./supabase";

export interface DomainPerson {
  email: string;
  name: string | null;
  source: "website" | "your leads";
  page?: string;
  /** Role inboxes (info@, sales@) are listed separately from people. */
  role: boolean;
}

export interface DomainSearchResult {
  ok: true;
  domain: string;
  companyMatches: CompanyMatch[];
  provider: string | null;
  domainAgeDays: number | null;
  acceptsMail: boolean;
  /** Most likely email format, e.g. "{first}.{last}", with how sure we are and why. */
  pattern: { key: string; example: string; confidence: number; evidence: string[] } | null;
  people: DomainPerson[];
  roleInboxes: DomainPerson[];
  notes: string[];
}

const ROLE = /^(info|admin|support|help|sales|contact|hello|hi|office|team|hr|jobs|careers|billing|accounts|finance|noreply|no-reply|marketing|press|media|enquiry|enquiries|inquiry|service|services|privacy|legal|partners?|investors?|ir|feedback|orders|webmaster|security|abuse|postmaster|grievance|compliance|customercare|care)$/;

const PATTERN_EXAMPLE: Record<string, (d: string) => string> = {
  "{first}.{last}": (d) => `priya.sharma@${d}`,
  "{first}": (d) => `priya@${d}`,
  "{f}{last}": (d) => `psharma@${d}`,
  "{first}{last}": (d) => `priyasharma@${d}`,
  "{f}.{last}": (d) => `p.sharma@${d}`,
  "{first}_{last}": (d) => `priya_sharma@${d}`,
  "{first}{l}": (d) => `priyas@${d}`,
  "{first}.{l}": (d) => `priya.s@${d}`,
  "{last}": (d) => `sharma@${d}`,
  "{last}.{first}": (d) => `sharma.priya@${d}`,
  "{last}{f}": (d) => `sharmap@${d}`,
  "{first}-{last}": (d) => `priya-sharma@${d}`,
  "{f}{l}": (d) => `ps@${d}`,
};

/** Which known format produced this local part for this name (shared with the finder's table). */
function formatOf(local: string, name: string): string | null {
  for (const n of nameVariants({ name })) {
    const f = n.first, l = n.last, fi = f[0] ?? "", li = l[0] ?? "";
    const table: [string, string | null][] = [
      ["{first}.{last}", l ? `${f}.${l}` : null], ["{first}", f], ["{f}{last}", l ? `${fi}${l}` : null], ["{first}{last}", l ? `${f}${l}` : null],
      ["{f}.{last}", l ? `${fi}.${l}` : null], ["{first}_{last}", l ? `${f}_${l}` : null], ["{first}{l}", l ? `${f}${li}` : null],
      ["{first}.{l}", l ? `${f}.${li}` : null], ["{last}", l || null], ["{last}.{first}", l ? `${l}.${f}` : null], ["{last}{f}", l ? `${l}${fi}` : null],
      ["{first}-{last}", l ? `${f}-${l}` : null], ["{f}{l}", l ? `${fi}${li}` : null],
    ];
    const hit = table.find(([, v]) => v === local);
    if (hit) return hit[0];
  }
  return null;
}

export async function searchDomain(input: string): Promise<DomainSearchResult | { ok: false; error: string }> {
  const { domain, matches } = await resolveCompanyDomain(input);
  if (!domain) return { ok: false, error: "Couldn't find that company — enter its website (e.g. acme.com)" };
  if (FREE_MAIL.has(domain)) return { ok: false, error: `${domain} is a personal email provider, not a company` };

  const [mx, age, site, known, remembered] = await Promise.all([
    mxHosts(domain),
    domainAgeDays(domain),
    crawlSitePeople(domain, 15_000).catch(() => []),
    db().from("leads").select("email, first_name, last_name").ilike("email", `%@${domain}`).limit(300).then((r) => r.data ?? []),
    db().from("app_state").select("value").eq("key", `pattern:${domain}`).maybeSingle().then((r) => (r.data?.value as { pattern: string; votes: number } | undefined) ?? null),
  ]);
  const notes: string[] = [];
  if (age !== null && age < 60) notes.push(`${domain} was registered only ${age} days ago.`);
  if (!mx.length) notes.push(`${domain} has no mail server — it can't receive email.`);

  // People: website first, then your leads (deduped by address).
  const people = new Map<string, DomainPerson>();
  for (const s of site) {
    people.set(s.email, { email: s.email, name: s.nameNearby, source: "website", page: s.page, role: ROLE.test(s.email.split("@")[0]) });
  }
  for (const l of known) {
    const name = [l.first_name, l.last_name].filter(Boolean).join(" ") || null;
    const prev = people.get(l.email);
    if (prev) { if (!prev.name && name) prev.name = name; continue; }
    people.set(l.email, { email: l.email, name, source: "your leads", role: ROLE.test(l.email.split("@")[0]) });
  }

  // Format: vote from every (name, email) pair we have, plus remembered confirmations.
  const votes = new Map<string, { n: number; why: string[] }>();
  for (const p of people.values()) {
    if (p.role || !p.name) continue;
    const f = formatOf(p.email.split("@")[0], p.name);
    if (!f) continue;
    const v = votes.get(f) ?? { n: 0, why: [] };
    v.n += 1;
    if (v.why.length < 3) v.why.push(`${p.name} → ${p.email}${p.source === "website" ? " (on their website)" : " (in your leads)"}`);
    votes.set(f, v);
  }
  if (remembered) {
    const v = votes.get(remembered.pattern) ?? { n: 0, why: [] };
    v.n += remembered.votes;
    v.why.push(`Confirmed ${remembered.votes} time${remembered.votes === 1 ? "" : "s"} in earlier lookups`);
    votes.set(remembered.pattern, v);
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1].n - a[1].n);
  const totalVotes = ranked.reduce((s, [, v]) => s + v.n, 0);
  const top = ranked[0];
  const pattern = top
    ? { key: top[0], example: (PATTERN_EXAMPLE[top[0]] ?? ((d: string) => `?@${d}`))(domain), confidence: Math.round(Math.min(97, 50 + (top[1].n / Math.max(1, totalVotes)) * 30 + Math.min(17, top[1].n * 4))), evidence: top[1].why }
    : null;
  if (!pattern) notes.push("No named addresses found on the website or in your leads yet — use “Find by name” and the first confirmed result teaches the format.");
  if (!(await canProbeSmtp())) notes.push("This network can't ask mail servers whether a mailbox exists, so results here come from the website and your data.");

  const all = [...people.values()];
  return {
    ok: true, domain, companyMatches: matches, provider: providerFromMxHosts(mx), domainAgeDays: age, acceptsMail: mx.length > 0,
    pattern, people: all.filter((p) => !p.role), roleInboxes: all.filter((p) => p.role), notes,
  };
}
