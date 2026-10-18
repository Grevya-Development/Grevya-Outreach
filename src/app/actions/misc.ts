"use server";

import { refresh } from "next/cache";
import type { ActionResult } from "@/components/client";
import { tick } from "@/lib/engine";
import { chat, groqLimits } from "@/lib/groq";
import { getProfile, setProfile } from "@/lib/profile";
import { draftProfileFromWebsite, EMPTY_PROFILE, type CompanyProfile } from "@/lib/research";
import { db, must } from "@/lib/supabase";
import { requireAuth } from "./auth";

export async function runEngineNow(): Promise<ActionResult> {
  await requireAuth();
  const r = await tick();
  refresh();
  if (r.errors.length) return { ok: false, error: r.errors.join(" · ") };
  const why = Object.entries(r.skipped).map(([mb, reason]) => `${mb}: ${reason}`).join(" · ");
  return { ok: true, message: r.sent ? `Sent ${r.sent} email${r.sent === 1 ? "" : "s"}` : `Nothing sent — ${why || "no active mailboxes"}` };
}

export async function markReply(id: string, patch: { is_read?: boolean; sentiment?: "interested" | "not_interested" | "neutral" }): Promise<ActionResult> {
  await requireAuth();
  must(await db().from("replies").update(patch).eq("id", id));
  refresh();
  return { ok: true };
}

export async function addSuppression(emails: string): Promise<ActionResult> {
  await requireAuth();
  const list = [...new Set(emails.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")))];
  if (!list.length) return { ok: false, error: "No valid emails" };
  const supa = db();
  must(await supa.from("suppressions").upsert(list.map((email) => ({ email, reason: "manual" }))));
  await supa.from("leads").update({ status: "unsubscribed" }).in("email", list);
  refresh();
  return { ok: true, message: `Blocked ${list.length}` };
}

export async function removeSuppression(email: string): Promise<ActionResult> {
  await requireAuth();
  must(await db().from("suppressions").delete().eq("email", email));
  refresh();
  return { ok: true, message: `${email} can be emailed again` };
}

export async function testGroq(): Promise<ActionResult> {
  await requireAuth();
  try {
    const out = await chat({ system: "Reply with exactly: ok", user: "ping", maxTokens: 5, temperature: 0 });
    return { ok: true, message: `Groq responded: “${out}”` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function saveProfile(p: CompanyProfile): Promise<ActionResult> {
  await requireAuth();
  const clean = Object.fromEntries(Object.keys(EMPTY_PROFILE).map((k) => [k, String((p as unknown as Record<string, string>)[k] ?? "").trim()])) as unknown as CompanyProfile;
  await setProfile(clean);
  // Drafts already written (but not sent) used the old profile — tell the user how to refresh them.
  const { count } = await db().from("campaign_leads").select("id", { count: "exact", head: true })
    .eq("current_step", 0).eq("status", "queued").in("prep_status", ["ready", "review"]);
  refresh();
  return {
    ok: true,
    message: count
      ? `Profile saved. ${count} unsent AI draft(s) were written with the old profile — open the campaign → Leads → “Rewrite all not-yet-sent” to refresh them.`
      : "Company profile saved — new AI emails will use it",
  };
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

export async function currentProfile(): Promise<CompanyProfile> {
  await requireAuth();
  return getProfile();
}

export async function groqStatus() {
  await requireAuth();
  return groqLimits();
}
