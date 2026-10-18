// Domain health (SPF / DKIM / DMARC / MX) for an email account, rendered on the server. DNS answers
// change rarely, so they're cached for hours per domain; "Re-check DNS" expires the `dns:<domain>` tag.
import { cacheLife, cacheTag } from "next/cache";
import { Skeleton } from "@/components/ui";
import { checkDomain, type HealthCheck } from "@/lib/domain-health";
import { DomainHealthView } from "./mailbox-client";

async function getDomainHealth(domain: string, smtpHost: string, selector?: string): Promise<HealthCheck[]> {
  "use cache";
  cacheLife("hours");
  cacheTag(`dns:${domain}`);
  return checkDomain(domain, smtpHost, selector);
}

export async function DomainHealth({ email, smtpHost }: { email: string; smtpHost: string }) {
  const domain = (email.split("@")[1] ?? "").trim().toLowerCase();
  if (!domain) return null;
  let checks: HealthCheck[] | null = null;
  try {
    checks = await getDomainHealth(domain, smtpHost.trim().toLowerCase());
  } catch {
    // DNS hiccup: the view shows "couldn't check" with a Re-check button.
  }
  return <DomainHealthView domain={domain} checks={checks} smtpHost={smtpHost} />;
}

export function HealthSkeleton() {
  return (
    <div className="mt-3 rounded-lg border border-line px-3 py-2.5 grid gap-2.5" aria-busy="true" aria-label="Checking DNS">
      <Skeleton className="h-4 w-48" />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-10" />)}
      </div>
    </div>
  );
}
