// Mail provider presets and plain-language explanations of connection errors.
// Pure module: safe for client and server.

export const PROVIDERS = {
  godaddy: { label: "GoDaddy", smtp_host: "smtpout.secureserver.net", smtp_port: 465, smtp_secure: true, imap_host: "imap.secureserver.net", imap_port: 993 },
  google: { label: "Google Workspace / Gmail", smtp_host: "smtp.gmail.com", smtp_port: 465, smtp_secure: true, imap_host: "imap.gmail.com", imap_port: 993 },
  outlook: { label: "Microsoft 365 / Outlook", smtp_host: "smtp.office365.com", smtp_port: 587, smtp_secure: false, imap_host: "outlook.office365.com", imap_port: 993 },
  zoho: { label: "Zoho Mail (India)", smtp_host: "smtppro.zoho.in", smtp_port: 465, smtp_secure: true, imap_host: "imappro.zoho.in", imap_port: 993 },
  titan: { label: "Titan (GoDaddy Professional Email)", smtp_host: "smtp.titan.email", smtp_port: 465, smtp_secure: true, imap_host: "imap.titan.email", imap_port: 993 },
  custom: { label: "Other (enter server details)", smtp_host: "", smtp_port: 465, smtp_secure: true, imap_host: "", imap_port: 993 },
} as const;

export type ProviderKey = keyof typeof PROVIDERS;

/** Maps MX hostnames to a provider preset. */
export function providerFromMx(mxHosts: string[]): ProviderKey | null {
  const mx = mxHosts.join(" ").toLowerCase();
  if (mx.includes("secureserver.net")) return "godaddy";
  if (mx.includes("titan.email")) return "titan";
  if (mx.includes("google.com") || mx.includes("googlemail.com")) return "google";
  if (mx.includes("outlook.com") || mx.includes("protection.outlook")) return "outlook";
  if (mx.includes("zoho.in")) return "zoho";
  return null;
}

export interface CheckResult {
  ok: boolean;
  /** What happened, in plain words. */
  message: string;
  /** What to do about it. */
  hint?: string;
  /** Raw error for support/debugging. */
  detail?: string;
}

/** Turns nodemailer/imapflow errors into something a person can act on. */
export function explainError(err: unknown, kind: "smtp" | "imap", host: string, port: number, providerLabel?: string): CheckResult {
  const e = err as { code?: string; responseCode?: number; message?: string; authenticationFailed?: boolean; response?: string };
  const raw = e.message ?? String(err);
  const text = `${e.code ?? ""} ${e.responseCode ?? ""} ${raw} ${e.response ?? ""}`.toLowerCase();
  const what = kind === "smtp" ? "send email" : "read replies";

  if (e.code === "EAUTH" || e.authenticationFailed || /\b535\b|authentication failed|invalid credentials|auth.*fail|login fail|username and password not accepted/.test(text)) {
    const godaddy = providerLabel?.startsWith("GoDaddy");
    return {
      ok: false,
      message: `Wrong email or password — the server refused to let this mailbox ${what}.`,
      hint: godaddy
        ? "Use the password of the email inbox itself (the one you use at email.secureserver.net), not your GoDaddy account login. If you just created or reset it, wait ~15 minutes and try again."
        : providerLabel?.startsWith("Google")
          ? "Gmail needs an App Password (Google Account → Security → 2-Step Verification → App passwords), not your normal password."
          : providerLabel?.startsWith("Microsoft")
            ? "Your Microsoft 365 admin must enable “Authenticated SMTP” for this mailbox, and accounts with MFA need an app password."
            : "Double-check the password. Some providers require an app-specific password.",
      detail: raw,
    };
  }
  if (e.code === "ENOTFOUND" || /getaddrinfo|enotfound/.test(text)) {
    return { ok: false, message: `The server “${host}” doesn't exist.`, hint: "Check the server name for typos, or pick your provider from the list.", detail: raw };
  }
  if (!host) {
    return { ok: false, message: `No ${kind.toUpperCase()} server set.`, hint: "Pick your email provider, or enter the server details under “Server settings”.", detail: raw };
  }
  if (/econnrefused|etimedout|timeout|esocket|econnreset|ehostunreach|enetunreach|greeting never received/.test(text)) {
    return {
      ok: false,
      message: `Couldn't reach ${host}:${port}.`,
      hint: kind === "smtp"
        ? `Check the server and port. If your network blocks port ${port}, try ${port === 465 ? "587" : "465"} instead.`
        : "Check the IMAP server and port (usually 993).",
      detail: raw,
    };
  }
  if (/wrong version number|ssl|tls|certificate|self.signed|eproto/.test(text)) {
    return { ok: false, message: "Secure connection setting doesn't match the port.", hint: "Port 465 uses SSL; port 587 uses STARTTLS. Pick the provider from the list to get the right combination.", detail: raw };
  }
  if (/\b5\d\d\b/.test(text) && /(limit|quota|exceed|block|suspend|spam)/.test(text)) {
    return { ok: false, message: "The provider is blocking this mailbox from sending right now.", hint: "It may have hit a sending limit or been flagged. Log in to your email provider to check, then try again later.", detail: raw };
  }
  return { ok: false, message: `Couldn't ${what}: ${raw}`, detail: raw };
}
