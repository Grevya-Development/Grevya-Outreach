import { connection } from "next/server";
import { Send } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { Card, Empty, PageHeader, StatusBadge, TableSkeleton, Td, Th, pct } from "@/components/ui";
import { db, must } from "@/lib/supabase";
import type { Campaign, CampaignStats } from "@/lib/types";
import { NewCampaignButton } from "./new-campaign";

export const metadata = { title: "Campaigns" };

export default function CampaignsPage() {
  return (
    <>
      <PageHeader title="Campaigns" description="Sequences of personalised emails with automatic follow-ups." actions={<NewCampaignButton />} />
      <Suspense fallback={<TableSkeleton rows={5} />}>
        <CampaignList />
      </Suspense>
    </>
  );
}

async function CampaignList() {
  await connection(); // always fresh data, never prerendered
  const supa = db();
  const [campaigns, stats] = await Promise.all([
    supa.from("campaigns").select("*").order("created_at", { ascending: false }).then(must),
    supa.rpc("campaign_stats").then(must),
  ]);
  const byId = new Map((stats as CampaignStats[]).map((s) => [s.campaign_id, s]));
  const list = campaigns as Campaign[];

  if (!list.length) {
    return <Card><Empty icon={<Send size={28} />} title="No campaigns yet" action={<NewCampaignButton />}>
      A campaign is a few emails (first touch + follow-ups) sent to a set of leads. Replies stop the sequence automatically.
    </Empty></Card>;
  }

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead className="bg-panel-2/50">
            <tr><Th>Campaign</Th><Th>Status</Th><Th className="text-right">Leads</Th><Th className="text-right">Sent</Th><Th className="text-right">Replied</Th><Th className="text-right">Bounced</Th><Th className="text-right">Left</Th></tr>
          </thead>
          <tbody>
            {list.map((c) => {
              const s = byId.get(c.id);
              const leads = Number(s?.leads ?? 0);
              return (
                <tr key={c.id} className="hover:bg-panel-2/60 transition-colors">
                  <Td className="font-medium p-0"><Link href={`/campaigns/${c.id}`} className="block px-3 py-3">{c.name}</Link></Td>
                  <Td><StatusBadge status={c.status} /></Td>
                  <Td className="text-right tabular-nums">{leads}</Td>
                  <Td className="text-right tabular-nums">{Number(s?.sent ?? 0)}</Td>
                  <Td className="text-right tabular-nums">{Number(s?.replied ?? 0)} <span className="text-faint">{pct(Number(s?.replied ?? 0), leads - Number(s?.remaining ?? 0) || leads)}</span></Td>
                  <Td className="text-right tabular-nums">{Number(s?.bounced ?? 0)}</Td>
                  <Td className="text-right tabular-nums text-muted">{Number(s?.remaining ?? 0)}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
