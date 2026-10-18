// Server-only: everything that must be true before a campaign can send, checked in one go so the
// Launch step can show every problem at once (and setCampaignStatus can refuse with all of them).
import { getEngineState } from "./app-state";
import { fmtNum } from "./format";
import { getProfile } from "./profile";
import { describeWindow, effectiveCampaignCapacity, estimateFinish, nextWindowStart } from "./schedule";
import { db, must } from "./supabase";
import type { Campaign, PublicMailbox } from "./types";

export type ChecklistItem = {
  key: string;
  label: string;
  ok: boolean;
  /** A failing blocking item stops the launch; the rest are warnings. */
  blocking: boolean;
  detail?: string;
  fixHref: string;
};

export type LaunchChecklist = {
  items: ChecklistItem[];
  summary: {
    leads: number;
    accounts: number;
    effectivePerDay: number;
    nextSend: string | null;
    finishDate: string | null;
    /** The sending window(s) of the active accounts, e.g. 'Mon–Fri · 09:00–18:00 · IST'. */
    window: string;
  };
};

export const PLACEHOLDER_RE = /<[^<>\n]{3,}>/g;

const MB_FIELDS = "id, email, status, daily_limit, warmup_enabled, warmup_start, warmup_increment, warmup_started_at, timezone, window_start, window_end, send_days";
type Mb = Pick<PublicMailbox, "id" | "email" | "status" | "daily_limit" | "warmup_enabled" | "warmup_start" | "warmup_increment" | "warmup_started_at" | "timezone" | "window_start" | "window_end" | "send_days">;

const count = (r: { count: number | null }) => r.count ?? 0;

