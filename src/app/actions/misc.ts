"use server";

import { refresh } from "next/cache";
import type { ActionResult } from "@/components/client";
import { SCHEDULE_KEY, type SendingSchedule } from "@/lib/app-state";
import { tick } from "@/lib/engine";
import { chat, groqLimits } from "@/lib/groq";
import { getProfile, setProfile } from "@/lib/profile";
import { draftProfileFromWebsite, EMPTY_PROFILE, type CompanyProfile } from "@/lib/research";
import { db, must } from "@/lib/supabase";
import { requireAuth } from "./auth";

/** Postgres check-constraint violation: a value the database doesn't accept yet (migration 0004 not run). */
const CHECK_VIOLATION = "23514";

export async function runEngineNow(): Promise<ActionResult> {
  await requireAuth();
  const r = await tick();
  refresh();
  if (r.errors.length) return { ok: false, error: r.errors.join(" · ") };
  const why = Object.entries(r.skipped).map(([mb, reason]) => `${mb}: ${reason}`).join(" · ");
  return { ok: true, message: r.sent ? `Sent ${r.sent} email${r.sent === 1 ? "" : "s"}` : `Nothing was due: ${why || "no active email accounts"}` };
}

export async function addSuppression(emails: string): Promise<ActionResult> {
  await requireAuth();
  const list = [...new Set(emails.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")))];
  if (!list.length) return { ok: false, error: "No valid emails" };
  const supa = db();
  // Keep the reason of anyone already blocked (e.g. they unsubscribed themselves).
  must(await supa.from("suppressions").upsert(list.map((email) => ({ email, reason: "manual" })), { onConflict: "email", ignoreDuplicates: true }));
  let res = await supa.from("leads").update({ status: "blocked" }).in("email", list).select("id");
  if (res.error?.code === CHECK_VIOLATION) res = await supa.from("leads").update({ status: "unsubscribed" }).in("email", list).select("id");
  const ids = must(res).map((l) => l.id as string);
  // Stop any campaign emails still waiting for them.
  if (ids.length) must(await supa.from("campaign_leads").update({ status: "unsubscribed" }).in("lead_id", ids).in("status", ["queued", "in_progress"]));
  refresh();
  return { ok: true, message: `Blocked ${list.length} ${list.length === 1 ? "address" : "addresses"}` };
}

export async function removeSuppression(email: string): Promise<ActionResult> {
  await requireAuth();
  const supa = db();
  const row = must(await supa.from("suppressions").delete().eq("email", email).select("reason"))[0] as { reason: string } | undefined;
  // Only undo what was done by hand: someone who unsubscribed themselves stays unsubscribed on their lead.
  if (row?.reason === "manual") {
    must(await supa.from("leads").update({ status: "active" }).eq("email", email).in("status", ["blocked", "unsubscribed"]));
  }
  refresh();
  return { ok: true, message: `${email} can be emailed again` };
}

export async function testGroq(): Promise<ActionResult> {
  await requireAuth();
  try {
    await chat({ system: "Reply with exactly: ok", user: "ping", maxTokens: 5, temperature: 0 });
    return { ok: true, message: "AI connection works" };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Campaigns whose unsent AI drafts were written with the profile as it was before a save. */
export type AffectedCampaign = { campaignId: string; name: string; count: number };

export async function saveProfile(p: CompanyProfile): Promise<{ ok: true; message: string; affected: AffectedCampaign[] } | { ok: false; error: string }> {
  await requireAuth();
  const clean = Object.fromEntries(Object.keys(EMPTY_PROFILE).map((k) => [k, String((p as unknown as Record<string, string>)[k] ?? "").trim()])) as unknown as CompanyProfile;
  await setProfile(clean);
  // Drafts already written for leads not yet emailed, counted per AI campaign in one query.
  const { data } = await db().from("campaigns").select("id, name, campaign_leads(count)").eq("mode", "ai")
    .eq("campaign_leads.current_step", 0).eq("campaign_leads.status", "queued").in("campaign_leads.prep_status", ["ready", "review"]);
  const affected = ((data ?? []) as { id: string; name: string; campaign_leads: { count: number }[] }[])
    .map((c) => ({ campaignId: c.id, name: c.name, count: Number(c.campaign_leads?.[0]?.count) || 0 }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count);
  refresh();
  return { ok: true, message: "Company profile saved. New AI emails will use it", affected };
}

/** Researches our own website and drafts the profile fields (not saved until the user clicks Save). */
export async function importProfile(website: string): Promise<{ ok: true; profile: Partial<CompanyProfile> } | { ok: false; error: string }> {
  await requireAuth();
  try {
    return { ok: true, profile: await draftProfileFromWebsite(website) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Settings → Sending: one schedule, copied onto every email account's sending hours. */
export async function saveSendingSchedule(s: SendingSchedule): Promise<ActionResult> {
  await requireAuth();
  const start = Number(s.window_start);
  const end = Number(s.window_end);
  const days = [...new Set((s.send_days ?? []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 24) return { ok: false, error: "Pick the sending hours" };
  if (end <= start) return { ok: false, error: "The end time must be after the start time" };
  if (!days.length) return { ok: false, error: "Pick at least one day" };
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s.timezone });
  } catch {
    return { ok: false, error: "Unknown timezone" };
  }
  const value: SendingSchedule = { timezone: s.timezone, window_start: start, window_end: end, send_days: days };
  const supa = db();
  must(await supa.from("app_state").upsert({ key: SCHEDULE_KEY, value, updated_at: new Date().toISOString() }));
  must(await supa.from("mailboxes").update(value).not("id", "is", null)); // every account (the filter keeps safe-update guards happy)
  refresh();
  return { ok: true, message: "Schedule saved for all email accounts" };
}

export async function currentProfile(): Promise<CompanyProfile> {
  await requireAuth();
  return getProfile();
}

export async function groqStatus() {
  await requireAuth();
  return groqLimits();
}
