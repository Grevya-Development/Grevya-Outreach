import { parseUnsubscribeToken } from "./crypto";
import { db } from "./supabase";

/** Unsubscribes the lead behind a signed token. Returns the email, or null for a bad token. */
export async function unsubscribeByToken(token: string): Promise<string | null> {
  const parsed = parseUnsubscribeToken(token);
  if (!parsed) return null;
  const supa = db();
  const { data: lead } = await supa.from("leads").select("id, email").eq("id", parsed.leadId).maybeSingle();
  if (!lead) return null;
  await Promise.all([
    supa.from("leads").update({ status: "unsubscribed" }).eq("id", lead.id),
    supa.from("suppressions").upsert({ email: lead.email, reason: "unsubscribe link" }),
    supa.from("campaign_leads").update({ status: "unsubscribed", locked_until: null }).eq("lead_id", lead.id).in("status", ["queued", "in_progress"]),
    supa.from("events").insert({ type: "unsubscribe", lead_id: lead.id, campaign_id: parsed.campaignId }),
  ]);
  return lead.email;
}
