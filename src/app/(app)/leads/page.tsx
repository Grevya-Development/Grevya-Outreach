import { ChevronDown, Plus } from "lucide-react";
import { redirect } from "next/navigation";
import { cache, Suspense } from "react";
import { AddLeadsButton, type AddLeadsTab, type CampaignOption } from "@/components/add-leads";
import { Button, PageHeader, Skeleton, TableSkeleton } from "@/components/ui";
import { getEngineState } from "@/lib/app-state";
import { db, must } from "@/lib/supabase";
import type { Lead } from "@/lib/types";
import { LeadDrawerHost, LeadsFilters, LeadsTable, ListsRail } from "./leads-client";
import { applyLeadFilter, hasLeadFilter, LeadsTabs, parseLeadFilter } from "./tabs";

export const metadata = { title: "Leads" };
const PAGE = 100;

type SearchParams = PageProps<"/leads">["searchParams"];

export default function LeadsPage({ searchParams }: PageProps<"/leads">) {
  return (
    <>
      <PageHeader title="Leads" description="Everyone you can email. Import a CSV, paste a list or add one lead, then put them in a campaign."
        tabs={<LeadsTabs active="all" />}
        actions={
          <Suspense fallback={<AddLeadsFallback />}>
            <AddLeadsData params={searchParams} />
          </Suspense>
        } />
      <Suspense fallback={<LeadsSkeleton />}>
        <LeadsData params={searchParams} />
      </Suspense>
    </>
  );
}

function AddLeadsFallback() {
  return (
    <div className="inline-flex">
      <Button variant="primary" disabled className="rounded-r-none"><Plus size={15} />Add leads</Button>
      <Button variant="primary" disabled className="rounded-l-none w-8 px-0 border-l border-accent-ink/25" aria-label="More ways to add leads"><ChevronDown size={15} /></Button>
    </div>
  );
}

function LeadsSkeleton() {
  return (
    <div className="grid lg:grid-cols-[200px_minmax(0,1fr)] gap-4">
      <div className="hidden lg:grid gap-2 content-start">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-7" />)}</div>
      <div className="grid gap-3 min-w-0"><Skeleton className="h-9 max-w-xl" /><TableSkeleton rows={10} /></div>
    </div>
  );
}

/** Campaigns for the pickers: running/draft ones first, finished ones last (they're flagged in the UI). Shared per request. */
const getCampaigns = cache(async (): Promise<CampaignOption[]> => {
  const rows = must(await db().from("campaigns").select("id, name, status").order("created_at", { ascending: false })) as CampaignOption[];
  return [...rows.filter((c) => c.status !== "completed"), ...rows.filter((c) => c.status === "completed")];
});

async function AddLeadsData({ params }: { params: SearchParams }) {
  const sp = await params;
  const add = typeof sp.add === "string" && ["csv", "paste", "one"].includes(sp.add) ? (sp.add as AddLeadsTab) : undefined;
  const campaigns = await getCampaigns();
  // Keyed so arriving at ?add=… again (a link from another page) opens the dialog again.
  return <AddLeadsButton key={add ?? "-"} split campaigns={campaigns} defaultOpen={!!add} defaultTab={add} />;
}

async function LeadsData({ params }: { params: SearchParams }) {
  const sp = await params;
  const filter = parseLeadFilter((k) => sp[k]);
  const page = Math.max(1, Math.floor(Number(sp.page)) || 1);
  const filtered = hasLeadFilter(filter);

  const supa = db();
  const query = applyLeadFilter(supa.from("leads").select("*", { count: "exact" }), filter)
    .order("created_at", { ascending: false }).order("id")
    .range((page - 1) * PAGE, page * PAGE - 1);
  const [res, tags, engine, unchecked, allCount, campaigns] = await Promise.all([
    query,
    supa.rpc("lead_tags").then(must) as Promise<{ tag: string; n: number }[]>,
    getEngineState().catch(() => null),
    supa.from("leads").select("id", { count: "exact", head: true }).is("verify_status", null).then((r) => r.count ?? 0),
    // "All leads · N" in the rail (the main query already counts it when nothing is filtered).
    filtered ? supa.from("leads").select("id", { count: "exact", head: true }).then((r) => r.count ?? 0) : Promise.resolve(null),
    getCampaigns(),
  ]);

  // Past the last page (an old link, or the last rows were deleted): go to the last page instead of failing.
  const outOfRange = res.error && (res.error.code === "PGRST103" || res.status === 416);
  if (res.error && !outOfRange) throw new Error(res.error.message);
  let total = res.count;
  if (outOfRange || (total != null && page > 1 && (page - 1) * PAGE >= total)) {
    if (total == null) {
      const { count } = await applyLeadFilter(supa.from("leads").select("id", { count: "exact", head: true }), filter);
      total = count ?? 0;
    }
    const last = Math.max(1, Math.ceil(total / PAGE));
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && k !== "page") next.set(k, v);
    if (last > 1) next.set("page", String(last));
    const qs = next.toString();
    redirect(qs ? `/leads?${qs}` : "/leads");
  }

  const checking = !!engine?.alive;
  const tagCounts = tags.map((t) => ({ tag: t.tag, n: Number(t.n) || 0 }));
  return (
    <div className="grid lg:grid-cols-[200px_minmax(0,1fr)] gap-4 items-start">
      <ListsRail tags={tagCounts} total={allCount ?? total ?? 0} active={filter.tag} campaigns={campaigns} />
      <div className="grid gap-3 min-w-0">
        <LeadsFilters filter={filter} tags={tagCounts} />
        <LeadsTable key={`${JSON.stringify(filter)}:${page}`} leads={(res.data ?? []) as Lead[]} total={total ?? 0} page={page} pageSize={PAGE}
          filter={filter} checking={checking} unchecked={unchecked} campaigns={campaigns} tags={tagCounts} />
      </div>
      <LeadDrawerHost campaigns={campaigns} checking={checking} />
    </div>
  );
}
