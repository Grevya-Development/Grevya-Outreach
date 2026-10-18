export type MailboxStatus = "active" | "paused" | "error";

export interface Mailbox {
  id: string;
  email: string;
  from_name: string;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  imap_host: string | null;
  imap_port: number;
  username: string;
  password_enc: string;
  daily_limit: number;
  warmup_enabled: boolean;
  warmup_start: number;
  warmup_increment: number;
  warmup_started_at: string;
  min_delay_sec: number;
  max_delay_sec: number;
  timezone: string;
  window_start: number;
  window_end: number;
  send_days: number[];
  signature: string;
  status: MailboxStatus;
  last_error: string | null;
  next_available_at: string;
  imap_last_uid: number | null;
  imap_uidvalidity: number | null;
  save_to_sent: boolean;
  sent_folder: string | null;
  imap_synced_at: string | null;
  created_at: string;
}

/** Mailbox without the encrypted password, safe to hand to client components. */
export type PublicMailbox = Omit<Mailbox, "password_enc">;

export type LeadStatus = "active" | "unsubscribed" | "bounced" | "invalid" | "blocked";

export interface Lead {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  company: string;
  title: string;
  website: string;
  linkedin: string;
  phone: string;
  city: string;
  notes: string;
  custom: Record<string, string>;
  tags: string[];
  status: LeadStatus;
  verify_status: "valid" | "invalid" | "risky" | "unknown" | null;
  created_at: string;
}

export type CampaignStatus = "draft" | "active" | "paused" | "completed";

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  daily_limit: number;
  track_opens: boolean;
  track_clicks: boolean;
  stop_on_reply: boolean;
  include_unsubscribe: boolean;
  ai_enabled: boolean;
  ai_prompt: string;
  sender_context: string;
  mode: "template" | "ai";
  min_fit_score: number;
  require_approval: boolean;
  /** Set when the sequence is saved; AI writing waits for it (migration 0004, absent before). */
  sequence_confirmed_at?: string | null;
  created_at: string;
}

export interface CampaignStep {
  id: string;
  campaign_id: string;
  step_number: number;
  delay_days: number;
  subject: string;
  body: string;
}

export type CampaignLeadStatus =
  | "queued" | "in_progress" | "replied" | "bounced" | "unsubscribed" | "completed" | "failed" | "skipped";

export interface CampaignLead {
  id: string;
  campaign_id: string;
  lead_id: string;
  mailbox_id: string | null;
  status: CampaignLeadStatus;
  current_step: number;
  next_send_at: string;
  locked_until: string | null;
  personalization: {
    ai_line?: string;
    generated_at?: string;
    emails?: { subject: string; body: string }[];
    research_domain?: string | null;
    angle?: string;
    best_service?: string;
    fit_score?: number;
    /** The user changed the AI's draft by hand. */
    edited?: boolean;
  } | null;
  last_message_id: string | null;
  last_subject: string | null;
  attempts: number;
  last_error: string | null;
  prep_status: "pending" | "working" | "review" | "ready" | "failed" | "skipped";
  prep_error: string | null;
  prep_locked_until: string | null;
  prep_attempts: number;
  fit_score: number | null;
  skip_reason: string | null;
  created_at: string;
}

export interface CampaignStats {
  campaign_id: string;
  leads: number;
  sent: number;
  opened: number;
  clicked: number;
  replied: number;
  bounced: number;
  unsubscribed: number;
  remaining: number;
}

/** Labels you can put on a reply (`replies.sentiment`); 'neutral'/null mean no label. */
export type ReplyLabel = "interested" | "meeting_booked" | "out_of_office" | "wrong_person" | "not_interested" | "closed";

export interface Reply {
  id: string;
  mailbox_id: string | null;
  lead_id: string | null;
  campaign_id: string | null;
  from_email: string;
  from_name: string;
  subject: string;
  snippet: string;
  body: string;
  kind: "reply" | "auto_reply" | "bounce";
  sentiment: ReplyLabel | "neutral" | null;
  is_read: boolean;
  received_at: string;
  message_id: string | null;
  references_header: string | null;
  handled: boolean;
  follow_up_at: string | null;
  answered_at: string | null;
  note: string;
}
