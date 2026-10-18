// E-mail verification: layered checks from cheapest to most certain.
//   1. syntax + typo suggestions          (instant)
//   2. domain: MX records, provider, disposable / role / free-mail
//   3. mailbox: ask the recipient's mail server (SMTP RCPT TO, port 25) whether the address
//      exists, and whether the domain accepts *any* address ("accept-all"). Many home/office
//      networks block port 25 — then we fall back to Hunter.io (if a key is set) or report
//      "domain OK, mailbox not checked".
import { randomBytes } from "node:crypto";
import { resolveMx, resolve4 } from "node:dns/promises";
import net from "node:net";
import { db } from "./supabase";

export type VerifyStatus = "valid" | "invalid" | "risky" | "unknown";

export interface VerifyResult {
  email: string;
  status: VerifyStatus;
  score: number; // 0–100, how likely an email will be delivered to a real inbox
  reason: string; // one-line, plain-English verdict
  suggestion?: string; // "did you mean …?"
  provider: string | null;
  checks: {
    syntax: boolean;
    domain: boolean;
    disposable: boolean;
    role: boolean;
    freeMail: boolean;
    acceptAll: boolean | null;
    mailbox: "exists" | "missing" | "unknown" | null;
  };
  source: "smtp" | "hunter" | "dns" | "cache";
  checkedAt: string;
}

const SYNTAX = /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}$/;
const ROLE = /^(info|admin|administrator|support|help|sales|contact|contactus|hello|hi|office|team|hr|jobs|careers|billing|accounts|finance|noreply|no-reply|donotreply|webmaster|marketing|media|press|enquiry|enquiries|inquiry|service|services|mail|postmaster|abuse|security|privacy|legal|feedback|orders|ops|operations|it)@/;
const FREE = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.in", "ymail.com", "rocketmail.com", "outlook.com", "outlook.in",
  "hotmail.com", "hotmail.co.uk", "live.com", "live.in", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me",
  "protonmail.com", "pm.me", "rediffmail.com", "zoho.com", "zohomail.in", "gmx.com", "yandex.com", "mail.com", "tutanota.com",
]);
const DISPOSABLE = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "10minutemail.com", "10minutemail.net", "tempmail.com", "temp-mail.org",
  "temp-mail.io", "yopmail.com", "yopmail.net", "trashmail.com", "getnada.com", "nada.email", "sharklasers.com", "dispostable.com",
  "maildrop.cc", "mailnesia.com", "mintemail.com", "fakeinbox.com", "throwawaymail.com", "mohmal.com", "emailondeck.com",
  "tempail.com", "mailcatch.com", "spamgourmet.com", "trashmail.de", "burnermail.io", "moakt.com", "tempr.email", "inboxkitten.com",
  "mytemp.email", "tmpmail.org", "tmpmail.net", "minuteinbox.com", "33mail.com", "spambox.us", "mailpoof.com", "dropmail.me",
  "harakirimail.com", "luxusmail.org", "crazymailing.com", "emailfake.com", "fakemail.net", "getairmail.com", "anonbox.net",
]);
const COMMON = ["gmail.com", "yahoo.com", "yahoo.co.in", "outlook.com", "hotmail.com", "icloud.com", "rediffmail.com", "live.com", "aol.com", "protonmail.com"];

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** "priya@gmial.com" → "priya@gmail.com" */
export function typoSuggestion(email: string): string | undefined {
  const [local, domain] = email.split("@");
  if (!domain || COMMON.includes(domain)) return undefined;
  const best = COMMON.map((c) => [c, distance(domain, c)] as const).sort((a, b) => a[1] - b[1])[0];
  return best && best[1] > 0 && best[1] <= 2 ? `${local}@${best[0]}` : undefined;
}

