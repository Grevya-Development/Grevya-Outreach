"use client";

import { Repeat, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { changeWritingMode, saveCampaignSettings, type CampaignSettings } from "@/app/actions/campaigns";
import { Spinner, useAction, useConfirm } from "@/components/client";
import { Button, Card, CardHeader, Field, Select, Textarea } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import { EditFooter, useUnsavedGuard } from "./builder";
import { Toggle } from "./campaign-client";
import { PlaybookCard } from "./playbook-card";
import type { Playbook } from "@/lib/playbook-shared";

type Options = Pick<CampaignSettings, "stop_on_reply" | "include_unsubscribe" | "track_opens" | "track_clicks" | "require_approval" | "min_fit_score" | "sender_context" | "ai_prompt" | "ai_enabled">;

export function OptionsTab({ campaign, builder, writtenCount, playbook, backHref, nextHref }: {
  campaign: Options & { id: string; status: string; mode: "ai" | "template" };
  builder: boolean;
  /** AI emails written for leads not yet contacted (deleted when the writing mode changes). */
  writtenCount: number;
  /** AI mode only: the effective playbook for this campaign. */
  playbook?: Playbook;
  backHref?: string;
  nextHref?: string;
}) {
  const router = useRouter();
  const ai = campaign.mode === "ai";
  const initial: Options = {
    stop_on_reply: campaign.stop_on_reply, include_unsubscribe: campaign.include_unsubscribe, track_opens: campaign.track_opens,
    track_clicks: campaign.track_clicks, require_approval: campaign.require_approval, min_fit_score: campaign.min_fit_score,
    sender_context: campaign.sender_context, ai_prompt: campaign.ai_prompt, ai_enabled: campaign.ai_enabled,
  };
  const [f, setF] = useState<Options>(initial);
  const [saving, run] = useAction();
  const [switching, runSwitch] = useAction();
  const { confirm, element } = useConfirm();
  const set = <K extends keyof Options>(k: K, v: Options[K]) => setF((p) => ({ ...p, [k]: v }));
  const changed = (Object.keys(initial) as (keyof Options)[]).filter((k) => f[k] !== initial[k]);
  const dirty = changed.length > 0;
  useUnsavedGuard(dirty);

  const save = () => {
    if (builder && !dirty && nextHref) return router.push(nextHref, { scroll: false });
    const patch = Object.fromEntries(changed.map((k) => [k, f[k]])) as Partial<Options>;
    run(() => saveCampaignSettings(campaign.id, patch), () => { if (builder && nextHref) router.push(nextHref, { scroll: false }); });
  };

  const other = ai ? "template" : "ai";
  const switchMode = async () => {
    const ok = await confirm({
      title: `Switch to ${other === "ai" ? "AI-written" : "Template"} emails?`,
      body: `This pauses the campaign, replaces the sequence with the ${other === "ai" ? "AI-written" : "Template"} starter, and deletes ${fmtNum(writtenCount)} written email${writtenCount === 1 ? "" : "s"}. Emails already sent are not affected.`,
      confirmLabel: "Change writing mode", tone: "danger",
    });
    if (ok) runSwitch(() => changeWritingMode(campaign.id, other));
  };

  return (
    <div className="grid grid-cols-1 gap-4 min-w-0">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <Card>
          <CardHeader title="Sending" />
          <div className="grid gap-4 px-4 pb-4">
            <Toggle label="Stop when they reply" hint="A lead gets no more emails from this campaign once they reply." checked={f.stop_on_reply} onChange={(v) => set("stop_on_reply", v)} />
            <Toggle label="Add opt-out line and unsubscribe header"
              hint="Adds “reply no and I won't email again” plus the header Gmail and Yahoo use for their Unsubscribe button. Keep it on: anti-spam rules require it."
              checked={f.include_unsubscribe} onChange={(v) => set("include_unsubscribe", v)} />
            <Toggle label="Track opens" hint="Off by default: the tracking image can hurt inbox placement, and Apple Mail inflates opens. Replies are what count."
              checked={f.track_opens} onChange={(v) => set("track_opens", v)} />
            <Toggle label="Track link clicks" hint="Sends links through this app's address first (needs a public APP_URL)." checked={f.track_clicks} onChange={(v) => set("track_clicks", v)} />
          </div>
        </Card>

        <Card>
          <CardHeader title={<span className="flex items-center gap-1.5"><Sparkles size={15} className="text-accent" />AI</span>} />
          <div className="grid gap-4 px-4 pb-4">
            {ai ? (
              <>
                <Toggle label="Review AI emails before they send" hint="Each email waits in Review until you approve it. Good for the first few days; turn it off once you trust the AI."
                  checked={f.require_approval} onChange={(v) => set("require_approval", v)} />
                <Field label="Skip companies with fit below" hint="How well the company matches who you sell to, judged by AI from their website (0–10). Low-fit leads are skipped so your daily emails go to the best ones.">
                  <Select value={f.min_fit_score} onChange={(e) => set("min_fit_score", Number(e.target.value))}>
                    {[0, 1, 2, 3, 4, 5, 6, 7].map((v) => <option key={v} value={v}>{v === 0 ? "Don't skip any" : `Fit ${v}/10`}</option>)}
                  </Select>
                </Field>
              </>
            ) : (
              <Toggle label="Write an AI opening line for each lead" hint="Fills the AI opening line field with one sentence about their company."
                checked={f.ai_enabled} onChange={(v) => set("ai_enabled", v)} />
            )}
            {(ai || f.ai_enabled) && (
              <>
                <Field label="Who this campaign targets" hint="Added to your company profile for this campaign only.">
                  <Textarea rows={3} value={f.sender_context} onChange={(e) => set("sender_context", e.target.value)}
                    placeholder="e.g. Operations heads at mid-size manufacturers in South India who still process invoices by hand." />
                </Field>
                <Field label="Extra instructions for the AI" hint={ai ? "Optional. Most writing choices live in the AI playbook below." : "Optional: tone, what to stress, what to avoid."}>
                  <Textarea rows={3} value={f.ai_prompt} onChange={(e) => set("ai_prompt", e.target.value)}
                    placeholder="e.g. Lead with document processing. Keep it under 90 words." />
                </Field>
              </>
            )}
          </div>
        </Card>
      </div>

      {ai && playbook && <PlaybookCard campaignId={campaign.id} playbook={playbook} />}

      <Card className="border-bad/30">
        <CardHeader title="Danger zone" description={`Emails are ${ai ? "AI-written" : "written from your template"}. Changing this resets the sequence.`}
          actions={<Button variant="danger" onClick={switchMode} disabled={switching}>{switching ? <Spinner /> : <Repeat size={14} />}Change writing mode…</Button>} />
      </Card>

      <EditFooter builder={builder} backHref={backHref} dirty={dirty} saving={saving} onSave={save} onDiscard={() => setF(initial)} />
      {element}
    </div>
  );
}
