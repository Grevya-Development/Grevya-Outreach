import { apiAuth } from "@/lib/api-auth";
import { db } from "@/lib/supabase";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/inbox/read {id} → 204. Marks a conversation read when the user opens it. A plain
 * route (not a Server Action) so it never queues ahead of navigation and never refreshes the page.
 */
export async function POST(request: Request) {
  const deny = await apiAuth();
  if (deny) return deny;
  const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!UUID.test(id)) return Response.json({ error: "Missing id" }, { status: 400 });
  const { error } = await db().from("replies").update({ is_read: true }).eq("id", id);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return new Response(null, { status: 204 });
}
