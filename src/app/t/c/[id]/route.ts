import { verifySig } from "@/lib/crypto";
import { db } from "@/lib/supabase";

export async function GET(req: Request, ctx: RouteContext<"/t/c/[id]">) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const target = url.searchParams.get("u") ?? "";
  const sig = url.searchParams.get("s") ?? "";

  // Signed links only — otherwise this would be an open redirect.
  if (!/^https?:\/\//i.test(target) || !verifySig(`click:${id}:${target}`, sig)) {
    return new Response("Invalid link", { status: 400 });
  }
  try {
    const supa = db();
    const { data: msg } = await supa.from("messages").select("clicked_at, click_count, campaign_id, lead_id, mailbox_id").eq("id", id).maybeSingle();
    if (msg) {
      await supa.from("messages").update({ clicked_at: msg.clicked_at ?? new Date().toISOString(), click_count: msg.click_count + 1 }).eq("id", id);
      await supa.from("events").insert({ type: "click", message_id: id, campaign_id: msg.campaign_id, lead_id: msg.lead_id, mailbox_id: msg.mailbox_id, meta: { url: target } });
    }
  } catch {
    // Redirect anyway.
  }
  return Response.redirect(target, 302);
}
