// The app's single vocabulary (spec §2). Every status a user sees is turned into words here, so
// raw values like `in_progress` or `not_interested` never reach the screen.
import { fmtDay } from "./format";
import type { ReplyLabel } from "./types";

export type Tone = "neutral" | "accent" | "good" | "warn" | "bad" | "info";
type Labelled = { label: string; tone: Tone };

/** Fallback for values we have no word for: 'some_value' → 'Some Value'. */
export function labelFor(status: string | null | undefined): string {
  if (!status) return "—";
  return status.replace(/[_-]+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

// ───────────────────────── email check (leads.verify_status) ─────────────────────────

export const VERIFY_LABEL: Record<string, string> = {
  valid: "Valid",
  risky: "Risky",
  invalid: "Invalid",
  unknown: "Couldn't confirm",
};
const VERIFY_TONE: Record<string, Tone> = { valid: "good", risky: "warn", invalid: "bad", unknown: "neutral" };

/** `checking` = sending is on, so unchecked emails are being checked in the background. */
export function verifyLabel(status: string | null | undefined, checking: boolean): string {
  if (!status) return checking ? "Checking…" : "Not checked yet";
  return VERIFY_LABEL[status] ?? labelFor(status);
}

export function verifyTone(status: string | null | undefined): Tone {
  return (status && VERIFY_TONE[status]) || "neutral";
}

// ───────────────────────── leads.status ─────────────────────────

export const LEAD_STATUS_LABEL: Record<string, string> = {
  active: "Can be emailed",
  unsubscribed: "Unsubscribed",
  bounced: "Bounced",
  invalid: "Invalid email",
  blocked: "Blocked",
};
const LEAD_STATUS_TONE: Record<string, Tone> = { active: "good", unsubscribed: "warn", bounced: "bad", invalid: "bad", blocked: "warn" };

// ───────────────────────── campaigns.status ─────────────────────────

export const CAMPAIGN_STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  completed: "Completed",
};
const CAMPAIGN_STATUS_TONE: Record<string, Tone> = { draft: "neutral", active: "good", paused: "warn", completed: "info" };

// ───────────────────────── campaign_leads.prep_status (AI drafts) ─────────────────────────

export const PREP_LABEL: Record<string, string> = {
  pending: "Waiting for AI",
  working: "AI writing",
  review: "To review",
  ready: "Ready",
  failed: "AI couldn't write",
  skipped: "Skipped",
};
const PREP_TONE: Record<string, Tone> = { pending: "neutral", working: "accent", review: "warn", ready: "good", failed: "bad", skipped: "neutral" };

// ───────────────────────── campaign_leads.status ─────────────────────────

/** Short words for a bare campaign-lead status. Prefer campaignLeadStatus(), which knows more. */
export const CAMPAIGN_LEAD_STATUS_LABEL: Record<string, string> = {
  queued: "Waiting to send",
  in_progress: "Sending",
  replied: "Replied",
  completed: "Finished",
  bounced: "Bounced",
  unsubscribed: "Unsubscribed",
  skipped: "Skipped",
  failed: "Couldn't send",
};
const CAMPAIGN_LEAD_STATUS_TONE: Record<string, Tone> = {
  queued: "neutral", in_progress: "accent", replied: "good", completed: "info",
  bounced: "bad", unsubscribed: "warn", skipped: "neutral", failed: "bad",
};

/** The one merged status pill for a lead in a campaign. */
export function campaignLeadStatus(
  cl: { status: string; current_step: number; prep_status?: string | null; next_send_at?: string | null; skip_reason?: string | null; last_error?: string | null },
  ctx: { mode: "ai" | "template" | string; totalSteps: number; campaignStatus: string },
): { label: string; tone: Tone; detail?: string } {
  const waiting = (cl.status === "queued" || cl.status === "in_progress") && cl.current_step === 0;
  if (waiting && ctx.mode === "ai") {
    if (cl.prep_status === "pending" || cl.prep_status === "working") return { label: "AI writing", tone: "accent" };
    if (cl.prep_status === "review") return { label: "To review", tone: "warn" };
    if (cl.prep_status === "failed") return { label: "AI couldn't write", tone: "bad" };
  }
  if (waiting) return { label: "Waiting to send", tone: "neutral" };
  switch (cl.status) {
    case "queued":
    case "in_progress": {
      const next = ctx.campaignStatus !== "active" ? "paused" : cl.next_send_at ? `next ${fmtDay(cl.next_send_at)}` : "next soon";
      return { label: `Email ${cl.current_step} of ${ctx.totalSteps} sent · ${next}`, tone: "accent" };
    }
    case "skipped":
      return { label: "Skipped", tone: "neutral", detail: cl.skip_reason ?? undefined };
    case "failed":
      return { label: "Couldn't send", tone: "bad", detail: cl.last_error ?? undefined };
    default:
      return { label: CAMPAIGN_LEAD_STATUS_LABEL[cl.status] ?? labelFor(cl.status), tone: CAMPAIGN_LEAD_STATUS_TONE[cl.status] ?? "neutral" };
  }
}

// ───────────────────────── replies ─────────────────────────

/** Reply labels in display order; `shortcut` is the inbox hotkey. 'neutral'/null mean no label. */
export const REPLY_LABELS: readonly { key: ReplyLabel; label: string; tone: Tone; shortcut: string }[] = [
  { key: "interested", label: "Interested", tone: "good", shortcut: "1" },
  { key: "meeting_booked", label: "Meeting booked", tone: "info", shortcut: "2" },
  { key: "out_of_office", label: "Out of office", tone: "neutral", shortcut: "3" },
  { key: "wrong_person", label: "Wrong person", tone: "warn", shortcut: "4" },
  { key: "not_interested", label: "Not interested", tone: "bad", shortcut: "5" },
  { key: "closed", label: "Closed", tone: "neutral", shortcut: "6" },
];
const REPLY_LABEL_BY_KEY: Record<string, Labelled> = Object.fromEntries(REPLY_LABELS.map((r) => [r.key, r]));

/** The label for a reply's sentiment, or null when it has none. */
export function replyLabel(sentiment: string | null | undefined): Labelled | null {
  return (sentiment && REPLY_LABEL_BY_KEY[sentiment]) || null;
}

export const REPLY_KIND_LABEL: Record<string, string> = {
  reply: "Reply",
  auto_reply: "Auto-reply",
  bounce: "Bounce",
};
const REPLY_KIND_TONE: Record<string, Tone> = { reply: "accent", auto_reply: "neutral", bounce: "bad" };

// ───────────────────────── mailboxes.status ─────────────────────────

export const MAILBOX_STATUS_LABEL: Record<string, string> = {
  active: "Active",
  paused: "Paused",
  error: "Needs attention",
};
const MAILBOX_STATUS_TONE: Record<string, Tone> = { active: "good", paused: "warn", error: "bad" };

// ───────────────────────── block list (suppressions.reason) ─────────────────────────

export function blockReasonLabel(reason: string | null | undefined): string {
  const r = (reason ?? "").trim().toLowerCase();
  if (!r || r === "manual") return "Added by you";
  if (/unsub/.test(r)) return "Unsubscribed";
  if (/not.?interested/.test(r)) return "Not interested";
  if (/wrong/.test(r)) return "Wrong person";
  if (/bounce/.test(r)) return "Bounced";
  const s = r.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ───────────────────────── generic lookup (StatusBadge) ─────────────────────────

export type StatusKind = "campaign" | "campaignLead" | "lead" | "verify" | "mailbox" | "reply" | "replyKind" | "prep";

const KINDS: Record<StatusKind, { labels: Record<string, string>; tones: Record<string, Tone> }> = {
  campaign: { labels: CAMPAIGN_STATUS_LABEL, tones: CAMPAIGN_STATUS_TONE },
  campaignLead: { labels: CAMPAIGN_LEAD_STATUS_LABEL, tones: CAMPAIGN_LEAD_STATUS_TONE },
  lead: { labels: LEAD_STATUS_LABEL, tones: LEAD_STATUS_TONE },
  verify: { labels: VERIFY_LABEL, tones: VERIFY_TONE },
  mailbox: { labels: MAILBOX_STATUS_LABEL, tones: MAILBOX_STATUS_TONE },
  reply: {
    labels: Object.fromEntries(REPLY_LABELS.map((r) => [r.key, r.label])),
    tones: Object.fromEntries(REPLY_LABELS.map((r) => [r.key, r.tone])),
  },
  replyKind: { labels: REPLY_KIND_LABEL, tones: REPLY_KIND_TONE },
  prep: { labels: PREP_LABEL, tones: PREP_TONE },
};
// Without a kind, the first map that knows the value wins (campaign 'active' before lead 'active').
const KIND_ORDER: StatusKind[] = ["campaign", "mailbox", "campaignLead", "reply", "replyKind", "verify", "prep", "lead"];

/** Words and colour for any status value. Pass `kind` when the same value means different things. */
export function statusLabel(status: string | null | undefined, kind?: StatusKind): Labelled {
  if (!status) return { label: "—", tone: "neutral" };
  for (const k of kind ? [kind] : KIND_ORDER) {
    const label = KINDS[k].labels[status];
    if (label) return { label, tone: KINDS[k].tones[status] ?? "neutral" };
  }
  return { label: labelFor(status), tone: "neutral" };
}
