// Company research: fetch a prospect's website, extract readable text and tech signals,
// then have Groq summarise what they do and where our services fit. Cached per domain.
import { lookup as dnsLookup } from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";
import { isIP } from "node:net";
import { chat, parseJson } from "./groq";
import { db } from "./supabase";

export const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.in", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "rediffmail.com", "zoho.com", "zohomail.in", "gmx.com",
  "yandex.com", "mail.com", "outlook.in", "hotmail.co.uk", "hotmail.in", "live.in", "live.co.uk", "ymail.com", "rocketmail.com",
  "yahoo.co.uk", "aim.com", "pm.me", "tutanota.com", "fastmail.com", "hey.com", "mail.ru", "qq.com", "163.com", "naver.com",
]);

/** Profile/aggregator sites: a "website" on these says nothing about the lead's own company. */
const NOT_A_COMPANY_SITE = new Set([
  "linkedin.com", "in.linkedin.com", "facebook.com", "fb.com", "instagram.com", "twitter.com", "x.com", "youtube.com", "tiktok.com",
  "medium.com", "github.com", "angel.co", "wellfound.com", "crunchbase.com", "glassdoor.com", "glassdoor.co.in", "indeed.com",
  "naukri.com", "justdial.com", "indiamart.com", "tracxn.com", "zaubacorp.com", "google.com", "sites.google.com", "linktr.ee",
  "wa.me", "t.me", "behance.net", "dribbble.com", "notion.site", "substack.com", "wix.com", "wordpress.com", "blogspot.com",
]);

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const MAX_BYTES = 1_500_000;
const MAX_TEXT = 6000;
const STALE_DAYS = 30;

export interface Analysis {
  company_name: string;
  what_they_do: string;
  industry: string;
  business_model: string;
  customers: string;
  facts: string[];          // only things stated on their site
  likely_needs: string[];   // inferred, clearly marked as inference
  best_service: string;     // which of our services fits best
  fit_score: number;        // 0-10
  fit_reason: string;
  angle: string;            // one-sentence hook for the email
  confidence: "low" | "medium" | "high";
}

export interface Research {
  domain: string;
  status: "ok" | "failed";
  source: string | null;
  url: string | null;
  title: string;
  description: string;
  content: string;
  tech: string[];
  analysis: Analysis | null;
  error: string | null;
  fetched_at: string;
  analyzed_at: string | null;
}

/** Picks the domain to research for a lead: website first, else the email domain (unless free mail). */
export function leadDomain(lead: { email: string; website?: string }): string | null {
  const fromSite = (lead.website ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  const isProfileSite = [...NOT_A_COMPANY_SITE].some((d) => fromSite === d || fromSite.endsWith(`.${d}`));
  if (fromSite && fromSite.includes(".") && !FREE_MAIL.has(fromSite) && !isProfileSite) return fromSite;
  const fromEmail = lead.email.split("@")[1]?.toLowerCase().trim();
  if (fromEmail && !FREE_MAIL.has(fromEmail)) return fromEmail;
  return null;
}

/* ───────────── safe fetching (no SSRF into private networks) ───────────── */

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("64:ff9b:")) return true;
    const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateIp(mapped[1]) : false;
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/**
 * HTTP agent whose DNS lookup rejects private addresses. Because the check happens on the
 * address actually used for the connection, a domain can't pass the check and then switch
 * its DNS to an internal IP (DNS rebinding).
 */
const publicOnly = new Agent({
  connect: {
    lookup: (hostname, options, callback) => {
      if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(hostname)) {
        return callback(new Error("private host"), "", 4);
      }
      dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err, "", 4);
        const list = addresses as { address: string; family: number }[];
        const safe = list.filter((a) => !isPrivateIp(a.address));
        if (!safe.length || safe.length !== list.length) return callback(new Error("private or unresolvable host"), "", 4);
        if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof safe) => void)(null, safe);
        callback(null, safe[0].address, safe[0].family);
      });
    },
  },
  headersTimeout: 12_000,
  bodyTimeout: 12_000,
});

