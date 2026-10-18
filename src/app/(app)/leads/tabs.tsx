// Server-safe pieces shared by the Leads pages, the leads actions and the export route: the tab
// bar and the one definition of the lead filters (URL params → database query).
import { TabLinks } from "@/components/ui";

export function LeadsTabs({ active }: { active: "all" | "find" }) {
  return (
    <TabLinks items={[
      { href: "/leads", label: "All leads", active: active === "all" },
      { href: "/leads/find", label: "Find & verify", active: active === "find" },
    ]} />
  );
}

export const LEAD_STATUS_FILTERS = ["active", "unsubscribed", "bounced", "invalid", "blocked"] as const;
export const CHECK_FILTERS = ["valid", "risky", "invalid", "unknown", "unchecked"] as const;

export type LeadFilter = { q?: string; tag?: string; status?: string; check?: string };
/** Leads picked on the page (`ids`), or every lead matching the filters ("Select all N matching"). */
export type LeadSelection = { ids: string[] } | { filter: LeadFilter };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Whitelists the filter params; anything unknown is dropped (so a bad URL just shows all leads). */
export function parseLeadFilter(get: (key: string) => unknown): LeadFilter {
  const f: LeadFilter = {};
  const q = str(get("q")).slice(0, 200);
  const tag = str(get("tag")).slice(0, 100);
  const status = str(get("status"));
  const check = str(get("check"));
  if (q) f.q = q;
  if (tag) f.tag = tag;
  if ((LEAD_STATUS_FILTERS as readonly string[]).includes(status)) f.status = status;
  if ((CHECK_FILTERS as readonly string[]).includes(check)) f.check = check;
  return f;
}

export function hasLeadFilter(f: LeadFilter): boolean {
  return !!(f.q || f.tag || f.status || f.check);
}

// The few filter methods we use. supabase-js's own builder types are too deep to pass through a generic.
type Filterable = {
  or(filters: string): Filterable;
  contains(column: string, value: string[]): Filterable;
  eq(column: string, value: string): Filterable;
  is(column: string, value: null): Filterable;
};

/** Applies a (parsed) filter to a leads query. The page, the export and bulk actions all use this. */
export function applyLeadFilter<Q>(query: Q, f: LeadFilter): Q {
  let q = query as unknown as Filterable;
  if (f.q) {
    const safe = f.q.replace(/[,()%*\\]/g, " ");
    q = q.or(`email.ilike.%${safe}%,first_name.ilike.%${safe}%,last_name.ilike.%${safe}%,company.ilike.%${safe}%`);
  }
  if (f.tag) q = q.contains("tags", [f.tag]);
  if (f.status) q = q.eq("status", f.status);
  if (f.check === "unchecked") q = q.is("verify_status", null);
  else if (f.check) q = q.eq("verify_status", f.check);
  return q as unknown as Q;
}

/** The filter as URL params (for links to the export route and to the page). */
export function leadFilterParams(f: LeadFilter): URLSearchParams {
  const p = new URLSearchParams();
  for (const k of ["q", "tag", "status", "check"] as const) if (f[k]) p.set(k, f[k]!);
  return p;
}
