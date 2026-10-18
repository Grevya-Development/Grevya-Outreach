// Free, legitimate signals used by the email finder and verifier:
//   • company name → domain (Clearbit's public autocomplete)
//   • Gravatar: a public profile for an address proves the address is real and in use
//   • domain age (RDAP) — brand-new domains are a risk signal
//   • people + emails published on the company's own website (team / about / press pages),
//     paired with the names printed next to them so the company's exact format can be learned
import { createHash } from "node:crypto";
import { fetchPublic } from "./research";

/* ───────────── company → domain ───────────── */

export interface CompanyMatch {
  name: string;
  domain: string;
}

/** "TVS Motor" → tvsmotor.com (+ alternatives). Accepts a domain/URL/email as-is. */
export async function resolveCompanyDomain(input: string): Promise<{ domain: string | null; matches: CompanyMatch[] }> {
  const s = input.trim().toLowerCase();
  if (!s) return { domain: null, matches: [] };
  // Looks like a domain, URL or email already.
  if (/^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+([/?#].*)?$/.test(s) || s.includes("@")) {
    const d = (s.includes("@") && !s.includes("/") ? s.split("@")[1] : s).replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#:]/)[0];
    return { domain: d, matches: [] };
  }
  try {
    const res = await fetch(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(input.trim())}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { domain: null, matches: [] };
    const matches = ((await res.json()) as { name: string; domain: string }[])
      .filter((m) => m.domain && !/^dan\.com/i.test(m.name) && !/godaddy brand|for sale/i.test(m.name))
      .slice(0, 5)
      .map((m) => ({ name: m.name, domain: m.domain.toLowerCase() }));
    // Prefer an exact name match, then .com / .in, then the first result.
    const exact = matches.find((m) => m.name.toLowerCase() === input.trim().toLowerCase());
    const preferred = exact ?? matches.find((m) => /\.(com|in|co\.in|io|ai)$/.test(m.domain)) ?? matches[0];
    return { domain: preferred?.domain ?? null, matches };
  } catch {
    return { domain: null, matches: [] };
  }
}

/* ───────────── Gravatar ───────────── */

const gravatarCache = new Map<string, Promise<boolean>>();

/**
 * True when the address has a public Gravatar (WordPress.com / Gravatar profile). That can only
 * happen if someone registered with this exact address — strong proof it's real, and it works
 * even on accept-all domains where mail servers won't say. Absence proves nothing.
 */
export function hasGravatar(email: string): Promise<boolean> {
  const e = email.trim().toLowerCase();
  let p = gravatarCache.get(e);
  if (!p) {
    const sha = createHash("sha256").update(e).digest("hex");
    p = fetch(`https://gravatar.com/avatar/${sha}?d=404&s=1`, { method: "GET", signal: AbortSignal.timeout(8000), redirect: "follow" })
      .then((r) => { r.body?.cancel().catch(() => {}); return r.status === 200; })
      .catch(() => false);
    gravatarCache.set(e, p);
    setTimeout(() => gravatarCache.delete(e), 60 * 60_000).unref?.();
  }
  return p;
}

/* ───────────── domain age ───────────── */

const ageCache = new Map<string, Promise<number | null>>();

/** Days since the domain was registered (null if unknown). */
export function domainAgeDays(domain: string): Promise<number | null> {
  let p = ageCache.get(domain);
  if (!p) {
    // rdap.org redirects to the registry's RDAP server; it rejects requests without a User-Agent.
    p = fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      headers: { Accept: "application/rdap+json", "User-Agent": "GrevyaOutreach/1.0 (+https://grevya.com)" },
      signal: AbortSignal.timeout(12_000), redirect: "follow",
    })
      .then(async (r) => {
        if (!r.ok) return null;
        const d = (await r.json()) as { events?: { eventAction: string; eventDate: string }[] };
        const reg = d.events?.find((e) => e.eventAction === "registration")?.eventDate;
        return reg ? Math.floor((Date.now() - new Date(reg).getTime()) / 86_400_000) : null;
      })
      .catch(() => null);
    ageCache.set(domain, p);
    setTimeout(() => ageCache.delete(domain), 24 * 60 * 60_000).unref?.();
  }
  return p;
}

/* ───────────── people & emails on the company website ───────────── */

