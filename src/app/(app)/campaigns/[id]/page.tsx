import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Skeleton, TableSkeleton } from "@/components/ui";
import { getProfile } from "@/lib/profile";
import { db, must } from "@/lib/supabase";
import type { Campaign, CampaignStats, CampaignStep, Mailbox, PublicMailbox } from "@/lib/types";
import { CampaignView, type CampaignLeadRow } from "./campaign-client";

export default function CampaignPage({ params }: PageProps<"/campaigns/[id]">) {
  return (
    <Suspense fallback={<div className="grid gap-4"><Skeleton className="h-8 w-64" /><div className="grid grid-cols-2 sm:grid-cols-5 gap-3">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-20" />)}</div><TableSkeleton /></div>}>
      <CampaignData params={params} />
    </Suspense>
  );
}

async function CampaignData({ params }: { params: PageProps<"/campaigns/[id]">["params"] }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supa = db();
  const [campaignRes, steps, mailboxes, attached, stats, leads, tags, counts, prep, profile] = await Promise.all([
    supa.from("campaigns").select("*").eq("id", id).maybeSingle(),
    supa.from("campaign_steps").select("*").eq("campaign_id", id).order("step_number").then(must),
    supa.from("mailboxes").select("*").order("created_at").then(must),
    supa.from("campaign_mailboxes").select("mailbox_id").eq("campaign_id", id).then(must),
    supa.rpc("campaign_stats").then(must),
    supa.from("campaign_leads")
      .select("id, status, current_step, next_send_at, last_error, personalization, prep_status, prep_error, fit_score, skip_reason, mailbox_id, leads(*)")
      .eq("campaign_id", id).order("created_at").limit(500).then(must),
    supa.rpc("lead_tags").then(must),
    supa.rpc("campaign_status_counts", { p_campaign: id }).then(must),
    supa.rpc("campaign_prep_counts", { p_campaign: id }).then(must),
    getProfile(),
  ]);
  const campaign = campaignRes.data as Campaign | null;
  if (!campaign) notFound();

  const statusCounts: Record<string, number> = {};
  for (const r of counts as { status: string; n: number }[]) statusCounts[r.status] = Number(r.n);
  const prepCounts: Record<string, number> = {};
  for (const r of prep as { prep_status: string; n: number }[]) prepCounts[r.prep_status] = Number(r.n);
  const mbList = (mailboxes as Mailbox[]).map(({ password_enc: _p, ...m }) => m as PublicMailbox);
  const attachedIds = (attached as { mailbox_id: string }[]).map((a) => a.mailbox_id);
  const healthy = new Set(mbList.filter((m) => m.status === "active" && attachedIds.includes(m.id)).map((m) => m.id));
  const stuck = (leads as unknown as CampaignLeadRow[]).filter((l) => ["queued", "in_progress"].includes(l.status) && l.mailbox_id && !healthy.has(l.mailbox_id)).length;

  return (
    <CampaignView
      campaign={campaign}
      steps={steps as CampaignStep[]}
      mailboxes={mbList}
      attachedMailboxIds={attachedIds}
      stats={(stats as CampaignStats[]).find((s) => s.campaign_id === id) ?? null}
      leads={leads as unknown as CampaignLeadRow[]}
      statusCounts={statusCounts}
      tags={tags as { tag: string; n: number }[]}
      prepCounts={prepCounts}
      stuck={stuck}
      profileReady={Boolean(profile.services.trim())}
    />
  );
}
