import { resolveMx } from "node:dns/promises";

const SYNTAX = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;
const ROLE = /^(info|admin|support|sales|contact|hello|office|team|hr|jobs|careers|billing|noreply|no-reply|webmaster|marketing)@/i;
const DISPOSABLE = new Set(["mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "yopmail.com", "trashmail.com", "getnada.com", "sharklasers.com", "temp-mail.org", "dispostable.com"]);

const mxCache = new Map<string, Promise<boolean>>();

function hasMx(domain: string): Promise<boolean> {
  let p = mxCache.get(domain);
  if (!p) {
    p = resolveMx(domain).then((r) => r.length > 0).catch(() => false);
    mxCache.set(domain, p);
  }
  return p;
}

/**
 * Free, local verification: syntax + domain accepts mail (MX) + disposable/role checks.
 * It can't prove a mailbox exists (that needs paid SMTP probing), so "valid" means
 * "domain receives mail and address looks real"; role addresses are "risky".
 */
export async function verifyEmail(email: string): Promise<"valid" | "invalid" | "risky"> {
  const e = email.trim().toLowerCase();
  if (!SYNTAX.test(e)) return "invalid";
  const domain = e.split("@")[1];
  if (DISPOSABLE.has(domain)) return "invalid";
  if (!(await hasMx(domain))) return "invalid";
  return ROLE.test(e) ? "risky" : "valid";
}

export function isEmailSyntax(email: string): boolean {
  return SYNTAX.test(email.trim());
}
