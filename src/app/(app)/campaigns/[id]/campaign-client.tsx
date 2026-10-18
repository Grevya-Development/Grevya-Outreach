"use client";

// Small client pieces shared by the campaign page's header and tabs. Each tab's own UI lives in
// its *-tab.tsx file; the server parts that load data live in page.tsx / header.tsx.
import { Copy, Download, MoreHorizontal, Pause, Play, RotateCcw, Send, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState, useTransition, type ReactNode } from "react";
import {
  deleteCampaign, duplicateCampaign, reassignStuck, renameCampaign, retryAiFailed, retryFailed, sendTestStep, setCampaignStatus,
} from "@/app/actions/campaigns";
import { ActionButton, Dialog, Menu, Spinner, Switch, useAction, useConfirm } from "@/components/client";
import { Badge, Button, Field, Input, Select, cx } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import type { SpamReport } from "@/lib/spamcheck";

/* ───────────── display pieces ───────────── */

export function Banner({ tone, icon, children, action }: { tone: "warn" | "bad" | "info"; icon: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={cx("flex flex-wrap items-center gap-3 rounded-xl px-4 py-3 text-[13px]",
      tone === "warn" && "bg-warn-soft text-warn", tone === "bad" && "bg-bad-soft text-bad", tone === "info" && "bg-info-soft text-info")}>
      <span className="shrink-0">{icon}</span>
      <div className="flex-1 min-w-[200px] text-ink">{children}</div>
      {action}
    </div>
  );
}

export function SpamBadge({ report }: { report: SpamReport }) {
  const tone = report.score >= 3 ? "bad" : report.score >= 1.5 ? "warn" : "good";
  return (
    <details className="text-[12px] shrink-0">
      <summary className="cursor-pointer select-none list-none inline-flex">
        <Badge tone={tone}>{tone === "good" ? "✓ Inbox-friendly" : `Spam risk ${report.score}/10`}</Badge>
      </summary>
      {report.issues.length > 0 && (
        <ul className="mt-1.5 grid gap-0.5 text-muted list-disc pl-4">{report.issues.map((i) => <li key={i.message}>{i.message}</li>)}</ul>
      )}
    </details>
  );
}

export function EmailCard({ from, to, subject, body, spam, label }: { from: string; to: string; subject: string; body: string; spam?: SpamReport; label?: string }) {
  return (
    <div className="rounded-xl border border-line bg-bg/60 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-line text-[12.5px] grid gap-0.5">
        {label && <div className="text-[11.5px] uppercase tracking-wide text-faint mb-0.5">{label}</div>}
        <div className="truncate"><span className="text-faint w-10 inline-block">From</span>{from}</div>
        <div className="truncate"><span className="text-faint w-10 inline-block">To</span>{to}</div>
        <div className="flex items-start justify-between gap-2 mt-1">
          <div className="font-medium text-[13.5px] text-ink min-w-0 break-words">{subject || <span className="text-bad">No subject</span>}</div>
          {spam && <SpamBadge report={spam} />}
        </div>
      </div>
      <pre className="px-4 py-3 whitespace-pre-wrap break-words font-sans text-[13.5px] leading-relaxed max-h-[420px] overflow-y-auto">{body}</pre>
    </div>
  );
}

export function Toggle({ label, hint, checked, onChange }: { label: string; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="text-[13px] font-medium">{label}</div>
        {hint && <div className="text-[12px] text-muted mt-0.5">{hint}</div>}
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

/** A filter chip that is a link (the filter lives in the URL). */
export function FilterChip({ href, active, children }: { href: string; active: boolean; children: ReactNode }) {
  return (
    <Link href={href} scroll={false} aria-current={active ? "true" : undefined}
      className={cx("inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[12.5px] border transition-colors tabular-nums whitespace-nowrap",
        active ? "bg-ink text-bg border-ink" : "border-line text-muted hover:text-ink hover:bg-panel")}>
      {children}
    </Link>
  );
}

/* ───────────── actions used from server components ───────────── */

/** Server components can't pass closures, so they name the action instead. */
export function CampaignActionButton({ id, kind, children, variant = "secondary", size = "sm" }: {
  id: string;
  kind: "pause" | "resume" | "reassign" | "retryFailed" | "retryAi";
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
}) {
  const action = {
    pause: () => setCampaignStatus(id, "paused"),
    resume: () => setCampaignStatus(id, "active"),
    reassign: () => reassignStuck(id),
    retryFailed: () => retryFailed(id),
    retryAi: () => retryAiFailed(id),
  }[kind];
  const icon = kind === "pause" ? <Pause size={15} /> : kind === "resume" ? <Play size={15} /> : kind === "reassign" ? null : <RotateCcw size={14} />;
  return <ActionButton action={action} variant={variant} size={size}>{icon}{children}</ActionButton>;
}

/** The campaign name; click it to rename in place (Enter or leaving the field saves, Escape cancels). */
export function RenameTitle({ id, name }: { id: string; name: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [pending, run] = useAction();
  const save = () => {
    setEditing(false);
    const next = value.trim();
    if (!next || next === name) return setValue(name);
    run(() => renameCampaign(id, next));
  };
  if (editing) {
    return (
      <Input autoFocus value={value} maxLength={120} aria-label="Campaign name" className="h-9 text-[18px] font-semibold max-w-md"
        onChange={(e) => setValue(e.target.value)} onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); save(); }
          if (e.key === "Escape") { setValue(name); setEditing(false); }
        }} />
    );
  }
  return (
    <button type="button" onClick={() => setEditing(true)} title="Rename"
      className="text-left text-[20px] font-semibold tracking-[-0.01em] truncate rounded-md -mx-1 px-1 hover:bg-panel-2 min-w-0 max-w-full">
      {pending ? value : name}{pending && <Spinner className="ml-2 align-middle text-faint" />}
    </button>
  );
}

