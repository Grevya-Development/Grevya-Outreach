"use client";

import { CheckCheck, ChevronLeft, Globe, Inbox, MoreHorizontal, RefreshCw, Send, SkipForward, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";
import { approveLeads, rewriteLeads, skipCampaignLeads, updateLeadDraft } from "@/app/actions/campaigns";
import { Menu, ShortcutHelp, Spinner, useConfirm, useHotkeys, usePoll } from "@/components/client";
import { Badge, Button, Card, Empty, Input, Kbd, Textarea, cx } from "@/components/ui";
import { fmtDay, fmtNum, fmtTime } from "@/lib/format";
import { FilterChip, TestStepDialog } from "./campaign-client";

export type ReviewQueueItem = { id: string; name: string; company: string; fit: number | null };
export type ReviewSelected = {
  id: string;
  prepError: string | null;
  edited: boolean;
  lead: { name: string; email: string; title: string; company: string; website: string };
  fit: number | null;
  research: { whatTheyDo: string; facts: string[]; bestService: string; angle: string; fitReason: string; failed: string | null } | null;
  emails: { subject: string; body: string }[];
  /** 'Day 0', 'after 3 days', … per email. */
  sends: string[];
  from: string;
};

type View = "to_review" | "failed";

/* Approvals made in this browser tab (sessionStorage), so "Approve all remaining" only shows up after reading a few. */
const SESSION_EVENT = "grevya:review-approved";
function subscribe(cb: () => void) {
  window.addEventListener(SESSION_EVENT, cb);
  return () => window.removeEventListener(SESSION_EVENT, cb);
}
function readCount(key: string): number {
  try { return Number(sessionStorage.getItem(key)) || 0; } catch { return 0; }
}
function useSessionApprovals(campaignId: string) {
  const key = `review-approved:${campaignId}`;
  const count = useSyncExternalStore(subscribe, () => readCount(key), () => 0);
  const bump = () => {
    try { sessionStorage.setItem(key, String(readCount(key) + 1)); } catch { /* private mode: the menu item just stays hidden */ }
    window.dispatchEvent(new Event(SESSION_EVENT));
  };
  return [count, bump] as const;
}

export function ReviewTab({ campaign, view, queue, counts, selected, progress, approved, nextSend, stepCount, defaultTo }: {
  campaign: { id: string; name: string; require_approval: boolean };
  view: View;
  queue: ReviewQueueItem[];
  counts: { to_review: number; failed: number };
  selected: ReviewSelected | null;
  progress: { done: number; total: number; writing: number } | null;
  /** Approved emails waiting for their send time. */
  approved: number;
  nextSend: string | null;
  stepCount: number;
  defaultTo: string;
}) {
  const router = useRouter();
  const href = (v: View, lead?: string | null) => `/campaigns/${campaign.id}?tab=review${v === "failed" ? "&view=failed" : ""}${lead ? `&lead=${lead}` : ""}`;
  const stillWriting = !!progress && progress.writing > 0;
  usePoll(() => router.refresh(), 30_000, !queue.length && stillWriting);

  const tabs = (
    <div className="flex flex-wrap gap-1.5">
      <FilterChip href={href("to_review")} active={view === "to_review"}>To review <span className="opacity-70">{fmtNum(counts.to_review)}</span></FilterChip>
      <FilterChip href={href("failed")} active={view === "failed"}>AI couldn&apos;t write <span className="opacity-70">{fmtNum(counts.failed)}</span></FilterChip>
    </div>
  );

  if (!queue.length || !selected) {
    let body: React.ReactNode;
    if (view === "failed") body = <Empty icon={<CheckCheck size={28} />} title="Nothing failed">The AI wrote every lead&apos;s emails it was given.</Empty>;
    else if (!campaign.require_approval) {
      body = (
        <Empty icon={<Inbox size={28} />} title="Emails go out without review"
          action={<Link href={`/campaigns/${campaign.id}?tab=options`} className="text-[13px] text-accent font-medium hover:underline">Turn on review in Options</Link>}>
          The AI&apos;s emails are sent as soon as they&apos;re written.
        </Empty>
      );
    } else if (stillWriting) {
      body = (
        <Empty icon={<Sparkles size={28} />} title={`AI is writing: ${fmtNum(progress!.done)} of ${fmtNum(progress!.total)} done`}>
          New emails appear here as they&apos;re ready.
        </Empty>
      );
    } else {
      body = (
        <Empty icon={<CheckCheck size={28} />} title="All caught up">
          {fmtNum(approved)} approved email{approved === 1 ? " is" : "s are"} scheduled{nextSend ? <>; next send {fmtDay(nextSend)} {fmtTime(nextSend)}</> : ""}.
        </Empty>
      );
    }
    return <div className="grid gap-3">{tabs}<Card>{body}</Card></div>;
  }

  return <ReviewWorkspace key={selected.id} campaign={campaign} view={view} queue={queue} counts={counts} selected={selected} tabs={tabs}
    href={href} stepCount={stepCount} defaultTo={defaultTo} />;
}

function ReviewWorkspace({ campaign, view, queue, counts, selected, tabs, href, stepCount, defaultTo }: {
  campaign: { id: string; name: string };
  view: View;
  queue: ReviewQueueItem[];
  counts: { to_review: number; failed: number };
  selected: ReviewSelected;
  tabs: React.ReactNode;
  href: (v: View, lead?: string | null) => string;
  stepCount: number;
  defaultTo: string;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const { confirm, element } = useConfirm();
  const [approvals, bump] = useSessionApprovals(campaign.id);
  const [testOpen, setTestOpen] = useState(false);
  const [drafts, setDrafts] = useState(selected.emails);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const draftsRef = useRef(selected.emails);
  const dirtySteps = useRef(new Set<number>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editedRef = useRef(selected.edited);

  const i = queue.findIndex((q) => q.id === selected.id);
  const prev = i > 0 ? queue[i - 1] : null;
  const next = i >= 0 && i < queue.length - 1 ? queue[i + 1] : null;
  const failedView = view === "failed";

  /** Saves edits that are still waiting for the 800ms pause. Resolves false when a save failed. */
  const flush = async (): Promise<boolean> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const steps = [...dirtySteps.current];
    dirtySteps.current.clear();
    if (!steps.length) return true;
    setSaveState("saving");
    for (const s of steps) {
      const d = draftsRef.current[s];
      const r = await updateLeadDraft(selected.id, s, d.subject, d.body);
      if (!r.ok) { setSaveState("error"); toast.error(r.error); return false; }
    }
    editedRef.current = true;
    setSaveState("saved");
    return true;
  };

  const edit = (step: number, patch: Partial<{ subject: string; body: string }>) => {
    const nextDrafts = draftsRef.current.map((d, j) => (j === step ? { ...d, ...patch } : d));
    draftsRef.current = nextDrafts;
    setDrafts(nextDrafts);
    dirtySteps.current.add(step);
    setSaveState("idle");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(); }, 800);
  };

  /** Moves on after this lead left the queue (approved, skipped, rewritten): the next one, else the previous. */
  const advance = () => router.replace(href(view, (next ?? prev)?.id ?? null), { scroll: false });
  const goTo = (id: string) => start(async () => { if (await flush()) router.replace(href(view, id), { scroll: false }); });

  const approve = () => start(async () => {
    if (!(await flush())) return;
    const r = await approveLeads(campaign.id, [selected.id]);
    if (!r.ok) return void toast.error(r.error);
    bump();
    advance();
  });
  const skip = () => start(async () => {
    if (timer.current) clearTimeout(timer.current);
    dirtySteps.current.clear();
    const r = await skipCampaignLeads(campaign.id, [selected.id]);
    if (!r.ok) return void toast.error(r.error);
    toast.success(`Skipped ${selected.lead.name}`);
    advance();
  });
  const rewrite = async () => {
    if (editedRef.current || dirtySteps.current.size) {
      const ok = await confirm({ title: "Rewrite this lead's emails?", body: "You edited them by hand. The AI writes them again from scratch and your edits are lost.", confirmLabel: "Rewrite", tone: "danger" });
      if (!ok) return;
    }
    start(async () => {
      if (timer.current) clearTimeout(timer.current);
      dirtySteps.current.clear();
      const r = await rewriteLeads(campaign.id, [selected.id], { includeEdited: true });
      if (!r.ok) return void toast.error(r.error);
      toast.success(failedView ? "The AI will try again" : "The AI will write them again");
      advance();
    });
  };
  const approveAll = async () => {
    const n = counts.to_review;
    const ok = await confirm({
      title: `Approve ${fmtNum(n)} email${n === 1 ? "" : "s"} you haven't read?`,
      body: "They will start sending in the next sending window.",
      confirmLabel: `Approve ${fmtNum(n)}`,
    });
    if (!ok) return;
    start(async () => {
      if (!(await flush())) return;
      const r = await approveLeads(campaign.id);
      if (!r.ok) return void toast.error(r.error);
      toast.success(r.message ?? "Approved");
      router.replace(href(view), { scroll: false });
    });
  };

  useHotkeys({
    a: () => { if (!failedView && !busy) approve(); },
    s: () => { if (!busy) skip(); },
    r: () => { if (!busy) void rewrite(); },
    j: () => { if (next && !busy) goTo(next.id); },
    k: () => { if (prev && !busy) goTo(prev.id); },
  });

  const r = selected.research;
  return (
    <div className="grid gap-3 min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        {tabs}
        <div className="ml-auto flex items-center gap-1">
          <ShortcutHelp showButton shortcuts={[["a", "Approve & next"], ["s", "Skip lead"], ["r", "Rewrite"], ["j", "Next lead"], ["k", "Previous lead"], ["?", "Show shortcuts"]]} />
          <Menu align="end" trigger={<Button variant="ghost" className="w-9 px-0" aria-label="More review actions"><MoreHorizontal size={17} /></Button>}
            items={[
              { label: "Send me a test of this lead's emails", icon: <Send />, onSelect: () => setTestOpen(true), disabled: failedView || !drafts.length },
              { label: `Approve all remaining (${fmtNum(counts.to_review)})`, icon: <CheckCheck />, onSelect: () => void approveAll(), hidden: failedView || approvals < 5 || !counts.to_review },
            ]} />
        </div>
      </div>

      <div className="grid lg:grid-cols-[280px_minmax(0,1fr)] gap-4 items-start">
        <Card className="overflow-hidden lg:sticky lg:top-4">
          <div className="px-3 h-10 flex items-center justify-between border-b border-line text-[12.5px] text-muted">
            <span className="tabular-nums">{fmtNum(i + 1)} of {fmtNum(failedView ? counts.failed : counts.to_review)}</span>
            {busy && <Spinner className="text-faint" />}
          </div>
          <div className="max-h-[60vh] overflow-y-auto divide-y divide-line">
            {queue.map((q) => (
              <button key={q.id} type="button" onClick={() => goTo(q.id)} aria-current={q.id === selected.id ? "true" : undefined}
                className={cx("w-full text-left px-3 py-2 flex items-center gap-2 transition-colors", q.id === selected.id ? "bg-accent-soft/60" : "hover:bg-panel-2")}>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium truncate">{q.name}</span>
                  <span className="block text-[12px] text-muted truncate">{q.company || "—"}</span>
                </span>
                {q.fit != null && <Badge tone={q.fit >= 7 ? "good" : q.fit >= 4 ? "warn" : "bad"}>{q.fit}/10</Badge>}
              </button>
            ))}
          </div>
        </Card>

        <div className="grid gap-3 min-w-0">
          <Card className="px-4 py-3 grid gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[15px] font-semibold">{selected.lead.name}</h2>
              {selected.fit != null && (
                <span title="How well the company matches who you sell to, judged by AI from their website.">
                  <Badge tone={selected.fit >= 7 ? "good" : selected.fit >= 4 ? "warn" : "bad"}>Fit {selected.fit}/10</Badge>
                </span>
              )}
            </div>
            <div className="text-[12.5px] text-muted flex flex-wrap items-center gap-x-2">
              {selected.lead.title && <span>{selected.lead.title}</span>}
              {selected.lead.company && <span>· {selected.lead.company}</span>}
              {selected.lead.website && (
                <a href={/^https?:\/\//.test(selected.lead.website) ? selected.lead.website : `https://${selected.lead.website}`} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 text-accent hover:underline"><Globe size={12} />{selected.lead.website.replace(/^https?:\/\//, "")}</a>
              )}
              <span className="text-faint">{selected.lead.email}</span>
            </div>
            {r && (
              <details className="mt-1.5 text-[12.5px]">
                <summary className="cursor-pointer select-none text-muted">Why this lead</summary>
                <div className="mt-2 grid gap-1.5">
                  {r.failed && <p className="text-bad">{r.failed}</p>}
                  {r.whatTheyDo && <p>{r.whatTheyDo}</p>}
                  {r.facts.length > 0 && <ul className="list-disc pl-4 text-muted grid gap-0.5">{r.facts.map((f) => <li key={f}>{f}</li>)}</ul>}
                  {r.bestService && <p><span className="text-faint">Best service:</span> {r.bestService}</p>}
                  {r.angle && <p><span className="text-faint">Angle:</span> {r.angle}</p>}
                  {r.fitReason && <p><span className="text-faint">Fit:</span> {r.fitReason}</p>}
                </div>
              </details>
            )}
          </Card>

          {failedView ? (
            <Card className="px-4 py-4 text-[13px] grid gap-2">
              <div className="font-medium">The AI couldn&apos;t write this lead&apos;s emails.</div>
              {selected.prepError && <p className="text-bad break-words">{selected.prepError}</p>}
              <p className="text-muted">Try again (sites are sometimes down for a while), or skip the lead.</p>
            </Card>
          ) : (
            drafts.map((d, s) => (
              <Card key={s} className="grid gap-2 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted">
                  <span className="font-semibold text-ink text-[13px]">{s === 0 ? "Email 1" : `Email ${s + 1} · follow-up`}</span>
                  <span>From: {selected.from} · Sends: {selected.sends[s] ?? "—"}</span>
                </div>
                <Input value={d.subject} onChange={(e) => edit(s, { subject: e.target.value })} aria-label={`Email ${s + 1} subject`}
                  placeholder={s === 0 ? "Subject" : "Subject (empty = reply in the same thread)"} className="font-medium" />
                <Textarea value={d.body} onChange={(e) => edit(s, { body: e.target.value })} aria-label={`Email ${s + 1} body`} rows={s === 0 ? 8 : 5} className="text-[13.5px]" />
              </Card>
            ))
          )}
        </div>
      </div>

      <div className="sticky bottom-0 z-20 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 py-3 border-t border-line bg-bg/90 backdrop-blur flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={() => prev && goTo(prev.id)} disabled={!prev || busy}><ChevronLeft size={15} />Prev <Kbd className="ml-1">k</Kbd></Button>
        <span className="hidden md:inline text-[12px] text-faint">
          {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved ✓" : saveState === "error" ? <span className="text-bad">Not saved</span> : "Edits save as you type"}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button onClick={skip} disabled={busy}><SkipForward size={14} />Skip lead <Kbd className="ml-1">s</Kbd></Button>
          <Button onClick={() => void rewrite()} disabled={busy}><RefreshCw size={14} />{failedView ? "Try again" : "Rewrite"} <Kbd className="ml-1">r</Kbd></Button>
          {!failedView && (
            <Button variant="primary" onClick={approve} disabled={busy}>{busy ? <Spinner /> : <CheckCheck size={15} />}Approve &amp; next <Kbd className="ml-1 bg-transparent border-accent-ink/30 text-accent-ink">a</Kbd></Button>
          )}
        </div>
      </div>
      {testOpen && (
        <TestStepDialog campaignId={campaign.id} stepCount={stepCount} defaultTo={defaultTo} campaignLeadId={selected.id} leadLabel={selected.lead.name} onClose={() => setTestOpen(false)} />
      )}
      {element}
    </div>
  );
}
