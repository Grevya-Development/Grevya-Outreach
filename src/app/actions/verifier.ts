"use server";

import { refresh } from "next/cache";
import type { ActionResult } from "@/components/client";
import { verifyAddress, type VerifyResult } from "@/lib/email-verify";
import { findEmail, type FindResult } from "@/lib/email-finder";
import { fmtNum } from "@/lib/format";
import { db, must } from "@/lib/supabase";
import { requireAuth } from "./auth";

/**
 * Verifies up to 25 addresses per call (the page calls this in batches to show progress). Leads
 * you already have with these addresses get the new result too.
 */
export async function verifyBatch(emails: string[], force = false): Promise<VerifyResult[]> {
  await requireAuth();
  const list = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))].slice(0, 25);
  // Small parallelism: friendly to DNS and to mail servers.
  const out: VerifyResult[] = [];
  for (let i = 0; i < list.length; i += 5) {
    out.push(...(await Promise.all(list.slice(i, i + 5).map((e) => verifyAddress(e, { useCache: !force })))));
  }

  // One update per result group; addresses that aren't leads simply match nothing.
  const supa = db();
  const groups = new Map<string, string[]>();
  for (const r of out) groups.set(r.status, [...(groups.get(r.status) ?? []), r.email]);
  await Promise.all([...groups].map(async ([status, group]) => {
    await supa.from("leads").update({ verify_status: status }).in("email", group);
    if (status === "invalid") await supa.from("leads").update({ status: "invalid" }).in("email", group).eq("status", "active");
  })).catch(() => { /* the results still show; leads catch up on their next background check */ });
  return out;
}

export async function findOne(input: { first: string; last: string; domain: string }): Promise<FindResult | { ok: false; error: string }> {
  await requireAuth();
  try {
    return await findEmail(input);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

type SaveRow = { email: string; first_name?: string; last_name?: string; company?: string; website?: string; status: string };

/** Saves verified/found addresses as leads (skips anything marked invalid), optionally into a campaign. */
export async function saveToLeads(rows: SaveRow[], tags: string[], campaignId?: string | null, opts?: { restart?: boolean }): Promise<ActionResult> {
  await requireAuth();
  const supa = db();
  const good = rows.filter((r) => r.status !== "invalid" && r.email?.includes("@"));
  if (!good.length) return { ok: false, error: "Nothing to add: every address is invalid" };
  const tagList = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  const emails = [...new Set(good.map((r) => r.email.toLowerCase()))];
  const check = (s: string) => (s === "valid" || s === "risky" ? s : "unknown");

  const [existingRows, suppressed] = await Promise.all([
    supa.from("leads").select("id, email, tags").in("email", emails).then(must) as Promise<{ id: string; email: string; tags: string[] }[]>,
    supa.from("suppressions").select("email").in("email", emails).then(must) as Promise<{ email: string }[]>,
  ]);
  const existing = new Map(existingRows.map((l) => [l.email, l]));
  const blocked = new Set(suppressed.map((s) => s.email));
  const seen = new Set<string>();
  const fresh = good.filter((r) => {
    const e = r.email.toLowerCase();
    if (existing.has(e) || seen.has(e)) return false;
    seen.add(e);
    return true;
  }).map((r) => ({
    email: r.email.toLowerCase(), first_name: r.first_name ?? "", last_name: r.last_name ?? "", company: r.company ?? "", website: r.website ?? "",
    tags: tagList, status: blocked.has(r.email.toLowerCase()) ? "unsubscribed" : "active", verify_status: check(r.status),
  }));
  if (fresh.length) must(await supa.from("leads").insert(fresh));
  for (const r of good.filter((x) => existing.has(x.email.toLowerCase()))) {
    const prev = existing.get(r.email.toLowerCase())!;
    await supa.from("leads").update({ tags: [...new Set([...(prev.tags ?? []), ...tagList])], verify_status: check(r.status) }).eq("id", prev.id);
  }

  let campaignPart = "";
  let action: ActionResult["action"];
  if (campaignId) {
    const c = must(await supa.from("campaigns").select("id, name, status").eq("id", campaignId).maybeSingle()) as { id: string; name: string; status: string } | null;
    if (!c) return { ok: false, error: "That campaign no longer exists" };
    const ids = (must(await supa.from("leads").select("id").in("email", emails)) as { id: string }[]).map((l) => l.id);
    const enrolled = Number(must(await supa.rpc("enroll_leads", { p_campaign: c.id, p_tag: null, p_lead_ids: ids }))) || 0;
    // A finished campaign that gets new leads restarts, or waits paused if the user said not to.
    if (enrolled && c.status === "completed") {
      await supa.from("campaigns").update({ status: opts?.restart ? "active" : "paused" }).eq("id", c.id).eq("status", "completed");
    }
    campaignPart = ` · ${fmtNum(enrolled)} added to ${c.name}`;
    action = { label: "Open campaign", href: c.status === "draft" ? `/campaigns/${c.id}?step=leads` : `/campaigns/${c.id}?tab=leads` };
  }
  refresh();
  const n = emails.length;
  const list = tagList[0] ? ` (list “${tagList[0]}”)` : "";
  return {
    ok: true,
    message: `Added ${fmtNum(n)} lead${n === 1 ? "" : "s"}${list}${campaignPart}`,
    action: action ?? (tagList[0] ? { label: "View list", href: `/leads?tag=${encodeURIComponent(tagList[0])}` } : undefined),
  };
}