export function providerFromMxHosts(mx: string[]): string | null {
  const s = mx.join(" ").toLowerCase();
  if (/google\.com|googlemail/.test(s)) return "Google Workspace / Gmail";
  if (/outlook\.com|protection\.outlook/.test(s)) return "Microsoft 365 / Outlook";
  if (/zoho/.test(s)) return "Zoho Mail";
  if (/secureserver\.net/.test(s)) return "GoDaddy";
  if (/titan\.email/.test(s)) return "Titan";
  if (/yahoodns|yahoo/.test(s)) return "Yahoo";
  if (/protonmail/.test(s)) return "Proton";
  if (/icloud|apple/.test(s)) return "iCloud";
  if (/mimecast/.test(s)) return "Mimecast (security gateway)";
  if (/pphosted|proofpoint/.test(s)) return "Proofpoint (security gateway)";
  if (/barracuda/.test(s)) return "Barracuda (security gateway)";
  if (/rediffmail/.test(s)) return "Rediffmail";
  return mx[0] ?? null;
}

const mxCache = new Map<string, Promise<string[]>>();
export function mxHosts(domain: string): Promise<string[]> {
  let p = mxCache.get(domain);
  if (!p) {
    p = resolveMx(domain)
      .then((r) => r.sort((a, b) => a.priority - b.priority).map((x) => x.exchange).filter((h) => h && h !== "."))
      .catch(async () => {
        // RFC 5321: no MX but an A record → mail goes to the A host.
        try { return (await resolve4(domain)).length ? [domain] : []; } catch { return []; }
      });
    mxCache.set(domain, p);
    setTimeout(() => mxCache.delete(domain), 10 * 60_000).unref?.();
  }
  return p;
}

/* ───────────── SMTP mailbox probe ───────────── */

let port25: { ok: boolean; at: number } | null = null;

/** Can this machine talk to mail servers on port 25? (Most home/office ISPs and clouds block it.) */
export async function canProbeSmtp(): Promise<boolean> {
  if (process.env.VERIFIER_SMTP === "off") return false;
  if (port25 && Date.now() - port25.at < 10 * 60_000) return port25.ok;
  const ok = await new Promise<boolean>((resolve) => {
    const s = net.connect({ host: "gmail-smtp-in.l.google.com", port: 25 });
    const done = (v: boolean) => { s.destroy(); resolve(v); };
    s.setTimeout(6000, () => done(false));
    s.once("data", (d) => done(d.toString().startsWith("220")));
    s.once("error", () => done(false));
  });
  port25 = { ok, at: Date.now() };
  return ok;
}

interface SmtpReply { code: number; text: string }

/** One SMTP session: checks each address with RCPT TO, without sending anything. */
export async function smtpProbe(mx: string, addresses: string[]): Promise<Map<string, SmtpReply>> {
  const helo = process.env.VERIFIER_HELO || "mail.grevya.com";
  const from = process.env.VERIFIER_FROM || `verify@${helo.replace(/^mail\./, "")}`;
  const results = new Map<string, SmtpReply>();
  const sock = net.connect({ host: mx, port: 25 });
  sock.setTimeout(15_000);
  let buf = "";
  const waiters: ((r: SmtpReply) => void)[] = [];
  const fail = new Promise<never>((_, reject) => {
    sock.once("error", reject);
    sock.once("timeout", () => reject(new Error("SMTP timeout")));
    sock.once("close", () => reject(new Error("SMTP connection closed")));
  });
  fail.catch(() => {});
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    // A reply ends with a line "NNN text" (no dash after the code).
    let m: RegExpMatchArray | null;
    while ((m = buf.match(/^((?:\d{3}-[^\r\n]*\r?\n)*)(\d{3})( [^\r\n]*)?\r?\n/))) {
      buf = buf.slice(m[0].length);
      waiters.shift()?.({ code: Number(m[2]), text: (m[1] + (m[3] ?? "")).replace(/\r?\n\d{3}-/g, " ").trim() });
    }
  });
  const next = () => Promise.race([new Promise<SmtpReply>((r) => waiters.push(r)), fail]);
  const cmd = (line: string) => { sock.write(`${line}\r\n`); return next(); };

  try {
    const greet = await next();
    if (greet.code !== 220) throw new Error(`greeting ${greet.code}`);
    let r = await cmd(`EHLO ${helo}`);
    if (r.code !== 250) r = await cmd(`HELO ${helo}`);
    r = await cmd(`MAIL FROM:<${from}>`);
    if (r.code >= 400) throw new Error(`MAIL FROM refused: ${r.code} ${r.text}`);
    for (const a of addresses) results.set(a, await cmd(`RCPT TO:<${a}>`));
    sock.write("QUIT\r\n");
  } finally {
    sock.end();
    setTimeout(() => sock.destroy(), 500).unref?.();
  }
  return results;
}

