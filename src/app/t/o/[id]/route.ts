import { db } from "@/lib/supabase";

const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const UUID = /^[0-9a-f-]{36}$/i;

// Open-tracking pixel. Opens within 60s of sending are ignored — those are almost always
// security scanners, not people. Apple Mail also pre-loads images, so treat opens as a rough signal.
export async function GET(_req: Request, ctx: RouteContext<"/t/o/[id]">) {
  const { id } = await ctx.params;
  if (UUID.test(id)) {
    try {
      const supa = db();
      const { data: msg } = await supa.from("messages").select("id, sent_at, opened_at, open_count, campaign_id, lead_id, mailbox_id").eq("id", id).maybeSingle();
      if (msg && Date.now() - new Date(msg.sent_at).getTime() > 60_000) {
        await supa.from("messages").update({ opened_at: msg.opened_at ?? new Date().toISOString(), open_count: msg.open_count + 1 }).eq("id", id);
        if (!msg.opened_at) {
          await supa.from("events").insert({ type: "open", message_id: id, campaign_id: msg.campaign_id, lead_id: msg.lead_id, mailbox_id: msg.mailbox_id });
        }
      }
    } catch {
      // Never fail the image.
    }
  }
  return new Response(GIF, {
    headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, no-cache, must-revalidate, private", "Content-Length": String(GIF.length) },
  });
}
