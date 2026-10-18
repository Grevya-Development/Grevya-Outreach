// DNS checks that decide whether Gmail/Outlook trust mail from a domain.
import { resolveMx, resolveTxt } from "node:dns/promises";

export interface HealthCheck {
  key: "mx" | "spf" | "dkim" | "dmarc";
  label: string;
  ok: boolean;
  level: "ok" | "warn" | "fail";
  detail: string;
  fix?: string;
}

const DKIM_SELECTORS = [
  "default", "selector1", "selector2", "google", "k1", "k2", "s1", "s2", "dkim", "mail", "smtp", "zoho", "zmail", "titan1",
  "secureserver", "gd", "godaddy", "mxvault", "x", "key1", "mandrill", "everlytickey1", "mta", "sig1", "protonmail",
];

async function txt(name: string): Promise<string[]> {
  try {
    return (await resolveTxt(name)).map((parts) => parts.join(""));
  } catch {
    return [];
  }
}

export async function checkDomain(domain: string, smtpHost: string, extraSelector?: string): Promise<HealthCheck[]> {
  const d = domain.toLowerCase().trim();
  const out: HealthCheck[] = [];

  // MX
  let mx: string[] = [];
  try { mx = (await resolveMx(d)).map((r) => r.exchange); } catch { /* none */ }
  out.push(mx.length
    ? { key: "mx", label: "MX (receives mail)", ok: true, level: "ok", detail: mx.slice(0, 2).join(", ") }
    : { key: "mx", label: "MX (receives mail)", ok: false, level: "fail", detail: "No MX record — replies can't reach you and filters distrust the domain.", fix: "Add your provider's MX records in DNS." });

  // SPF
  const spf = (await txt(d)).filter((r) => r.toLowerCase().startsWith("v=spf1"));
  const host = smtpHost.toLowerCase();
  const expect = host.includes("secureserver") ? "secureserver.net" : host.includes("gmail") || host.includes("google") ? "_spf.google.com"
    : host.includes("office365") || host.includes("outlook") ? "spf.protection.outlook.com" : host.includes("zoho") ? "zoho" : host.includes("titan") ? "titan.email" : "";
  if (!spf.length) out.push({ key: "spf", label: "SPF", ok: false, level: "fail", detail: "No SPF record.", fix: `Add a TXT record: v=spf1 include:${expect || "<your provider>"} -all` });
  else if (spf.length > 1) out.push({ key: "spf", label: "SPF", ok: false, level: "fail", detail: "More than one SPF record — receivers treat this as no SPF.", fix: "Merge them into a single v=spf1 record." });
  else if (expect && !spf[0].toLowerCase().includes(expect)) out.push({ key: "spf", label: "SPF", ok: false, level: "fail", detail: `SPF doesn't include your sending server (${expect}): ${spf[0]}`, fix: `Add include:${expect} to the SPF record.` });
  else out.push({ key: "spf", label: "SPF", ok: true, level: "ok", detail: spf[0] });

  // DKIM — selectors can't be listed via DNS, so probe common ones.
  const selectors = extraSelector ? [extraSelector, ...DKIM_SELECTORS] : DKIM_SELECTORS;
  const found: string[] = [];
  await Promise.all(selectors.map(async (s) => {
    const rec = await txt(`${s}._domainkey.${d}`);
    if (rec.some((r) => /v=dkim1|k=rsa|p=/i.test(r))) found.push(s);
  }));
  out.push(found.length
    ? { key: "dkim", label: "DKIM", ok: true, level: "ok", detail: `Found selector: ${found.join(", ")}` }
    : {
      key: "dkim", label: "DKIM", ok: false, level: "warn",
      detail: "No DKIM key found under common selectors. Without DKIM, Gmail and Outlook are far more likely to send you to spam.",
      fix: host.includes("secureserver")
        ? "In GoDaddy: Email & Office dashboard → your domain → DNS / authentication → enable DKIM (or ask GoDaddy support to enable DKIM signing for your mailbox). Then re-check. If your provider uses an unusual selector, send yourself an email, open its headers and look for “s=” in DKIM-Signature."
        : "Enable DKIM signing in your email provider's admin panel and publish the TXT record it gives you.",
    });

  // DMARC
  const dmarc = (await txt(`_dmarc.${d}`)).find((r) => r.toLowerCase().startsWith("v=dmarc1"));
  if (!dmarc) out.push({ key: "dmarc", label: "DMARC", ok: false, level: "fail", detail: "No DMARC record. Gmail and Yahoo require one for bulk senders.", fix: `Add TXT _dmarc.${d}: v=DMARC1; p=none; rua=mailto:dmarc@${d}` });
  else {
    const p = dmarc.match(/p=(\w+)/i)?.[1]?.toLowerCase();
    out.push({ key: "dmarc", label: "DMARC", ok: true, level: p === "none" ? "warn" : "ok", detail: dmarc, ...(p === "reject" && !found.length ? { level: "warn" as const, fix: "p=reject without DKIM risks your own mail being rejected — enable DKIM first." } : {}) });
  }
  return out;
}
