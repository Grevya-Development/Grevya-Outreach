import { unsubscribeByToken } from "@/lib/unsubscribe";

// RFC 8058 one-click unsubscribe (Gmail/Yahoo "Unsubscribe" button posts here).
export async function POST(_req: Request, ctx: RouteContext<"/api/unsubscribe/[token]">) {
  const { token } = await ctx.params;
  const email = await unsubscribeByToken(token);
  return new Response(email ? "Unsubscribed" : "Invalid link", { status: email ? 200 : 400 });
}
