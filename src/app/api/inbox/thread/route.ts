import type { NextRequest } from "next/server";
import { apiAuth } from "@/lib/api-auth";
import { loadThread } from "@/lib/inbox-data";

/** GET /api/inbox/thread?id → ThreadItem[] (everything sent to and received from this person). */
export async function GET(request: NextRequest) {
  const deny = await apiAuth();
  if (deny) return deny;
  const id = request.nextUrl.searchParams.get("id") ?? "";
  try {
    const thread = await loadThread(id);
    if (!thread) return Response.json({ error: "Conversation not found" }, { status: 404 });
    return Response.json(thread, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