/** Interprets an RCPT reply. */
function rcptVerdict(r: SmtpReply | undefined): "exists" | "missing" | "unknown" {
  if (!r) return "unknown";
  if (r.code === 250 || r.code === 251) return "exists";
  if (r.code >= 500) {
    // Policy / spam blocks say nothing about whether the mailbox exists.
    if (/spam|block|blacklist|reputation|policy|denied|not allowed|5\.7\.\d/i.test(r.text) && !/5\.1\.\d/.test(r.text)) return "unknown";
    return "missing";
  }
  return "unknown"; // 4xx: greylisting etc.
}

/* ───────────── Hunter.io (optional) ───────────── */

export function hunterEnabled(): boolean {
  return Boolean(process.env.HUNTER_API_KEY);
}

async function hunterVerify(email: string): Promise<{ status: VerifyStatus; score: number; acceptAll: boolean; mailbox: "exists" | "missing" | "unknown" } | null> {
  const key = process.env.HUNTER_API_KEY;
  if (!key) return null;
  const res = await fetch(`https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${key}`, { signal: AbortSignal.timeout(30_000) });
  if (res.status === 429 || res.status === 402) return null; // out of credits
  if (!res.ok) return null;
  const d = (await res.json()).data as { status?: string; score?: number };
  const score = Number(d.score ?? 0);
  switch (d.status) {
    case "valid": return { status: "valid", score: Math.max(score, 85), acceptAll: false, mailbox: "exists" };
    case "invalid": return { status: "invalid", score: Math.min(score, 10), acceptAll: false, mailbox: "missing" };
    case "accept_all": return { status: "risky", score, acceptAll: true, mailbox: "unknown" };
    case "webmail": return { status: score >= 70 ? "valid" : "unknown", score, acceptAll: false, mailbox: score >= 70 ? "exists" : "unknown" };
    case "disposable": return { status: "invalid", score: 5, acceptAll: false, mailbox: "unknown" };
    default: return { status: "unknown", score, acceptAll: false, mailbox: "unknown" };
  }
}

