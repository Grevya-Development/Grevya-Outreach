import { resolveMx } from "node:dns/promises";
import type { NextRequest } from "next/server";
import { apiAuth } from "@/lib/api-auth";
import { providerFromMx, type ProviderKey } from "@/lib/providers";

/**
 * GET /api/mailboxes/detect?email= → { provider: ProviderKey | null }.
 * Guesses the mail provider from the domain's MX records (e.g. grevya.com → GoDaddy). A read, so it
 * is a route the connect dialog fetches (cancellable) rather than a Server Action.
 */
export async function GET(request: NextRequest) {
  const deny = await apiAuth();
  if (deny) return deny;
  const email = request.nextUrl.searchParams.get("email") ?? "";
  const domain = email.split("@")[1]?.trim().toLowerCase();
  let provider: ProviderKey | null = null;
  if (domain && domain.includes(".")) {
    try {
      const mx = await resolveMx(domain);
      provider = providerFromMx(mx.map((m) => m.exchange));
    } catch {
      provider = null;
    }
  }
  return Response.json({ provider }, { headers: { "cache-control": "no-store" } });
}
