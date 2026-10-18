"use client";

import { AlertTriangle, Check, Play, Rocket, Send, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { setCampaignStatus } from "@/app/actions/campaigns";
import { Spinner, useAction, useConfirm } from "@/components/client";
import { Button, Card, CardHeader, cx } from "@/components/ui";
import { fmtDate, fmtDay, fmtNum, fmtTime } from "@/lib/format";
import type { LaunchChecklist } from "@/lib/launch-checklist";
import { BuilderFooter } from "./builder";
import { TestStepDialog } from "./campaign-client";

export function LaunchStep({ campaign, checklist, builder, backHref, stepCount, defaultTo }: {
  campaign: { id: string; name: string; status: string };
  checklist: LaunchChecklist;
  builder: boolean;
  backHref?: string;
  stepCount: number;
  defaultTo: string;
}) {
  const router = useRouter();
  const [launching, run] = useAction();
  const { confirm, element } = useConfirm();
  const [testOpen, setTestOpen] = useState(false);
  const { items, summary } = checklist;
  const blockers = items.filter((i) => i.blocking && !i.ok);
  const live = campaign.status === "active";

  const launch = async () => {
    const ok = await confirm({
      title: campaign.status === "paused" ? `Resume ${campaign.name}?` : `Launch ${campaign.name}?`,
      body: `Start sending to ${fmtNum(summary.leads)} lead${summary.leads === 1 ? "" : "s"} from ${fmtNum(summary.accounts)} account${summary.accounts === 1 ? "" : "s"}${summary.window ? `, ${summary.window}` : ""}?`,
      confirmLabel: campaign.status === "paused" ? "Resume" : "Launch campaign",
    });
    if (!ok) return;
    run(() => setCampaignStatus(campaign.id, "active"), () => router.replace(`/campaigns/${campaign.id}?tab=analytics`));
  };

  return (
    <div className="grid gap-4 min-w-0">
      <Card>
        <CardHeader title={live ? "Launch checklist" : blockers.length ? "Almost ready" : "Ready to launch"}
          description={live ? "This campaign is live. These checks still apply." : blockers.length ? `${blockers.length} thing${blockers.length === 1 ? "" : "s"} to fix before launching.` : "Everything needed is in place."}
          actions={<Button size="sm" onClick={() => setTestOpen(true)} disabled={!stepCount}><Send size={14} />Send me a test of Email 1</Button>} />
        <ul className="border-t border-line divide-y divide-line">
          {items.map((i) => {
            const state = i.ok ? "ok" : i.blocking ? "bad" : "warn";
            return (
              <li key={i.key} className="flex items-start gap-3 px-4 py-3">
                <span className={cx("grid place-items-center size-5 rounded-full shrink-0 mt-0.5",
                  state === "ok" && "bg-good-soft text-good", state === "bad" && "bg-bad-soft text-bad", state === "warn" && "bg-warn-soft text-warn")}>
                  {state === "ok" ? <Check size={12} strokeWidth={3} /> : state === "bad" ? <X size={12} strokeWidth={3} /> : <AlertTriangle size={11} strokeWidth={2.6} />}
                </span>
                <div className="flex-1 min-w-0">
                  <div className={cx("text-[13.5px]", state === "bad" && "font-medium")}>{i.label}</div>
                  {i.detail && <div className="text-[12.5px] text-muted mt-0.5">{i.detail}</div>}
                </div>
                {!i.ok && <Link href={i.fixHref} scroll={false} className="text-[12.5px] font-medium text-accent hover:underline shrink-0 mt-0.5">Fix</Link>}
              </li>
            );
          })}
        </ul>
        {summary.nextSend && summary.effectivePerDay > 0 && (
          <p className="px-4 py-3 border-t border-line text-[13px] text-muted">
            First emails go to about <b className="text-ink tabular-nums">{fmtNum(summary.effectivePerDay)}/day</b> starting <b className="text-ink">{fmtDay(summary.nextSend)} {fmtTime(summary.nextSend)}</b>
            {summary.finishDate && <>; the sequence finishes around <b className="text-ink">{fmtDate(summary.finishDate)}</b></>}.
          </p>
        )}
        {!builder && campaign.status === "paused" && (
          <div className="px-4 py-3 border-t border-line flex justify-end">
            <Button onClick={launch} disabled={launching || blockers.length > 0}>{launching ? <Spinner /> : <Play size={14} />}Resume</Button>
          </div>
        )}
      </Card>

      {builder && (
        <BuilderFooter backHref={backHref} onSaveAndContinue={launch} saving={launching} disabled={blockers.length > 0}
          note={blockers.length ? "Fix the red items first" : undefined} nextLabel={<><Rocket size={15} />Launch campaign</>} />
      )}
      {testOpen && <TestStepDialog campaignId={campaign.id} stepCount={stepCount} defaultTo={defaultTo} defaultStep={0} onClose={() => setTestOpen(false)} />}
      {element}
    </div>
  );
}
