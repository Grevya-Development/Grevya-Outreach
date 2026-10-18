import { Suspense } from "react";
import { connection } from "next/server";
import { AddLeadsButton } from "@/components/add-leads";
import { Button, PageHeader, TableSkeleton } from "@/components/ui";
import { db, must } from "@/lib/supabase";
import type { Lead } from "@/lib/types";
import { ImportButton, LeadsFilters, LeadsTable, VerifyAllButton } from "./leads-client";

export const metadata = { title: "Leads" };
const PAGE = 100;

export default function LeadsPage({ searchParams }: PageProps<"/leads">) {
  return (
    <>
      <PageHeader title="Leads" description="Everyone you can email. Add people by hand, paste a list, or import a CSV — then add them to a campaign."
        actions={<>
          <VerifyAllButton />
          <Suspense fallback={<Button disabled>Add leads</Button>}><AddLeads /></Suspense>
          <ImportButton />
        </>} />
      <Suspense fallback={<TableSkeleton rows={10} />}>
        <LeadsData params={searchParams} />
      </Suspense>
    </>
  );
}

async function AddLeads() {
  await connection();
  const campaigns = must(await db().from("campaigns").select("id, name").neq("status", "completed").order("created_at", { ascending: false })) as { id: string; name: string }[];
  return <AddLeadsButton campaigns={campaigns} />;
}

async function LeadsData({ params }: { params: PageProps<"/leads">["searchParams"] }) {
  const sp = await params;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const tag = typeof sp.tag === "string" ? sp.tag : "";
  const status = typeof sp.status === "string" ? sp.status : "";
  const page = Math.max(1, Number(sp.page) || 1);

  const supa = db();
  let query = supa.from("leads").select("*", { count: "exact" }).order("created_at", { ascending: false }).range((page - 1) * PAGE, page * PAGE - 1);
  if (q) {
    const safe = q.replace(/[,()%]/g, " ");
    query = query.or(`email.ilike.%${safe}%,first_name.ilike.%${safe}%,last_name.ilike.%${safe}%,company.ilike.%${safe}%`);
  }
  if (tag) query = query.contains("tags", [tag]);
  if (status) query = query.eq("status", status);

  const [res, tags] = await Promise.all([query, supa.rpc("lead_tags").then(must)]);
  if (res.error) throw new Error(res.error.message);

  return (
    <div className="grid gap-3">
      <LeadsFilters q={q} tag={tag} status={status} tags={tags as { tag: string; n: number }[]} />
      <LeadsTable leads={(res.data ?? []) as Lead[]} total={res.count ?? 0} page={page} pageSize={PAGE} />
    </div>
  );
}
