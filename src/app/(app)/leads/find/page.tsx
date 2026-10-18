import { connection } from "next/server";
import { Suspense } from "react";
import type { CampaignOption } from "@/components/add-leads";
import { PageHeader, Skeleton } from "@/components/ui";
import { getCachedSmtpCapability } from "@/lib/email-verify";
import { db, must } from "@/lib/supabase";
import { LeadsTabs } from "../tabs";
import { FindView } from "./find-client";

export const metadata = { title: "Find & verify" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function FindPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <PageHeader title="Leads" description="Find someone's work email from their name and company, or check addresses before you send."
        tabs={<LeadsTabs active="find" />} />
      <Suspense fallback={<div className="grid gap-4"><Skeleton className="h-9 w-64" /><Skeleton className="h-44" /><Skeleton className="h-40" /></div>}>
        <FindData params={searchParams} />
      </Suspense>
    </>
  );
}

async function FindData({ params }: { params: SearchParams }) {
  const sp = await params;
  await connection();
  // The SMTP capability is only read from app_state (the engine keeps it fresh); never probed here.
  const [rows, smtp] = await Promise.all([
    db().from("campaigns").select("id, name, status").order("created_at", { ascending: false }).then(must) as Promise<CampaignOption[]>,
    getCachedSmtpCapability(),
  ]);
  const campaigns = [...rows.filter((c) => c.status !== "completed"), ...rows.filter((c) => c.status === "completed")];
  const preset = typeof sp.campaign === "string" && campaigns.some((c) => c.id === sp.campaign) ? sp.campaign : "";
  return <FindView campaigns={campaigns} presetCampaign={preset} smtpUnavailable={smtp?.ok === false} />;
}