export async function fetchPublic(url: string, redirects = 4): Promise<{ url: string; html: string }> {
  let current = url;
  for (let i = 0; i <= redirects; i++) {
    const u = new URL(current);
    if (!/^https?:$/.test(u.protocol) || (u.port && !["80", "443"].includes(u.port))) throw new Error("blocked URL");
    if (isIP(u.hostname) && isPrivateIp(u.hostname)) throw new Error("private host");
    const res = await undiciFetch(u, {
      dispatcher: publicOnly,
      redirect: "manual",
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", "Accept-Language": "en-IN,en;q=0.9" },
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, u).toString();
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!(res.headers.get("content-type") ?? "").includes("html")) throw new Error("not an HTML page");
    // Read at most MAX_BYTES.
    const reader = res.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    reader.cancel().catch(() => {});
    return { url: current, html: new TextDecoder().decode(Buffer.concat(chunks)) };
  }
  throw new Error("too many redirects");
}

/* ───────────── extraction ───────────── */

const decode = (s: string) =>
  s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

function meta(html: string, name: string): string {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0] ?? "";
  return decode(tag.match(/content=["']([^"']*)["']/i)?.[1] ?? "").trim();
}

export function extractText(html: string): string {
  return decode(
    html
      .replace(/<(script|style|noscript|svg|iframe|template)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|section|li|h[1-6]|br|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

const TECH: [string, RegExp][] = [
  ["Shopify", /cdn\.shopify\.com|Shopify\.theme/i],
  ["WooCommerce", /woocommerce/i],
  ["WordPress", /wp-content|wp-includes/i],
  ["Wix", /static\.wixstatic\.com|wix\.com/i],
  ["Webflow", /webflow\.(com|io)|data-wf-page/i],
  ["Framer", /framerusercontent|framer\.com/i],
  ["Next.js", /__NEXT_DATA__|\/_next\/static/i],
  ["React", /data-reactroot|react-dom/i],
  ["HubSpot", /js\.hs-scripts\.com|hubspot/i],
  ["Salesforce", /salesforce|force\.com|pardot/i],
  ["Zoho", /zoho(cdn|salesiq)|salesiq\.zoho/i],
  ["Intercom", /widget\.intercom\.io|intercomSettings/i],
  ["Freshworks", /freshchat|freshdesk|freshworks/i],
  ["Zendesk", /zdassets|zendesk/i],
  ["Drift", /js\.driftt\.com/i],
  ["WhatsApp chat", /wa\.me\/|api\.whatsapp\.com/i],
  ["Meta Pixel", /connect\.facebook\.net\/[^"']*fbevents|fbq\(/i],
  ["Google Ads", /googleadservices|gtag\([^)]*['"]AW-/i],
  ["Google Analytics", /googletagmanager\.com\/gtag|google-analytics\.com|G-[A-Z0-9]{6,}/],
  ["Google Tag Manager", /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]+/],
  ["LinkedIn Insight", /snap\.licdn\.com/i],
  ["Hotjar", /static\.hotjar\.com/i],
  ["Clarity", /clarity\.ms/i],
  ["Razorpay", /checkout\.razorpay\.com/i],
  ["Stripe", /js\.stripe\.com/i],
  ["Careers page", /href=["'][^"']*(careers|jobs)[^"']*["']/i],
  ["Chatbot", /chatbot|tidio|crisp\.chat|landbot|yellow\.ai|haptik/i],
];

function detectTech(html: string): string[] {
  return TECH.filter(([, re]) => re.test(html)).map(([n]) => n);
}

/** Free JS-rendering fallback for single-page apps (20 requests/min without a key). */
async function readerFetch(url: string): Promise<string> {
  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers: { "X-Return-Format": "text", "X-Remove-Selector": "style, script, nav, footer, header" },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`reader HTTP ${res.status}`);
  return (await res.text())
    .replace(/:host[^{]*\{[^}]*\}/g, " ")          // stray shadow-DOM CSS
    .replace(/[^\n]*\{[^}\n]*:[^}\n]*\}[^\n]*/g, " ") // other inline CSS rules
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** Fetches and extracts a domain's homepage (+ about page when the homepage is thin). */
export async function crawl(domain: string): Promise<Omit<Research, "analysis" | "analyzed_at" | "fetched_at" | "error" | "status"> & { status: "ok" }> {
  let page: { url: string; html: string } | null = null;
  let lastErr: Error | null = null;
  for (const u of [`https://${domain}`, `https://www.${domain}`, `http://${domain}`]) {
    try {
      page = await fetchPublic(u);
      break;
    } catch (e) {
      lastErr = e as Error;
    }
  }

  let title = "", description = "", content = "", tech: string[] = [], source = "direct", url = `https://${domain}`;
  if (page) {
    url = page.url;
    title = decode(page.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
    description = meta(page.html, "description") || meta(page.html, "og:description");
    content = extractText(page.html);
    tech = detectTech(page.html);
    if (content.length < 1500) {
      // Thin homepage — try an about page too.
      for (const path of ["/about", "/about-us"]) {
        try {
          const about = await fetchPublic(new URL(path, page.url).toString(), 2);
          const t = extractText(about.html);
          if (t.length > 200) { content += `\n\n[About page]\n${t}`; break; }
        } catch { /* optional */ }
      }
    }
  }
  if (content.length < 400) {
    try {
      const rendered = await readerFetch(url);
      if (rendered.length > content.length) { content = rendered; source = page ? "direct+reader" : "reader"; }
    } catch (e) {
      if (!page) throw lastErr ?? e;
    }
  }
  if (!page && !content) throw lastErr ?? new Error("site unreachable");
  return { domain, status: "ok", source, url, title, description, content: content.slice(0, MAX_TEXT), tech };
}

/* ───────────── analysis ───────────── */

export interface CompanyProfile {
  name: string;
  website: string;
  one_liner: string;
  services: string;
  proof: string;
  ideal_customer: string;
  cta: string;
  tone: string;
  sender_name: string;
  sender_title: string;
  address: string;
}

export const EMPTY_PROFILE: CompanyProfile = {
  name: "", website: "", one_liner: "", services: "", proof: "", ideal_customer: "", cta: "", tone: "", sender_name: "", sender_title: "", address: "",
};

export function profileText(p: CompanyProfile): string {
  return [
    p.name && `Company: ${p.name}${p.website ? ` (${p.website})` : ""}`,
    p.one_liner && `What we do: ${p.one_liner}`,
    p.services && `Services:\n${p.services}`,
    p.proof && `Proof / results we can cite (only these numbers are allowed):\n${p.proof}`,
    p.ideal_customer && `Ideal customer: ${p.ideal_customer}`,
  ].filter(Boolean).join("\n");
}

const ANALYZE_SYSTEM = `You are a B2B sales researcher. From a prospect's website text, produce a factual brief for a cold email.
Return JSON with exactly these keys:
{"company_name": string, "what_they_do": string (1 sentence), "industry": string, "business_model": string,
 "customers": string, "facts": string[] (2-5 concrete facts stated on the site: products, markets, clients, numbers, launches),
 "likely_needs": string[] (2-3 inferred needs where OUR services could help; phrase as inferences),
 "best_service": string (which of OUR services fits best, using our wording), "fit_score": integer 0-10,
 "fit_reason": string, "angle": string (one specific, non-generic hook connecting a fact about them to our best service — never claim we have worked with similar companies unless our proof says so),
 "confidence": "low" | "medium" | "high"}
Rules: facts must come from the website text only — never invent. If the text is thin, say so, keep facts empty and confidence low.
fit_score: 8-10 clear need + right size/industry for us; 4-7 plausible; 0-3 poor fit (e.g. competitor, tiny, unrelated).`;

export async function analyze(r: Pick<Research, "domain" | "title" | "description" | "content" | "tech">, profile: CompanyProfile, model?: string): Promise<Analysis> {
  const user = [
    `OUR COMPANY (the sender):\n${profileText(profile) || "(not provided)"}`,
    `PROSPECT DOMAIN: ${r.domain}`,
    r.title && `Page title: ${r.title}`,
    r.description && `Meta description: ${r.description}`,
    r.tech.length ? `Detected on their site: ${r.tech.join(", ")}` : "",
    `Website text:\n${r.content.slice(0, 4500) || "(empty)"}`,
  ].filter(Boolean).join("\n\n");
  const raw = await chat({ system: ANALYZE_SYSTEM, user, temperature: 0.2, maxTokens: 700, json: true, model, pool: "research" });
  const a = parseJson<Partial<Analysis>>(raw);
  return {
    company_name: String(a.company_name ?? ""),
    what_they_do: String(a.what_they_do ?? ""),
    industry: String(a.industry ?? ""),
    business_model: String(a.business_model ?? ""),
    customers: String(a.customers ?? ""),
    facts: Array.isArray(a.facts) ? a.facts.map(String).slice(0, 6) : [],
    likely_needs: Array.isArray(a.likely_needs) ? a.likely_needs.map(String).slice(0, 4) : [],
    best_service: String(a.best_service ?? ""),
    fit_score: Math.max(0, Math.min(10, Math.round(Number(a.fit_score) || 0))),
    fit_reason: String(a.fit_reason ?? ""),
    angle: String(a.angle ?? ""),
    confidence: a.confidence === "high" || a.confidence === "medium" ? a.confidence : "low",
  };
}

/**
 * Returns research for a domain, using the cache when fresh. Crawl failures are cached too
 * (shorter) so a dead site isn't re-fetched for every lead at that company.
 */
export async function researchDomain(domain: string, profile: CompanyProfile, opts: { force?: boolean; model?: string } = {}): Promise<Research> {
  const supa = db();
  const { data: cached } = await supa.from("company_research").select("*").eq("domain", domain).maybeSingle();
  const age = cached ? Date.now() - new Date(cached.fetched_at).getTime() : Infinity;
  const fresh = cached && (cached.status === "ok" ? age < STALE_DAYS * 86_400_000 : age < 3 * 86_400_000);
  if (fresh && !opts.force && (cached.status === "failed" || cached.analysis)) return cached as Research;

  let base: Omit<Research, "analysis" | "analyzed_at">;
  if (fresh && !opts.force && cached.status === "ok") {
    base = cached as Research;
  } else {
    try {
      base = { ...(await crawl(domain)), error: null, fetched_at: new Date().toISOString() };
    } catch (e) {
      const failed: Research = {
        domain, status: "failed", source: null, url: null, title: "", description: "", content: "", tech: [],
        analysis: null, error: (e as Error).message.slice(0, 300), fetched_at: new Date().toISOString(), analyzed_at: null,
      };
      await supa.from("company_research").upsert(failed);
      return failed;
    }
  }
  const analysis = await analyze(base, profile, opts.model);
  const row: Research = { ...base, analysis, analyzed_at: new Date().toISOString() };
  await supa.from("company_research").upsert(row);
  return row;
}

/** Drafts our own company profile from our website (Settings → Import from website). */
export async function draftProfileFromWebsite(website: string): Promise<Partial<CompanyProfile>> {
  const domain = leadDomain({ email: "x@x", website });
  if (!domain) throw new Error("Enter a valid website");
  const r = await crawl(domain);
  const raw = await chat({
    system: `From a company's own website, draft its sales profile. Return JSON:
{"name": string, "one_liner": string (what we do, 1 sentence), "services": string (bullet list, one service per line starting with "- "),
 "proof": string (bullet list of concrete results/numbers/clients stated on the site; empty if none), "ideal_customer": string,
 "cta": string (a low-friction yes/no question for a cold email — NOT a meeting or call request, e.g. "Worth a quick look?")}
Use only what the website says. Do not invent results.`,
    user: `Website: ${r.url}\nTitle: ${r.title}\nDescription: ${r.description}\n\n${r.content.slice(0, 5000)}`,
    temperature: 0.2, maxTokens: 900, json: true,
  });
  const p = parseJson<Partial<CompanyProfile>>(raw);
  return { ...p, website: r.url ?? website };
}
