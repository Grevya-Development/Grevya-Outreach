// Verification report: the plain verdict plus the four sub-checks people expect
// (Format, Type, Server status, Email status), with Gravatar and domain-age signals layered on
// top of the core check. Pure presentation logic — the core check lives in email-verify.ts.
import { domainAgeDays, hasGravatar } from "./email-intel";
import type { VerifyResult, VerifyStatus } from "./email-verify";

export type CheckTone = "good" | "warn" | "bad" | "neutral";

export interface SubCheck {
  key: "format" | "type" | "server" | "mailbox";
  label: string;
  value: string;     // short pill text, e.g. "Valid", "Professional", "Accept-all"
  tone: CheckTone;
  detail: string;    // one sentence
}

export interface VerifyReport extends VerifyResult {
  headline: string;      // "kavin@grevya.com is valid"
  summary: string;       // "This email address can be used safely."
  verdictTone: CheckTone;
  initials: string;      // avatar fallback
  subChecks: SubCheck[];
  signals: { gravatar: boolean; domainAgeDays: number | null };
}

const INITIALS = (email: string) => {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._-]+/).filter(Boolean);
  const s = parts.length >= 2 ? parts[0][0] + parts[1][0] : local.slice(0, 2);
  return s.toUpperCase();
};

function tone(status: VerifyStatus): CheckTone {
  return status === "valid" ? "good" : status === "invalid" ? "bad" : status === "risky" ? "warn" : "neutral";
}

/** Adds Gravatar + domain-age evidence and builds the four sub-checks. Never throws. */
export async function buildReport(r: VerifyResult): Promise<VerifyReport> {
  const domain = r.email.split("@")[1] ?? "";
  const [gravatar, age] = r.checks.syntax && r.checks.domain
    ? await Promise.all([hasGravatar(r.email).catch(() => false), domainAgeDays(domain).catch(() => null)])
    : [false, null];

  // A public Gravatar proves the address is real and in use — upgrade "unknown"/accept-all cases.
  let status = r.status, score = r.score, reason = r.reason;
  if (gravatar && status !== "invalid" && r.checks.mailbox !== "missing") {
    status = "valid";
    score = Math.max(score, 94);
    reason = r.checks.acceptAll
      ? "This address has a public Gravatar profile, so it's real and in use (the domain is accept-all, but that no longer matters)"
      : "This address has a public Gravatar profile, so it's real and in use";
  }
  if (age !== null && age < 30 && status !== "invalid") {
    if (status === "valid" && !gravatar && r.checks.mailbox !== "exists") status = "risky";
    score = Math.min(score, 60);
  }

  const c = r.checks;
  const subChecks: SubCheck[] = [
    {
      key: "format", label: "Format",
      value: c.syntax ? (r.suggestion ? "Likely typo" : "Valid") : "Invalid",
      tone: c.syntax ? (r.suggestion ? "warn" : "good") : "bad",
      detail: !c.syntax ? "This isn't a correctly formed email address."
        : r.suggestion ? `The format is fine, but the domain looks like a typo — did you mean ${r.suggestion}?`
        : "This email address has the correct format and is not gibberish.",
    },
    {
      key: "type", label: "Type",
      value: c.disposable ? "Disposable" : c.freeMail ? "Webmail" : c.role ? "Role address" : "Professional",
      tone: c.disposable ? "bad" : c.role ? "warn" : c.freeMail ? "neutral" : "good",
      detail: c.disposable ? "The domain is used for temporary / throwaway addresses."
        : c.freeMail ? "A personal webmail address (Gmail, Yahoo, Outlook…), not a company domain."
        : c.role ? "A shared inbox like info@ or sales@ — read by a team rather than one person."
        : "The domain isn't used for webmail or for creating temporary email addresses.",
    },
    {
      key: "server", label: "Server status",
      value: !c.domain ? "No mail server" : r.source === "smtp" ? "Valid" : c.domain ? "Valid" : "Unknown",
      tone: !c.domain ? "bad" : "good",
      detail: !c.domain ? "The domain has no MX records, so it can't receive email."
        : r.source === "smtp" ? "MX records are present for the domain and we connected to the mail server they point to."
        : "MX records are present for the domain and point to a mail server.",
    },
    {
      key: "mailbox", label: "Email status",
      value: c.mailbox === "exists" || gravatar ? "Valid" : c.mailbox === "missing" ? "Doesn't exist" : c.acceptAll ? "Accept-all" : "Unverifiable",
      tone: c.mailbox === "exists" || gravatar ? "good" : c.mailbox === "missing" ? "bad" : c.acceptAll ? "warn" : "neutral",
      detail: c.mailbox === "exists" ? "This email address exists and can receive emails."
        : gravatar ? "This address has a public profile, so it exists and is in use."
        : c.mailbox === "missing" ? "The mail server says this mailbox doesn't exist."
        : c.acceptAll ? "The server accepts every address at this domain, so the mailbox can't be confirmed individually."
        : r.source === "history" ? r.reason
        : "The mail server wouldn't confirm the mailbox from this network. Mailbox checks work fully when the app runs on a server.",
    },
  ];

  const verdictTone = tone(status);
  const headline = `${r.email} is ${status === "unknown" ? "unverifiable" : status}`;
  const summary = status === "valid" ? "This email address can be used safely."
    : status === "invalid" ? "Don't send to this address — it would bounce."
    : status === "risky" ? "You can send, but there's a real chance it bounces or isn't read."
    : "The address looks real, but the mailbox couldn't be confirmed from here.";

  return { ...r, status, score, reason, headline, summary, verdictTone, initials: INITIALS(r.email), subChecks, signals: { gravatar, domainAgeDays: age } };
}
