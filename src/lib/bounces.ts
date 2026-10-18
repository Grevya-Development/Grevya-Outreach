import { db, must } from "./supabase";
import type { Mailbox } from "./types";

const BOUNCE_WINDOW = 50;      // look at the last N sends
const BOUNCE_MIN_SAMPLE = 20;  // …once there are at least this many
const BOUNCE_PAUSE_RATE = 0.05;
const BOUNCE_STREAK = 5;       // pause after this many bounces in a row

/** Pauses a mailbox whose recent bounces suggest a bad list (protects its reputation). */
export async function checkBounceRate(mb: Pick<Mailbox, "id">) {
  const supa = db();
  const recent = async (n: number) => {
    const rows = must(await supa.rpc("mailbox_recent_bounces", { p_mailbox: mb.id, p_window: n })) as { total: number; bounced: number }[];
    return { total: Number(rows[0]?.total ?? 0), bounced: Number(rows[0]?.bounced ?? 0) };
  };
  const streak = await recent(BOUNCE_STREAK);
  if (streak.total >= BOUNCE_STREAK && streak.bounced >= BOUNCE_STREAK) {
    await supa.from("mailboxes").update({
      status: "paused",
      last_error: `Auto-paused: the last ${BOUNCE_STREAK} emails all bounced. Check the lead list (Leads → Verify), then resume.`,
    }).eq("id", mb.id).eq("status", "active");
    return;
  }
  const { total, bounced } = await recent(BOUNCE_WINDOW);
  if (total >= BOUNCE_MIN_SAMPLE && bounced / total > BOUNCE_PAUSE_RATE) {
    await supa.from("mailboxes").update({
      status: "paused",
      last_error: `Auto-paused: ${bounced} of the last ${total} emails bounced (${Math.round((bounced / total) * 100)}%). Verify your lead list, then resume.`,
    }).eq("id", mb.id).eq("status", "active");
  }
}
