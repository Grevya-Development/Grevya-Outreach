import type { NextRequest } from "next/server";
import { apiAuth } from "@/lib/api-auth";
import { getProfile } from "@/lib/profile";
import { leadDomain, type Analysis } from "@/lib/research";
import { db } from "@/lib/supabase";
import type { Reply } from "@/lib/types";
import { draftReply } from "@/lib/writer";

type Result = { ok: true; text: string } | { ok: false; error: string };

/** GET /api/inbox/suggest?id → an AI-drafted answer to a reply (never sent; the user edits it first). */
export async function GET(request: NextRequest) {
  const deny = await apiAuth();
  if (deny) return deny;
  const json = (r: Result, status = 200) => Response.json(r, { status, headers: { "cache-control": "no-store" } });
  const id = request.nextUrl.searchParams.get("id") ?? "";
  try {
    const supa = db();
    const { data } = await supa.from("replies").select("*").eq("id", id).maybeSingle();
    const r = data as Reply | null;
    if (!r) return json({ ok: false, error: "Conversation not found" }, 404);
    const [profile, lastSent, senderName, analysis] = await Promise.all([
      getProfile(),
      r.lead_id
        ? supa.from("messages").select("body").eq("lead_id", r.lead_id).eq("status", "sent").order("sent_at", { ascending: false }).limit(1)
          .then((x) => (x.data?.[0]?.body as string | undefined) ?? "")
        : Promise.resolve(""),
      r.mailbox_id
        ? supa.from("mailboxes").select("from_name").eq("id", r.mailbox_id).maybeSingle().then((x) => (x.data?.from_name as string | undefined) ?? "")
        : Promise.resolve(""),
      (async () => {
        const domain = leadDomain({ email: r.from_email });
        if (!domain) return null;
        const { data: row } = await supa.from("company_research").select("analysis").eq("domain", domain).maybeSingle();
        return (row?.analysis as Analysis | null | undefined) ?? null;
      })(),
    ]);
    if (!profile.services.trim()) return json({ ok: false, error: "Fill in your company profile (Settings) so the AI knows what to say" });
    // The user moved on (closed the conversation or pressed Stop): don't spend an AI call.
    if (request.signal.aborted) return json({ ok: false, error: "Cancelled" }, 499);
    const text = await draftReply({
      profile, senderName: senderName.split(" ")[0] ?? "", theirReply: r.body || r.snippet, theirName: r.from_name || r.from_email,
      ourLastEmail: lastSent, sentiment: r.sentiment, analysis,
    });
    return json({ ok: true, text });
  } catch (err) {
    return json({ ok: false, error: (err as Error).message || "Couldn't write a reply" }, 500);
  }
}
