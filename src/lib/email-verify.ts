// E-mail verification: layered checks from cheapest to most certain.
//   1. syntax + typo suggestions          (instant)
//   2. domain: MX records, provider, disposable / role / free-mail
//   3. mailbox: ask the recipient's mail server (SMTP RCPT TO, port 25) whether the address
//      exists, and whether the domain accepts *any* address ("accept-all"). Many home/office
//      networks block port 25 — then we report "domain OK, mailbox not checked".
import { randomBytes } from "node:crypto";
import { resolveMx, resolve4 } from "node:dns/promises";
import net from "node:net";
import { VERIFIER_KEY } from "./app-state";
import { fmtDate } from "./format";
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
  source: "smtp" | "dns" | "cache" | "history";
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

/** The domain couldn't be looked up right now (network down, resolver timeout) — says nothing about the address. */
export class DnsUnavailableError extends Error {}

// Answers that really mean "this domain has no such record"; anything else is a lookup failure.
const DNS_NO_RECORD = new Set(["ENOTFOUND", "ENODATA", "ENONAME", "ENXDOMAIN", "NXDOMAIN"]);
const dnsCode = (err: unknown) => String((err as { code?: string } | null)?.code ?? "");

type MxLookup = { hosts: string[]; failed: boolean };
const mxCache = new Map<string, Promise<MxLookup>>();
function lookupMx(domain: string): Promise<MxLookup> {
  let p = mxCache.get(domain);
  if (!p) {
    p = resolveMx(domain)
      .then((r) => ({ hosts: r.sort((a, b) => a.priority - b.priority).map((x) => x.exchange).filter((h) => h && h !== "."), failed: false }))
      .catch(async (mxErr) => {
        // RFC 5321: no MX but an A record → mail goes to the A host.
        try {
          return { hosts: (await resolve4(domain)).length ? [domain] : [], failed: false };
        } catch (aErr) {
          return { hosts: [], failed: !DNS_NO_RECORD.has(dnsCode(mxErr)) || !DNS_NO_RECORD.has(dnsCode(aErr)) };
        }
      });
    mxCache.set(domain, p);
    // A failed lookup is forgotten right away so the next check asks again.
    p.then((r) => { if (r.failed) mxCache.delete(domain); });
    setTimeout(() => mxCache.delete(domain), 10 * 60_000).unref?.();
  }
  return p;
}

export async function mxHosts(domain: string): Promise<string[]> {
  return (await lookupMx(domain)).hosts;
}

/* ───────────── SMTP mailbox probe ───────────── */

// Whether this network can reach mail servers on port 25. The engine re-checks it every 30 min
// (refreshSmtpCapability) and stores it in app_state, so pages and checks rarely open a socket.
const MEMORY_TTL_MS = 10 * 60_000;
const STORED_TTL_MS = 60 * 60_000;
type Port25 = { ok: boolean; at: number };
const cap = globalThis as { __port25?: Port25; __port25Check?: Promise<boolean> }; // shared across bundles and hot reloads

function probePort25(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const s = net.connect({ host: "gmail-smtp-in.l.google.com", port: 25 });
    const done = (v: boolean) => { s.destroy(); resolve(v); };
    s.setTimeout(6000, () => done(false));
    s.once("data", (d) => done(d.toString().startsWith("220")));
    s.once("error", () => done(false));
  });
}

/** Probes port 25 now (ignoring every cache) and stores the answer in app_state.verifier. */
export async function refreshSmtpCapability(): Promise<boolean> {
  const ok = process.env.VERIFIER_SMTP === "off" ? false : await probePort25();
  cap.__port25 = { ok, at: Date.now() };
  try {
    const now = new Date().toISOString();
    await db().from("app_state").upsert({ key: VERIFIER_KEY, value: { smtp: ok, checked_at: now }, updated_at: now });
  } catch { /* the in-memory answer still holds */ }
  return ok;
}

/** The last stored port-25 answer. Only reads app_state, never opens a socket (safe for pages). */
export async function getCachedSmtpCapability(): Promise<{ ok: boolean; checkedAt: string } | null> {
  try {
    const { data } = await db().from("app_state").select("value").eq("key", VERIFIER_KEY).maybeSingle();
    const v = data?.value as { smtp?: unknown; checked_at?: unknown } | undefined;
    if (!v || typeof v.smtp !== "boolean") return null;
    return { ok: v.smtp && process.env.VERIFIER_SMTP !== "off", checkedAt: typeof v.checked_at === "string" ? v.checked_at : "" };
  } catch {
    return null;
  }
}