export async function getLaunchChecklist(id: string): Promise<LaunchChecklist> {
  const supa = db();
  const base = `/campaigns/${id}`;
  const cl = () => supa.from("campaign_leads").select("id", { count: "exact", head: true }).eq("campaign_id", id);
  const [campaign, steps, attached, active, queued, writing, review, unconfirmed, profile, engine] = await Promise.all([
    supa.from("campaigns").select("*").eq("id", id).single().then(must) as Promise<Campaign>,
    supa.from("campaign_steps").select("step_number, delay_days, subject, body").eq("campaign_id", id).order("step_number").then(must) as Promise<{ step_number: number; delay_days: number; subject: string; body: string }[]>,
    supa.from("campaign_mailboxes").select(`mailbox_id, mailboxes(${MB_FIELDS})`).eq("campaign_id", id).then(must) as unknown as Promise<{ mailbox_id: string; mailboxes: Mb | null }[]>,
    cl().in("status", ["queued", "in_progress"]).then(count),
    cl().eq("status", "queued").then(count),
    cl().eq("status", "queued").in("prep_status", ["pending", "working"]).then(count),
    cl().eq("status", "queued").eq("prep_status", "review").then(count),
    // Addresses the email check couldn't confirm (accept-all domains, or no port 25 from here).
    supa.from("campaign_leads").select("id, leads!inner(verify_status)", { count: "exact", head: true })
      .eq("campaign_id", id).in("status", ["queued", "in_progress"]).eq("leads.verify_status", "unknown").then(count),
    getProfile(),
    getEngineState().catch(() => null),
  ]);

  const ai = campaign.mode === "ai";
  const mailboxes = attached.map((a) => a.mailboxes).filter((m): m is Mb => !!m);
  const healthy = mailboxes.filter((m) => m.status === "active");
  const items: ChecklistItem[] = [];

  items.push({
    key: "leads", label: active ? `Leads added (${fmtNum(active)})` : "Leads added", ok: active > 0, blocking: true, fixHref: `${base}?step=leads`,
    detail: active ? undefined : "Add at least one lead who can be emailed.",
  });
  items.push({
    key: "accounts", label: "Email account selected and active", ok: healthy.length > 0, blocking: true, fixHref: `${base}?step=schedule`,
    detail: !mailboxes.length ? "Choose at least one email account to send from." : !healthy.length ? "Every chosen account is paused or needs attention." : undefined,
  });
  if (ai) {
    items.push({
      key: "profile", label: "Company profile filled", ok: !!profile.services.trim(), blocking: true, fixHref: "/settings",
      detail: profile.services.trim() ? undefined : "The AI writes every email from your services. Fill them in under Settings → Company profile.",
    });
  }
  items.push({
    key: "steps", label: "Sequence has at least one email", ok: steps.length > 0, blocking: true, fixHref: `${base}?step=sequence`,
  });
  // 0004: AI writing starts only once the sequence has been saved. Without the column there's nothing to check.
  if (ai && "sequence_confirmed_at" in campaign) {
    items.push({
      key: "confirmed", label: "Sequence saved", ok: !!campaign.sequence_confirmed_at, blocking: true, fixHref: `${base}?step=sequence`,
      detail: campaign.sequence_confirmed_at ? undefined : "Save the sequence so the AI can start writing.",
    });
  }
  if (!ai) {
    const hit = steps.map((s, i) => ({ i, ph: `${s.subject}\n${s.body}`.match(PLACEHOLDER_RE)?.[0] })).find((x) => x.ph);
    items.push({
      key: "placeholders", label: "No leftover <placeholder>", ok: !hit, blocking: true, fixHref: `${base}?step=sequence`,
      detail: hit ? `Email ${hit.i + 1} still has ${hit.ph}. Replace it with your own words.` : undefined,
    });
  }
  if (ai) {
    const total = queued;
    const done = Math.max(0, total - writing);
    items.push({
      key: "written", label: `AI emails written: ${fmtNum(done)} of ${fmtNum(total)}`, ok: writing === 0, blocking: false,
      fixHref: `${base}?tab=leads&status=ai_writing`,
      detail: writing ? "The rest are written in the background, about 3 a minute. Leads get Email 1 once theirs is ready." : undefined,
    });
    if (campaign.require_approval) {
      items.push({
        key: "review", label: "Reviewed", ok: review === 0, blocking: false, fixHref: `${base}?tab=review`,
        detail: review ? `${fmtNum(review)} emails are waiting for your review. Only approved emails are sent.` : undefined,
      });
    }
  }
  items.push(engine?.paused
    ? { key: "sending", label: "Sending is paused", ok: false, blocking: false, fixHref: "/settings/sending", detail: "No emails go out until you resume sending." }
    : engine && !engine.alive
      ? { key: "sending", label: "Sending stopped", ok: false, blocking: false, fixHref: "/settings/sending", detail: "Nothing is sending right now. Open Settings → Sending to see why." }
      : { key: "sending", label: "Sending on", ok: true, blocking: false, fixHref: "/settings/sending" });
  if (unconfirmed > 0) {
    items.push({
      key: "unconfirmed", label: "Some addresses couldn't be confirmed", ok: false, blocking: false, fixHref: `${base}?tab=leads`,
      detail: `${fmtNum(unconfirmed)} leads couldn't be confirmed from this network (GoDaddy and accept-all domains). They're still sent; bounces are watched.`,
    });
  }
  if (campaign.track_opens) {
    items.push({
      key: "opens", label: "Open tracking is on", ok: false, blocking: false, fixHref: `${base}?step=options`,
      detail: "The tracking image can push cold emails into spam. Replies are the number that matters.",
    });
  }

  const now = new Date();
  const capacity = effectiveCampaignCapacity(healthy, campaign.daily_limit, now);
  const starts = healthy.map((m) => nextWindowStart(m, now)).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime());
  const first = starts[0] ?? null;
  const sendDays = [...new Set(healthy.flatMap((m) => m.send_days))];
  const finish = first ? estimateFinish({ leadsRemaining: active, steps: steps.map((s) => s.delay_days), perDay: capacity.perDay, startDate: first, sendDays }) : null;
  const windows = [...new Set(healthy.map(describeWindow))];

  return {
    items,
    summary: {
      leads: active,
      accounts: healthy.length,
      effectivePerDay: capacity.perDay,
      nextSend: first?.toISOString() ?? null,
      finishDate: finish?.toISOString() ?? null,
      window: windows.join("; "),
    },
  };
}
