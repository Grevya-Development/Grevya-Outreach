import type { NextRequest } from "next/server";
import { apiAuth } from "@/lib/api-auth";
import { inboxCounts, listReplies, parseQuery } from "@/lib/inbox-data";

/**
 * GET /api/inbox/list?f&label&campaign&account&q&before&since&full → {rows, counts}.
 * `before` pages older rows (Load more), `since` polls for newer ones. Counts come back when
 * polling (`since`) or with `full=1`, and are null otherwise.
 */
export async function GET(request: NextRequest) {
  const deny = await apiAuth();
  if (deny) return deny;
  const sp = request.nextUrl.searchParams;
  const query = parseQuery(sp);
  try {
    const [rows, counts] = await Promise.all([
      listReplies(query),
      sp.get("full") === "1" || query.since ? inboxCounts() : null,
    ]);
    return Response.json({ rows, counts }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
