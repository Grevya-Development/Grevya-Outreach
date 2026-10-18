// Campaign header (name, status, primary action, ⋯ menu, banners) and the step/tab bar. Server
// components; the interactive bits come from campaign-client.tsx.
import { AlertTriangle, ArrowLeft, Bot, CirclePause, CircleStop, Plus, Rocket, Unplug } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, ButtonLink, Progress, StatusBadge, Stepper, TabLinks, type StepState } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import { getProfile } from "@/lib/profile";
import { Banner, CampaignActionButton, CampaignMenu, RenameTitle } from "./campaign-client";
import {
  BUILDER_STEPS, getAiProgress, getCampaign, getEngine, getStuckCount, resolveView, STEP_LABELS, viewHref,
} from "./data";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** "about 2 h left" at roughly 3 emails a minute. */
function timeLeft(writing: number): string {
  const min = Math.ceil(writing / 3);
  return min < 60 ? `about ${min} min left` : `about ${Math.round(min / 60)} h left`;
}

export async function CampaignHeader({ params }: { params: Params }) {
  const { id } = await params;
  const data = await getCampaign(id);
  if (!data) notFound();
  const { campaign: c, stats, statusCounts } = data;
  const ai = c.mode === "ai";
  const draft = c.status === "draft";
  const attached = data.mailboxes.filter((m) => data.attachedIds.includes(m.id));
  const healthy = attached.filter((m) => m.status === "active");
  const [engine, progress, stuck, profile] = await Promise.all([
    getEngine(),
    ai ? getAiProgress(id) : null,
    getStuckCount(id, healthy.map((m) => m.id).sort().join(",")),
    ai ? getProfile() : null,
  ]);
  const failed = statusCounts.failed ?? 0;
  const unconfirmed = data.hasConfirm && !c.sequence_confirmed_at;
  const sched = viewHref(id, "schedule", draft);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Link href="/campaigns" className="inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-ink mb-1"><ArrowLeft size={13} />Campaigns</Link>
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            <RenameTitle key={c.name} id={c.id} name={c.name} />
            <StatusBadge status={c.status} kind="campaign" />
            <Badge tone={ai ? "accent" : "neutral"}>{ai ? "AI-written" : "Template"}</Badge>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {draft && <ButtonLink href={viewHref(id, "launch", true)} variant="primary" scroll={false}><Rocket size={15} />Launch campaign</ButtonLink>}
          {c.status === "active" && <CampaignActionButton id={id} kind="pause" size="md">Pause</CampaignActionButton>}
          {c.status === "paused" && <CampaignActionButton id={id} kind="resume" variant="primary" size="md">Resume</CampaignActionButton>}
          {c.status === "completed" && <ButtonLink href={`/campaigns/${id}?tab=leads&add=list`} variant="primary" scroll={false}><Plus size={15} />Add leads</ButtonLink>}
          <CampaignMenu id={id} name={c.name} unsentLeads={stats?.remaining ?? 0} stepCount={data.steps.length} defaultTo={(healthy[0] ?? attached[0])?.email ?? ""} />
        </div>
      </div>

      {c.status === "active" && engine?.paused && (
        <Banner tone="warn" icon={<CirclePause size={15} />} action={<ButtonLink href="/settings/sending" size="sm">Sending settings</ButtonLink>}>
          Sending is paused for every campaign. Nothing goes out until you resume it.
        </Banner>
      )}
      {c.status === "active" && engine && !engine.paused && !engine.alive && (
        <Banner tone="bad" icon={<CircleStop size={15} />} action={<ButtonLink href="/settings/sending" size="sm">Sending settings</ButtonLink>}>
          Sending stopped: the sending engine isn&apos;t running, so no emails go out.
        </Banner>
      )}
      {!healthy.length && (
        <Banner tone="warn" icon={<Unplug size={15} />} action={<ButtonLink href={sched} size="sm" scroll={false}>Choose accounts</ButtonLink>}>
          {attached.length ? "Every email account in this campaign is paused or needs attention." : "No email account is selected for this campaign."}
        </Banner>
      )}
      {ai && profile && !profile.services.trim() && (
        <Banner tone="warn" icon={<AlertTriangle size={15} />} action={<ButtonLink href="/settings" size="sm">Fill in profile</ButtonLink>}>
          The AI doesn&apos;t know what you sell yet. Every email is written from your company profile.
        </Banner>
      )}
      {stuck > 0 && (
        <Banner tone="warn" icon={<AlertTriangle size={15} />} action={<CampaignActionButton id={id} kind="reassign">Move to active accounts</CampaignActionButton>}>
          {fmtNum(stuck)} lead{stuck === 1 ? " is" : "s are"} waiting on an account that is paused, needs attention or is no longer in this campaign.
        </Banner>
      )}
      {failed > 0 && (
        <Banner tone="bad" icon={<AlertTriangle size={15} />} action={<CampaignActionButton id={id} kind="retryFailed">Retry</CampaignActionButton>}>
          {fmtNum(failed)} lead{failed === 1 ? "" : "s"} couldn&apos;t be sent to after several tries. <Link href={`/campaigns/${id}?tab=leads&status=failed`} className="underline">See why</Link>
        </Banner>
      )}
      {progress && progress.failed > 0 && (
        <Banner tone="bad" icon={<Bot size={15} />} action={<CampaignActionButton id={id} kind="retryAi">Retry</CampaignActionButton>}>
          The AI couldn&apos;t write {fmtNum(progress.failed)} lead{progress.failed === 1 ? "'s" : "s'"} emails. <Link href={`/campaigns/${id}?tab=review&view=failed`} className="underline">See why</Link>
        </Banner>
      )}
      {progress && progress.total > 0 && progress.writing > 0 && (unconfirmed ? (
        <Banner tone="info" icon={<Bot size={15} />}>
          AI starts researching and writing once you save the sequence.
        </Banner>
      ) : (
        <div className="rounded-xl border border-line bg-panel px-4 py-3 grid gap-2">
          <div className="flex flex-wrap items-center gap-x-2 text-[13px]">
            <Bot size={15} className="text-accent" />
            <span>AI is writing: <b className="tabular-nums">{fmtNum(progress.total - progress.writing)}</b> of <b className="tabular-nums">{fmtNum(progress.total)}</b> done</span>
            <span className="text-muted">· {timeLeft(progress.writing)}</span>
          </div>
          <Progress value={progress.total - progress.writing} max={progress.total} />
        </div>
      ))}
    </div>
  );
}

