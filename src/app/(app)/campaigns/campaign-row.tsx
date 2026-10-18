"use client";

import { Copy, MoreHorizontal, Pause, Play, Trash2 } from "lucide-react";
import { useTransition } from "react";
import { deleteCampaign, duplicateCampaign, setCampaignStatus } from "@/app/actions/campaigns";
import { Menu, Spinner, useAction, useConfirm } from "@/components/client";
import { Button } from "@/components/ui";
import { fmtNum } from "@/lib/format";

/** The row's ⏸/▶ button and ⋯ menu (Duplicate, Delete) on the Campaigns list. */
export function CampaignRowActions({ id, name, status, unsentLeads }: { id: string; name: string; status: string; unsentLeads: number }) {
  const [pending, run] = useAction();
  const [busy, start] = useTransition();
  const { confirm, element } = useConfirm();
  const remove = async () => {
    const ok = await confirm({
      title: `Delete "${name}"?`,
      body: unsentLeads
        ? `Emails not yet sent to ${fmtNum(unsentLeads)} lead${unsentLeads === 1 ? "" : "s"} will be cancelled. Sent history stays in totals.`
        : "Sent history stays in totals.",
      confirmLabel: "Delete campaign", tone: "danger",
    });
    if (ok) start(() => deleteCampaign(id));
  };
  return (
    <div className="flex items-center justify-end gap-0.5">
      {(status === "active" || status === "paused") && (
        <Button variant="ghost" size="sm" className="w-8 px-0" disabled={pending}
          aria-label={status === "active" ? `Pause ${name}` : `Resume ${name}`} title={status === "active" ? "Pause" : "Resume"}
          onClick={() => run(() => setCampaignStatus(id, status === "active" ? "paused" : "active"))}>
          {pending ? <Spinner /> : status === "active" ? <Pause size={15} /> : <Play size={15} />}
        </Button>
      )}
      <Menu align="end"
        trigger={<Button variant="ghost" size="sm" className="w-8 px-0" aria-label={`More actions for ${name}`} disabled={busy}>{busy ? <Spinner /> : <MoreHorizontal size={16} />}</Button>}
        items={[
          { label: "Duplicate", icon: <Copy />, onSelect: () => start(() => duplicateCampaign(id)) },
          { label: "Delete", icon: <Trash2 />, tone: "danger", onSelect: () => void remove() },
        ]} />
      {element}
    </div>
  );
}