export async function hunterCredits(): Promise<{ searches: number; verifications: number } | null> {
  const key = process.env.HUNTER_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`https://api.hunter.io/v2/account?api_key=${key}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const r = (await res.json()).data?.requests;
    return { searches: Number(r?.searches?.available ?? 0) - Number(r?.searches?.used ?? 0), verifications: Number(r?.verifications?.available ?? 0) - Number(r?.verifications?.used ?? 0) };
  } catch {
    return null;
  }
}

/* ───────────── main entry ───────────── */

const result = (email: string, partial: Partial<VerifyResult> & Pick<VerifyResult, "status" | "score" | "reason">, checks: VerifyResult["checks"], provider: string | null, source: VerifyResult["source"]): VerifyResult => ({
  email, provider, checks, source, checkedAt: new Date().toISOString(), ...partial,
});

export interface VerifyOptions {
  useSmtp?: boolean;   // default: when port 25 is reachable
  useHunter?: boolean; // default: when a key is set and SMTP isn't available
  useCache?: boolean;  // default true (30 days)
}

export async function verifyAddress(raw: string, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const email = raw.trim().toLowerCase().replace(/^mailto:/, "");
  const checks: VerifyResult["checks"] = { syntax: false, domain: false, disposable: false, role: false, freeMail: false, acceptAll: null, mailbox: null };

  if (!SYNTAX.test(email)) {
    return result(email, { status: "invalid", score: 0, reason: "Not a valid email address format", suggestion: undefined }, checks, null, "dns");
  }
  checks.syntax = true;
  const domain = email.split("@")[1];
  const suggestion = typoSuggestion(email);
  checks.disposable = DISPOSABLE.has(domain);
  checks.role = ROLE.test(email);
  checks.freeMail = FREE.has(domain);

  if (opts.useCache !== false) {
    const { data } = await db().from("email_checks").select("result, checked_at").eq("email", email).maybeSingle();
    if (data && Date.now() - new Date(data.checked_at).getTime() < 30 * 86_400_000) return { ...(data.result as VerifyResult), source: "cache" };
  }

  const mx = await mxHosts(domain);
  const provider = providerFromMxHosts(mx);
  if (!mx.length) {
    return save(result(email, { status: "invalid", score: 2, reason: `${domain} has no mail server — emails would bounce`, suggestion }, checks, null, "dns"));
  }
  checks.domain = true;
  if (checks.disposable) {
    return save(result(email, { status: "invalid", score: 5, reason: "Disposable / throwaway address" }, checks, provider, "dns"));
  }

  // "gmial.com" etc. often *do* have mail servers (typo-squatters) — never trust them.
  if (suggestion) {
    return save(result(email, { status: "risky", score: 15, reason: `Looks like a typo of ${suggestion.split("@")[1]}`, suggestion }, checks, provider, "dns"));
  }

  // Mailbox-level check over SMTP.
  const smtpOk = opts.useSmtp ?? (await canProbeSmtp());
  if (smtpOk) {
    try {
      const fake = `zz${randomBytes(6).toString("hex")}@${domain}`;
      const replies = await smtpProbe(mx[0], [email, fake]);
      const real = rcptVerdict(replies.get(email));
      const catchAll = rcptVerdict(replies.get(fake)) === "exists";
      checks.mailbox = real;
      checks.acceptAll = catchAll;
      if (real === "missing") {
        return save(result(email, { status: "invalid", score: 3, reason: "The mail server says this mailbox doesn't exist", suggestion }, checks, provider, "smtp"));
      }
      if (real === "exists" && !catchAll) {
        return save(result(email, {
          status: checks.role ? "risky" : "valid", score: checks.role ? 75 : 97,
          reason: checks.role ? "Mailbox exists, but it's a shared/role address (info@, sales@…) — replies are less likely" : "Mailbox exists",
        }, checks, provider, "smtp"));
      }
      if (catchAll) {
        return save(result(email, { status: "risky", score: 60, reason: "The domain accepts every address (accept-all), so this one can't be confirmed" }, checks, provider, "smtp"));
      }
      // Greylisted / blocked — fall through to the next method.
    } catch {
      // Server dropped us — fall through.
    }
  }

  if (opts.useHunter ?? hunterEnabled()) {
    const h = await hunterVerify(email).catch(() => null);
    if (h) {
      checks.mailbox = h.mailbox;
      checks.acceptAll = h.acceptAll;
      const reason = h.status === "valid" ? "Mailbox exists (verified via Hunter)" : h.status === "invalid" ? "Mailbox doesn't exist (verified via Hunter)"
        : h.acceptAll ? "The domain accepts every address, so this one can't be confirmed" : "Couldn't confirm the mailbox";
      return save(result(email, { status: h.status, score: h.score, reason, suggestion }, checks, provider, "hunter"));
    }
  }

  // Domain-level only.
  const reason = checks.role
    ? "Domain receives email, but this is a shared/role address (info@, sales@…)"
    : smtpOk
      ? "Domain receives email; the mail server wouldn't confirm the mailbox"
      : "Domain receives email; mailbox not checked (port 25 blocked on this network)";
  return save(result(email, { status: checks.role ? "risky" : "unknown", score: checks.role ? 45 : checks.freeMail ? 65 : 60, reason, suggestion }, checks, provider, "dns"));
}

async function save(r: VerifyResult): Promise<VerifyResult> {
  // Only cache definitive answers; "unknown" may become checkable later (other network, API key).
  if (r.status !== "unknown") {
    await db().from("email_checks").upsert({ email: r.email, status: r.status, score: r.score, result: r, checked_at: r.checkedAt });
  }
  return r;
}
