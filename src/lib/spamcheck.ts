// Content checks that predict spam-folder placement for plain-text cold email.
// Pure module (used by the engine, the AI writer and the live preview).

const TRIGGERS = [
  "100% free", "act now", "apply now", "as seen on", "best price", "buy now", "call now", "click below", "click here",
  "congratulations", "dear friend", "double your", "earn money", "exclusive deal", "extra income", "free gift", "free trial",
  "guarantee", "guaranteed", "increase sales", "limited time", "lowest price", "make money", "miracle", "no cost",
  "no obligation", "no strings attached", "offer expires", "once in a lifetime", "order now", "risk-free", "risk free",
  "special promotion", "this is not spam", "unsubscribe here", "urgent", "winner", "you have been selected", "100%", "$$$",
  "₹₹₹", "lakhs guaranteed", "viagra", "investment opportunity", "work from home",
];

export interface SpamIssue {
  level: "high" | "medium" | "low";
  message: string;
}

export interface SpamReport {
  score: number; // 0 (clean) – 10 (very spammy)
  issues: SpamIssue[];
}

export function checkContent(subject: string, body: string, opts: { allowLinks?: number; isFollowUp?: boolean } = {}): SpamReport {
  const issues: SpamIssue[] = [];
  const text = `${subject}\n${body}`.toLowerCase();
  const words = body.split(/\s+/).filter(Boolean);

  const hits = TRIGGERS.filter((t) => text.includes(t));
  if (hits.length) issues.push({ level: hits.length > 2 ? "high" : "medium", message: `Spam trigger words: ${hits.slice(0, 5).join(", ")}` });

  const links = (body.match(/https?:\/\/|www\./gi) ?? []).length;
  const allowed = opts.allowLinks ?? 1;
  if (links > allowed) issues.push({ level: links > 2 ? "high" : "medium", message: `${links} links — keep cold emails to ${allowed === 0 ? "no links" : "at most one"}` });

  if (!opts.isFollowUp && !subject.trim()) issues.push({ level: "high", message: "Empty subject" });
  if (subject.length > 60) issues.push({ level: "low", message: "Subject is long — 2–6 words reads like a real email" });
  if (/^(re|fwd?):/i.test(subject.trim()) && !opts.isFollowUp) issues.push({ level: "high", message: "Fake “Re:/Fwd:” on a first email — filters and people punish this" });
  if (/[!?]{2,}|!$/.test(subject)) issues.push({ level: "medium", message: "Exclamation marks in subject" });

  const caps = words.filter((w) => w.length > 3 && /^[A-Z]+$/.test(w)).length;
  if (caps >= 3) issues.push({ level: "medium", message: `${caps} ALL-CAPS words` });
  const bangs = (body.match(/!/g) ?? []).length;
  if (bangs > 2) issues.push({ level: "low", message: `${bangs} exclamation marks` });

  if (words.length > 180) issues.push({ level: "medium", message: `${words.length} words — cold emails under 120 words get more replies` });
  if (!opts.isFollowUp && words.length < 25) issues.push({ level: "low", message: "Very short first email" });

  if (/\{\{|\}\}|\[(first ?name|company|name)\]|<[a-z ]+>/i.test(`${subject} ${body}`)) issues.push({ level: "high", message: "Unfilled placeholder left in the email" });
  if (/i hope (this|you)|hope this (email )?finds you/i.test(body)) issues.push({ level: "low", message: "“Hope this finds you well” — a cliché filters and readers associate with mass email" });
  if (/<img|<a |<div|<table/i.test(body)) issues.push({ level: "medium", message: "HTML in the body" });

  const weight = { high: 3, medium: 1.5, low: 0.5 };
  const score = Math.min(10, Math.round(issues.reduce((s, i) => s + weight[i.level], 0) * 10) / 10);
  return { score, issues };
}
