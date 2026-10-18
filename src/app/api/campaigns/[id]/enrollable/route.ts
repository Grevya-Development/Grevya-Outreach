import { apiAuth } from "@/lib/api-auth";
import { db, isMissingRpc } from "@/lib/supabase";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/campaigns/{id}/enrollable?tag=…  or  ?all=1
 * What adding that list would do, without doing it: how many would be added and why the rest are
 * skipped. Before migration 0004 there's no count_enrollable, so it answers { will_add: null }.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const deny = await apiAuth();
  if (deny) return deny;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "not found" }, { status: 404 });
  const sp = new URL(req.url).searchParams;
  const all = sp.get("all") === "1";
  const tag = (sp.get("tag") ?? "").trim();
  if (!all && !tag) return Response.json({ error: "pass tag or all=1" }, { status: 400 });

  const { data, error } = await db().rpc("count_enrollable", { p_campaign: id, p_tag: all ? null : tag, p_lead_ids: null });
  if (error) {
    if (isMissingRpc(error)) return Response.json({ will_add: null }, { headers: { "Cache-Control": "no-store" } });
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json(data, { headers: { "Cache-Control": "no-store" } });
}