/** Draft: the 5-step builder. Live: Analytics · Leads · Review (AI) · Sequence · Schedule · Options. */
export async function CampaignNav({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const data = await getCampaign(id);
  if (!data) notFound();
  const { campaign: c } = data;
  const draft = c.status === "draft";
  const { view } = resolveView(sp, draft);

  if (draft) {
    const current = (BUILDER_STEPS as readonly string[]).indexOf(view);
    // A step counts as done once its data is there, so you can jump back and forth.
    const confirmed = data.hasConfirm ? !!c.sequence_confirmed_at : false;
    const hasLeads = (data.stats?.leads ?? 0) > 0;
    const hasAccounts = data.attachedIds.length > 0;
    const doneByData = [hasLeads, confirmed, confirmed && hasAccounts, confirmed && hasAccounts, false];
    const steps = BUILDER_STEPS.map((s, i) => {
      const state: StepState = i === current ? "current" : i < current || doneByData[i] ? "done" : "todo";
      return { label: STEP_LABELS[s], href: viewHref(id, s, true), state };
    });
    return <div className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"><Stepper steps={steps} /></div>;
  }

  const progress = c.mode === "ai" ? await getAiProgress(id) : null;
  const tab = (t: string) => `/campaigns/${id}?tab=${t}`;
  return (
    <TabLinks items={[
      { href: tab("analytics"), label: "Analytics", active: view === "analytics" },
      { href: tab("leads"), label: "Leads", count: data.stats?.leads ?? 0, active: view === "leads" },
      ...(progress ? [{ href: tab("review"), label: "Review", count: progress.review, dot: progress.review > 0, active: view === "review" }] : []),
      { href: tab("sequence"), label: "Sequence", active: view === "sequence" },
      { href: tab("schedule"), label: "Schedule", active: view === "schedule" },
      { href: tab("options"), label: "Options", active: view === "options" },
    ]} />
  );
}