export interface SitePerson {
  email: string;
  /** Name printed near the address on the page, if any (e.g. "Rahul Mehta, Head of Ops"). */
  nameNearby: string | null;
  page: string;
}

const PAGE_HINT = /(team|people|about|leadership|management|founders?|staff|contact|press|media|newsroom|board|directors?|our-story|who-we-are|careers|investors?|imprint|impressum)/i;
const NAME_RE = /\b([A-Z][a-z]{1,20}(?:\s+[A-Z]\.?)?(?:\s+[A-Z][a-z]{1,25}){1,2})\b/g;
const decode = (s: string) => s.replace(/&#64;|&#x40;|\[at\]|\(at\)|\s+at\s+(?=[a-z0-9-]+\s*(?:\.|dot))/gi, "@").replace(/\[dot\]|\(dot\)/gi, ".").replace(/&amp;/g, "&");

function visibleText(html: string): string {
  return html.replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
}

/** Candidate pages: sitemap entries that look like team/about/contact pages, plus common paths. */
async function candidatePages(domain: string): Promise<string[]> {
  const urls = new Set<string>(["", "/about", "/about-us", "/team", "/our-team", "/leadership", "/contact", "/contact-us", "/press", "/media"].map((p) => `https://${domain}${p}`));
  try {
    const { html } = await fetchPublic(`https://${domain}/sitemap.xml`, 2);
    let locs = [...html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
    // Sitemap index → read up to 3 child sitemaps.
    const children = locs.filter((l) => /\.xml(\?|$)/.test(l)).slice(0, 3);
    for (const c of children) {
      try {
        const { html: x } = await fetchPublic(c, 2);
        locs = locs.concat([...x.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]));
      } catch { /* skip */ }
    }
    for (const l of locs.filter((u) => !/\.xml(\?|$)/.test(u) && PAGE_HINT.test(new URL(u).pathname)).slice(0, 12)) urls.add(l);
  } catch { /* no sitemap */ }
  return [...urls].slice(0, 18);
}

/**
 * Crawls the company's site for published addresses at its domain, remembering the person name
 * printed closest to each address (same text window), so "Priya Sharma … priya.s@acme.com"
 * teaches us the format {first}.{l}.
 */
export async function crawlSitePeople(domain: string, budgetMs = 12_000): Promise<SitePerson[]> {
  const deadline = Date.now() + budgetMs;
  const pages = await Promise.race([candidatePages(domain), new Promise<string[]>((r) => setTimeout(() => r([`https://${domain}`, `https://${domain}/contact`, `https://${domain}/about`]), Math.min(5000, budgetMs / 2)))]);
  const emailRe = new RegExp(`[a-z0-9._%+-]+@(?:[a-z0-9-]+\\.)*${domain.replace(/\./g, "\\.")}\\b`, "gi");
  const found = new Map<string, SitePerson>();
  // Modest concurrency (polite to the site) and a hard time budget so a slow site never
  // holds up the lookup.
  for (let i = 0; i < pages.length && Date.now() < deadline; i += 6) {
    const remaining = Math.max(1000, deadline - Date.now());
    await Promise.race([new Promise((r) => setTimeout(r, remaining)), Promise.all(pages.slice(i, i + 6).map(async (url) => {
      try {
        const { html } = await fetchPublic(url, 2);
        const text = decode(visibleText(html));
        const raw = decode(html); // mailto: links live in attributes
        for (const m of new Set([...(raw.match(emailRe) ?? []), ...(text.match(emailRe) ?? [])].map((e) => e.toLowerCase()))) {
          if (found.has(m) && found.get(m)!.nameNearby) continue;
          // Name nearest to the address in the visible text (±160 chars).
          const at = text.toLowerCase().indexOf(m);
          let nameNearby: string | null = null;
          if (at >= 0) {
            const windowText = text.slice(Math.max(0, at - 160), at + m.length + 80);
            const names = [...windowText.matchAll(NAME_RE)].map((x) => x[1]).filter((n) => !/^(The|Our|Contact|Email|Phone|Call|Head|Office|Team|About|Press|Media|Sales|Support)\b/.test(n));
            nameNearby = names.length ? names[names.length - 1] : null;
          }
          found.set(m, { email: m, nameNearby, page: url });
        }
      } catch { /* page missing */ }
    }))]);
    if (found.size >= 40) break;
  }
  return [...found.values()];
}