/** Can this machine talk to mail servers on port 25? (Most home/office ISPs and clouds block it.) */
export async function canProbeSmtp(): Promise<boolean> {
  if (process.env.VERIFIER_SMTP === "off") return false;
  const mem = cap.__port25;
  if (mem && Date.now() - mem.at < MEMORY_TTL_MS) return mem.ok;
  // One lookup at a time: parallel checks share it instead of each probing.
  cap.__port25Check ??= (async () => {
    const stored = await getCachedSmtpCapability();
    if (stored && Date.now() - new Date(stored.checkedAt).getTime() < STORED_TTL_MS) {
      cap.__port25 = { ok: stored.ok, at: Date.now() };
      return stored.ok;
    }
    return refreshSmtpCapability();
  })().finally(() => { cap.__port25Check = undefined; });
  return cap.__port25Check;
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

/* ───────────── main entry ───────────── */

const result = (email: string, partial: Partial<VerifyResult> & Pick<VerifyResult, "status" | "score" | "reason">, checks: VerifyResult["checks"], provider: string | null, source: VerifyResult["source"]): VerifyResult => ({
  email, provider, checks, source, checkedAt: new Date().toISOString(), ...partial,
});

export interface VerifyOptions {
  useSmtp?: boolean;   // default: when port 25 is reachable
  useCache?: boolean;  // default true (30 days)
  /** Throw DnsUnavailableError when the domain can't be looked up right now, instead of answering "unknown". */
  strictDns?: boolean;
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
    const cached = data?.result as (VerifyResult & { v?: number }) | undefined;
    // Only reuse results produced by the current verification logic.
    if (cached?.v === CACHE_VERSION && Date.now() - new Date(data!.checked_at).getTime() < 30 * 86_400_000) return { ...cached, source: "cache" };
  }

  const { hosts: mx, failed: dnsFailed } = await lookupMx(domain);
  const provider = providerFromMxHosts(mx);
  if (!mx.length && dnsFailed) {
    // A network hiccup must never brand an address invalid. Not cached: the next check retries.
    if (opts.strictDns) throw new DnsUnavailableError(`Couldn't look up ${domain} right now`);
    return result(email, { status: "unknown", score: 50, reason: `Couldn't look up ${domain} right now — check again in a few minutes`, suggestion }, checks, null, "dns");
  }
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

  // Evidence we already have beats any remote check.
  const known = await knownEvidence(email);
  if (known) {
    checks.mailbox = "exists";
    return save(result(email, { status: "valid", score: 99, reason: known }, checks, provider, "history"));
  }

  // Mailbox-level check over SMTP (tries backup mail servers if the first one refuses us).
  const smtpOk = opts.useSmtp ?? (await canProbeSmtp());
  let refused = false;
  if (smtpOk) {
    const fake = `zz${randomBytes(6).toString("hex")}@${domain}`;
    const probe = await probeAny(mx, [email, fake]);
    refused = probe.refused;
    if (probe.replies) {
      const real = rcptVerdict(probe.replies.get(email));
      const catchAll = rcptVerdict(probe.replies.get(fake)) === "exists";
      checks.mailbox = real;
      checks.acceptAll = catchAll;
      if (real === "missing") {
        return save(result(email, { status: "invalid", score: 3, reason: "The mail server says this mailbox doesn't exist", suggestion }, checks, provider, "smtp"));
      }
      if (real === "exists" && !catchAll) {
        return save(result(email, {
          status: "valid", score: checks.role ? 90 : 97,
          reason: checks.role ? "Mailbox exists (it's a shared address like info@ — fine to email, replies come from whoever reads it)" : "Mailbox exists",
        }, checks, provider, "smtp"));
      }
      if (catchAll) {
        return save(result(email, { status: "risky", score: 60, reason: "The domain accepts every address (accept-all), so this one can't be confirmed" }, checks, provider, "smtp"));
      }
    }
  }

  // Domain-level only: say precisely why the mailbox couldn't be confirmed.
  const who = provider && !provider.includes(".") ? provider : `${domain}'s mail server`;
  const reason = !smtpOk
    ? "The domain accepts email, but this network can't ask its mail server whether the mailbox exists."
    : refused
      ? `${who} refuses verification checks from your current internet connection (it blocks home/office IPs), so this mailbox can't be confirmed from here. It will be checked automatically when the app runs on a server (e.g. a VPS).`
      : `${who} wouldn't say whether this mailbox exists (some servers hide that on purpose).`;
  return save(result(email, { status: "unknown", score: checks.freeMail ? 65 : 60, reason, suggestion }, checks, provider, "dns"));
}

/**
 * Proof the address is real from our own data: it's one of our connected mailboxes, the person
 * has emailed us, or we emailed them over a day ago and it didn't bounce.
 */
async function knownEvidence(email: string): Promise<string | null> {
  const supa = db();
  const [mailbox, reply, sent, bounced] = await Promise.all([
    supa.from("mailboxes").select("id").eq("email", email).limit(1),
    supa.from("replies").select("received_at").eq("from_email", email).in("kind", ["reply", "auto_reply"]).limit(1),
    supa.from("messages").select("sent_at").eq("to_email", email).eq("status", "sent").lt("sent_at", new Date(Date.now() - 86_400_000).toISOString()).order("sent_at", { ascending: false }).limit(1),
    supa.from("messages").select("id").eq("to_email", email).eq("status", "bounced").limit(1),
  ]);
  if (mailbox.data?.length) return "This is one of your connected mailboxes";
  if (reply.data?.length) return "This person has emailed you from this address";
  if (sent.data?.length && !bounced.data?.length) {
    return `You emailed this address on ${fmtDate(sent.data[0].sent_at)} and it didn't bounce`;
  }
  return null;
}

/** Tries up to 3 of the domain's mail servers; reports whether they all refused us outright. */
export async function probeAny(mx: string[], addresses: string[]): Promise<{ replies: Map<string, SmtpReply> | null; refused: boolean }> {
  let refusedAll = true;
  for (const host of mx.slice(0, 3)) {
    try {
      return { replies: await smtpProbe(host, addresses), refused: false };
    } catch (err) {
      // "greeting 554" / connection reset = this server blocks our IP; anything else = flaky.
      if (!/greeting 5\d\d|ECONNRESET|ECONNREFUSED|MAIL FROM refused: 5/i.test((err as Error).message)) refusedAll = false;
    }
  }
  return { replies: null, refused: refusedAll };
}

const CACHE_VERSION = 2;

async function save(r: VerifyResult): Promise<VerifyResult> {
  // Only cache definitive answers; "unknown" may become checkable later (other network, API key).
  // History-based answers are cheap to recompute, so they aren't cached either.
  if (r.status !== "unknown" && r.source !== "history") {
    await db().from("email_checks").upsert({ email: r.email, status: r.status, score: r.score, result: { ...r, v: CACHE_VERSION }, checked_at: r.checkedAt });
  }
  return r;
}