/** Starts a file download without leaving the page. */
function download(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  a.click();
}

/** The header's ⋯ menu: Send me a test, Export leads CSV, Duplicate, Delete. */
export function CampaignMenu({ id, name, unsentLeads, stepCount, defaultTo }: {
  id: string; name: string; unsentLeads: number; stepCount: number; defaultTo: string;
}) {
  const [testOpen, setTestOpen] = useState(false);
  const [busy, start] = useTransition();
  const { confirm, element } = useConfirm();
  return (
    <>
      <Menu align="end"
        trigger={<Button variant="ghost" className="w-9 px-0" aria-label="More actions" disabled={busy}>{busy ? <Spinner /> : <MoreHorizontal size={17} />}</Button>}
        items={[
          { label: "Send me a test", icon: <Send />, onSelect: () => setTestOpen(true), disabled: !stepCount },
          { label: "Export leads CSV", icon: <Download />, onSelect: () => download(`/api/campaigns/${id}/export`) },
          { label: "Duplicate", icon: <Copy />, onSelect: () => start(() => duplicateCampaign(id)) },
          {
            label: "Delete", icon: <Trash2 />, tone: "danger",
            onSelect: async () => {
              const ok = await confirm({
                title: `Delete "${name}"?`,
                body: unsentLeads
                  ? `Emails not yet sent to ${fmtNum(unsentLeads)} lead${unsentLeads === 1 ? "" : "s"} will be cancelled. Sent history stays in totals.`
                  : "Sent history stays in totals.",
                confirmLabel: "Delete campaign", tone: "danger",
              });
              if (ok) start(() => deleteCampaign(id));
            },
          },
        ]} />
      {element}
      {testOpen && <TestStepDialog campaignId={id} stepCount={stepCount} defaultTo={defaultTo} onClose={() => setTestOpen(false)} />}
    </>
  );
}

/* ───────────── Send me a test ───────────── */

/** Sends one email of the sequence, exactly as a lead gets it (subject starts with [Test]). */
export function TestStepDialog({ campaignId, stepCount, defaultTo, campaignLeadId = null, leadLabel, defaultStep = 0, onClose }: {
  campaignId: string;
  stepCount: number;
  defaultTo: string;
  /** The lead whose emails to send; null = the first lead in the campaign. */
  campaignLeadId?: string | null;
  leadLabel?: string;
  defaultStep?: number;
  onClose: () => void;
}) {
  const [to, setTo] = useState(defaultTo);
  const [step, setStep] = useState(Math.min(defaultStep, Math.max(0, stepCount - 1)));
  const [pending, run] = useAction();
  const send = () => run(() => sendTestStep(campaignId, step, campaignLeadId, to), onClose);
  return (
    <Dialog open onClose={onClose} title="Send me a test"
      description={leadLabel ? `Written for ${leadLabel}. Nothing is recorded and it doesn't count towards limits.` : "Uses the first lead in this campaign. Nothing is recorded and it doesn't count towards limits."}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={pending || !to.includes("@")} onClick={send}>{pending ? <Spinner /> : <Send size={14} />}Send test</Button>
      </>}>
      <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <Field label="To"><Input type="email" data-autofocus="" value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@company.com" required /></Field>
        <Field label="Email">
          <Select value={step} onChange={(e) => setStep(Number(e.target.value))}>
            {Array.from({ length: stepCount }, (_, i) => <option key={i} value={i}>{i === 0 ? "Email 1" : `Email ${i + 1} · follow-up`}</option>)}
          </Select>
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

