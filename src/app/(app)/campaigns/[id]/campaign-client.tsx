"use client";

import {
  AlertTriangle, ArrowLeft, Bot, Building2, CheckCheck, Copy, FileText, Globe, MoreHorizontal, Pause, Play, Plus, RefreshCw,
  RotateCcw, Sparkles, Trash2, UserPlus, Wand2, X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  aiDraftStep, approveLeads, deleteCampaign, duplicateCampaign, enrollLeads, previewForLead, reassignStuck, removeCampaignLeads,
  retryFailed, rewriteLeads, saveCampaignSettings, saveSteps, setCampaignStatus, unskipLeads, type PreviewResult, type StepInput,
} from "@/app/actions/campaigns";
import { AddLeadsButton } from "@/components/add-leads";
import { ActionButton, Spinner, Switch, useAction } from "@/components/client";
import {
  Badge, Button, Card, CardHeader, Empty, Field, Input, Select, Stat, StatusBadge, Td, Textarea, Th, buttonClass, cx, pct, timeAgo,
} from "@/components/ui";
import { effectiveDailyLimit } from "@/lib/schedule";
import { checkContent, type SpamReport } from "@/lib/spamcheck";
import { missingVariables, render, TEMPLATE_VARIABLES } from "@/lib/template";
import type { Campaign, CampaignLead, CampaignStats, CampaignStep, Lead, PublicMailbox } from "@/lib/types";

export type CampaignLeadRow = Pick<CampaignLead,
  "id" | "status" | "current_step" | "next_send_at" | "last_error" | "personalization" | "prep_status" | "prep_error" | "fit_score" | "skip_reason" | "mailbox_id"
> & { leads: Lead };

interface Props {
  campaign: Campaign;
  steps: CampaignStep[];
  mailboxes: PublicMailbox[];
  attachedMailboxIds: string[];
  stats: CampaignStats | null;
  leads: CampaignLeadRow[];
  statusCounts: Record<string, number>;
  prepCounts: Record<string, number>;
  tags: { tag: string; n: number }[];
  stuck: number;
  profileReady: boolean;
}

type Tab = "sequence" | "leads" | "settings";
const n = (v: number | undefined) => Number(v ?? 0);
const leadName = (l: Lead) => [l.first_name, l.last_name].filter(Boolean).join(" ") || l.email;

export function CampaignView(p: Props) {
  const [tab, setTab] = useState<Tab>("sequence");
  const s = p.stats;
  const contacted = n(s?.leads) - n(s?.remaining) + n(p.statusCounts.in_progress);
  const ai = p.campaign.mode === "ai";

  return (
    <div className="grid gap-5">
      <Header campaign={p.campaign} />

      {ai && !p.profileReady && (
        <Banner tone="warn" icon={<AlertTriangle size={15} />}>
          The AI doesn&apos;t know what Grevya sells yet. <Link href="/settings" className="underline font-medium">Fill in your company profile</Link> — every email is written from it.
        </Banner>
      )}
      {p.stuck > 0 && (
        <Banner tone="warn" icon={<AlertTriangle size={15} />} action={<ActionButton size="sm" action={() => reassignStuck(p.campaign.id)}>Move to active mailboxes</ActionButton>}>
          {p.stuck} lead(s) are waiting on a mailbox that is paused, broken or no longer in this campaign.
        </Banner>
      )}
      {n(p.statusCounts.failed) > 0 && (
        <Banner tone="bad" icon={<AlertTriangle size={15} />} action={<ActionButton size="sm" action={() => retryFailed(p.campaign.id)}><RotateCcw size={14} />Retry</ActionButton>}>
          {n(p.statusCounts.failed)} lead(s) failed after several attempts (see the Leads tab for the reason).
        </Banner>
      )}
      {ai && <AiPipeline campaign={p.campaign} prep={p.prepCounts} skippedLowFit={p.leads.filter((l) => l.skip_reason?.startsWith("Low fit")).length} />}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Stat label="Leads" value={n(s?.leads)} sub={`${n(s?.remaining)} still in sequence`} />
        <Stat label="Emails sent" value={n(s?.sent)} />
        <Stat label="Replied" value={n(s?.replied)} sub={`${pct(n(s?.replied), contacted)} of contacted`} tone={n(s?.replied) ? "good" : undefined} />
        <Stat label="Opened" value={p.campaign.track_opens ? n(s?.opened) : "off"} sub={p.campaign.track_opens ? `${pct(n(s?.opened), n(s?.sent))} (approx.)` : "tracking disabled"} />
        <Stat label="Bounced" value={n(s?.bounced)} sub={pct(n(s?.bounced), n(s?.sent))} tone={n(s?.sent) > 20 && n(s?.bounced) / n(s?.sent) > 0.03 ? "bad" : undefined} />
        <Stat label="Unsubscribed" value={n(s?.unsubscribed)} />
      </div>

      <div className="flex gap-1 border-b border-line">
        {(["sequence", "leads", "settings"] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={cx("relative h-9 px-3 text-[13.5px] capitalize transition-colors", tab === t ? "text-ink font-medium" : "text-muted hover:text-ink")}>
            {t}{t === "leads" && <span className="ml-1.5 text-faint tabular-nums">{n(s?.leads)}</span>}
            {t === "leads" && n(p.prepCounts.review) > 0 && <span className="ml-1.5 inline-block size-1.5 rounded-full bg-warn align-middle" />}
            {tab === t && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
          </button>
        ))}
      </div>

      {/* Keep every tab mounted so unsaved edits survive tab switches. */}
      <div className={tab === "sequence" ? "" : "hidden"}><SequenceTab {...p} /></div>
      <div className={tab === "leads" ? "" : "hidden"}><LeadsTab {...p} /></div>
      <div className={tab === "settings" ? "" : "hidden"}><SettingsTab {...p} /></div>
    </div>
  );
}

function Banner({ tone, icon, children, action }: { tone: "warn" | "bad" | "info"; icon: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className={cx("flex flex-wrap items-center gap-3 rounded-xl px-4 py-3 text-[13px]",
      tone === "warn" && "bg-warn-soft text-warn", tone === "bad" && "bg-bad-soft text-bad", tone === "info" && "bg-info-soft text-info")}>
      <span className="shrink-0">{icon}</span>
      <div className="flex-1 min-w-[200px] text-ink">{children}</div>
      {action}
    </div>
  );
}

function AiPipeline({ campaign, prep, skippedLowFit }: { campaign: Campaign; prep: Record<string, number>; skippedLowFit: number }) {
  const waiting = n(prep.pending) + n(prep.working);
  const items = [
    { label: "ready to send", v: n(prep.ready), cls: "text-good" },
    { label: "being researched & written", v: waiting, cls: "text-info" },
    { label: "awaiting your approval", v: n(prep.review), cls: "text-warn" },
    { label: "couldn't be written", v: n(prep.failed), cls: "text-bad" },
    { label: "skipped (low fit)", v: skippedLowFit, cls: "text-muted" },
  ].filter((i) => i.v > 0);
  return (
    <Card className="px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
      <span className="flex items-center gap-1.5 font-medium"><Bot size={15} className="text-accent" />AI writer</span>
      {items.length === 0 ? <span className="text-muted">Add leads — each one is researched and written for automatically.</span>
        : items.map((i) => <span key={i.label}><b className={cx("tabular-nums", i.cls)}>{i.v}</b> <span className="text-muted">{i.label}</span></span>)}
      <span className="ml-auto flex gap-2">
        {n(prep.review) > 0 && <ActionButton size="sm" variant="primary" action={() => approveLeads(campaign.id)}><CheckCheck size={14} />Approve all {n(prep.review)}</ActionButton>}
        {skippedLowFit > 0 && <ActionButton size="sm" action={() => unskipLeads(campaign.id)} title="Put low-fit leads back in the queue">Un-skip low fit</ActionButton>}
      </span>
      {waiting > 0 && <p className="basis-full text-[12px] text-faint">Writing happens in the background (npm run worker), paced to Groq&apos;s free limits — roughly 2–4 leads a minute.</p>}
    </Card>
  );
}

function Header({ campaign: c }: { campaign: Campaign }) {
  const [menu, setMenu] = useState(false);
  const [, startNav] = useTransition();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <Link href="/campaigns" className="inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-ink mb-1"><ArrowLeft size={13} />Campaigns</Link>
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-[20px] font-semibold tracking-[-0.01em] truncate">{c.name}</h1>
          <StatusBadge status={c.status} />
          <Badge tone={c.mode === "ai" ? "accent" : "neutral"}>{c.mode === "ai" ? "AI-researched" : "template"}</Badge>
        </div>
      </div>
      <div className="flex items-center gap-2 relative">
        {c.status === "active" ? (
          <ActionButton action={() => setCampaignStatus(c.id, "paused")}><Pause size={15} />Pause</ActionButton>
        ) : c.status !== "completed" ? (
          <ActionButton variant="primary" action={() => setCampaignStatus(c.id, "active")}><Play size={15} />{c.status === "draft" ? "Launch" : "Resume"}</ActionButton>
        ) : null}
        <Button variant="ghost" className="w-9 px-0" aria-label="More" onClick={() => setMenu((v) => !v)}><MoreHorizontal size={17} /></Button>
        {menu && (
          <div className="absolute right-0 top-10 z-30 w-44 rounded-xl border border-line bg-panel shadow-xl p-1 fade-in" onMouseLeave={() => setMenu(false)}>
            <button className={buttonClass("ghost", "sm", "w-full justify-start")} onClick={() => startNav(() => duplicateCampaign(c.id))}><Copy size={14} />Duplicate</button>
            <button className={buttonClass("ghost", "sm", "w-full justify-start text-bad")}
              onClick={() => { if (confirm(`Delete “${c.name}”? Sent history stays in the dashboard totals.`)) startNav(() => deleteCampaign(c.id)); }}>
              <Trash2 size={14} />Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────── Sequence ─────────────────────────── */

function SequenceTab({ campaign, steps: initial, leads, mailboxes, attachedMailboxIds }: Props) {
  const ai = campaign.mode === "ai";
  const toInput = (list: CampaignStep[]) => list.map(({ delay_days, subject, body }) => ({ delay_days, subject, body }));
  const [steps, setSteps] = useState<StepInput[]>(() => toInput(initial));
  const [saving, runSave] = useAction();
  const saved = useMemo(() => JSON.stringify(toInput(initial)), [initial]);
  const dirty = JSON.stringify(steps) !== saved;
  const [active, setActive] = useState(0);
  const update = (i: number, patch: Partial<StepInput>) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const sender = mailboxes.find((m) => attachedMailboxIds.includes(m.id)) ?? mailboxes[0];

  return (
    <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)] gap-5 items-start">
      <div className="grid gap-3">
        {ai && (
          <div className="rounded-xl bg-accent-soft/60 px-4 py-3 text-[13px] flex gap-2.5">
            <Sparkles size={16} className="text-accent shrink-0 mt-0.5" />
            <div>
              <b>AI-researched mode.</b> For every lead, the AI reads their company website, scores the fit, picks the Grevya service that fits best, and writes each email below from your instructions. Subjects are written per lead.
            </div>
          </div>
        )}
        {steps.map((step, i) => (
          <div key={i}>
            {i > 0 && (
              <div className="flex items-center gap-2 py-2 pl-4 text-[12.5px] text-muted">
                <span className="w-px h-5 bg-line" />
                Wait
                <Input type="number" min={1} value={step.delay_days} onChange={(e) => update(i, { delay_days: Number(e.target.value) })} className="w-16 h-7 text-center" />
                days, then if no reply:
              </div>
            )}
            <StepEditor
              ai={ai}
              index={i}
              step={step}
              active={active === i}
              campaignId={campaign.id}
              onFocus={() => setActive(i)}
              onChange={(patch) => update(i, patch)}
              onRemove={steps.length > 1 ? () => { setSteps((s) => s.filter((_, j) => j !== i)); setActive(0); } : undefined}
            />
          </div>
        ))}
        <div className="flex items-center gap-2">
          {steps.length < 6 && (
            <Button onClick={() => { setSteps((s) => [...s, { delay_days: 3, subject: "", body: "" }]); setActive(steps.length); }}>
              <Plus size={15} />Add follow-up
            </Button>
          )}
          <div className="ml-auto flex items-center gap-2">
            {dirty && <span className="text-[12.5px] text-warn">Unsaved changes</span>}
            <Button variant="primary" disabled={!dirty || saving} onClick={() => runSave(() => saveSteps(campaign.id, steps))}>{saving && <Spinner />}Save sequence</Button>
          </div>
        </div>
        {!ai && <VariableHelp />}
      </div>

      <div className="lg:sticky lg:top-4">
        {ai
          ? <AiPreview campaign={campaign} leads={leads} dirty={dirty} />
          : <TemplatePreview campaign={campaign} steps={steps} leads={leads} sender={sender} activeStep={active} />}
      </div>
    </div>
  );
}

function StepEditor({ ai, index, step, active, campaignId, onFocus, onChange, onRemove }: {
  ai: boolean; index: number; step: StepInput; active: boolean; campaignId: string;
  onFocus: () => void; onChange: (p: Partial<StepInput>) => void; onRemove?: () => void;
}) {
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [briefOpen, setBriefOpen] = useState(false);
  const [brief, setBrief] = useState("");
  const [drafting, startDraft] = useTransition();

  const insert = (token: string) => {
    const el = bodyRef.current;
    if (!el) return onChange({ body: step.body + token });
    const { selectionStart: a, selectionEnd: b } = el;
    onChange({ body: step.body.slice(0, a) + token + step.body.slice(b) });
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + token.length, a + token.length); });
  };

  const draft = () => startDraft(async () => {
    const r = await aiDraftStep(campaignId, index, brief);
    if (!r.ok) return void toast.error(r.error);
    onChange(index === 0 ? { subject: r.subject, body: r.body } : { body: r.body });
    setBriefOpen(false);
    toast.success("Draft written — edit it to sound like you");
  });

  const title = index === 0 ? "Email 1 · first touch" : `Email ${index + 1} · follow-up`;
  return (
    <Card className={cx("transition-shadow", active && "ring-2 ring-accent/25 border-accent/40")} onFocusCapture={onFocus}>
      <div className="flex items-center justify-between px-4 pt-3">
        <div className="text-[13px] font-semibold">{title}</div>
        <div className="flex items-center gap-1">
          {!ai && <Button size="sm" variant="ghost" onClick={() => setBriefOpen((v) => !v)}><Wand2 size={14} />Draft with AI</Button>}
          {onRemove && <Button size="sm" variant="ghost" className="w-8 px-0" onClick={onRemove} aria-label="Remove step"><X size={15} /></Button>}
        </div>
      </div>
      {briefOpen && (
        <div className="mx-4 mt-3 rounded-lg bg-accent-soft/60 p-3 grid gap-2 fade-in">
          <Textarea rows={2} autoFocus value={brief} onChange={(e) => setBrief(e.target.value)}
            placeholder="What should this email say? e.g. We build Gen AI pilots in 3 weeks. Ask if they have a document-heavy process they'd like to automate." />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setBriefOpen(false)}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={draft} disabled={drafting}>{drafting ? <Spinner /> : <Sparkles size={14} />}Write it</Button>
          </div>
        </div>
      )}
      <div className="grid gap-2 p-4 pt-3">
        {ai ? (
          <>
            <label className="text-[12px] text-muted">What should this email do? The AI follows this for every lead.</label>
            <Textarea rows={3} value={step.body} onChange={(e) => onChange({ body: e.target.value })} className="text-[13.5px]"
              placeholder={index === 0 ? "e.g. Open with a specific detail about their company and connect it to our best-fit service with one proof point." : "e.g. Share a different use case for their industry."} />
          </>
        ) : (
          <>
            <Input value={step.subject} onChange={(e) => onChange({ subject: e.target.value })}
              placeholder={index === 0 ? "Subject" : "Subject — leave blank to reply in the same thread (recommended)"} className="font-medium" />
            <Textarea ref={bodyRef} rows={index === 0 ? 10 : 5} value={step.body} onChange={(e) => onChange({ body: e.target.value })}
              placeholder="Write your email…" className="text-[13.5px]" />
            <div className="flex flex-wrap gap-1">
              {TEMPLATE_VARIABLES.filter((v) => v !== "unsubscribe_url" && v !== "signature").map((v) => (
                <button key={v} type="button" onClick={() => insert(v === "first_name" ? "{{first_name|there}}" : `{{${v}}}`)}
                  className={cx("h-6 px-1.5 rounded-md text-[11.5px] font-mono transition-colors", v === "ai_line" ? "bg-accent-soft text-accent hover:opacity-80" : "bg-panel-2 text-muted hover:text-ink")}>
                  {v === "ai_line" ? "✦ ai_line" : v}
                </button>
              ))}
              <button type="button" onClick={() => insert("{Hi|Hey|Hello}")} className="h-6 px-1.5 rounded-md text-[11.5px] font-mono bg-panel-2 text-muted hover:text-ink">{"{spin|tax}"}</button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

function VariableHelp() {
  return (
    <details className="text-[12.5px] text-muted rounded-lg border border-line bg-panel px-3 py-2">
      <summary className="cursor-pointer select-none">How template personalisation works</summary>
      <ul className="mt-2 grid gap-1.5 list-disc pl-4">
        <li><code className="text-ink">{"{{first_name|there}}"}</code> inserts the lead&apos;s first name, or “there” if it&apos;s empty.</li>
        <li><code className="text-ink">{"{{ai_line}}"}</code> is one opening sentence Groq writes for each lead.</li>
        <li><code className="text-ink">{"{Hi|Hey|Hello}"}</code> picks one option per lead so no two emails are identical.</li>
        <li>Any extra CSV column works too, e.g. <code className="text-ink">{"{{industry}}"}</code>.</li>
        <li>For deeper, researched personalisation switch the campaign to <b>AI-researched</b> in Settings.</li>
      </ul>
    </details>
  );
}

function SpamBadge({ report }: { report: SpamReport }) {
  const tone = report.score >= 3 ? "bad" : report.score >= 1.5 ? "warn" : "good";
  return (
    <details className="text-[12px] shrink-0">
      <summary className="cursor-pointer select-none list-none inline-flex">
        <Badge tone={tone}>{tone === "good" ? "✓ inbox-friendly" : `spam risk ${report.score}/10`}</Badge>
      </summary>
      {report.issues.length > 0 && (
        <ul className="mt-1.5 grid gap-0.5 text-muted list-disc pl-4">{report.issues.map((i) => <li key={i.message}>{i.message}</li>)}</ul>
      )}
    </details>
  );
}

function EmailCard({ from, to, subject, body, spam, label }: { from: string; to: string; subject: string; body: string; spam: SpamReport; label?: string }) {
  return (
    <div className="rounded-xl border border-line bg-bg/60 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-line text-[12.5px] grid gap-0.5">
        {label && <div className="text-[11.5px] uppercase tracking-wide text-faint mb-0.5">{label}</div>}
        <div className="truncate"><span className="text-faint w-10 inline-block">From</span>{from}</div>
        <div className="truncate"><span className="text-faint w-10 inline-block">To</span>{to}</div>
        <div className="flex items-start justify-between gap-2 mt-1">
          <div className="font-medium text-[13.5px] text-ink">{subject || <span className="text-bad">No subject</span>}</div>
          <SpamBadge report={spam} />
        </div>
      </div>
      <pre className="px-4 py-3 whitespace-pre-wrap break-words font-sans text-[13.5px] leading-relaxed max-h-[420px] overflow-y-auto">{body}</pre>
    </div>
  );
}

function LeadPicker({ leads, value, onChange }: { leads: CampaignLeadRow[]; value: string; onChange: (id: string) => void }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className="min-w-0">
      {leads.map((l) => (
        <option key={l.id} value={l.id}>
          {leadName(l.leads)}{l.leads.company ? ` · ${l.leads.company}` : ` · ${l.leads.email.split("@")[1]}`}{l.prep_status === "ready" || l.prep_status === "review" ? " ✓" : ""}
        </option>
      ))}
    </Select>
  );
}

function AiPreview({ campaign, leads, dirty }: { campaign: Campaign; leads: CampaignLeadRow[]; dirty: boolean }) {
  const usable = leads.filter((l) => l.status !== "skipped");
  const [leadId, setLeadId] = useState(usable[0]?.id ?? "");
  const [data, setData] = useState<Record<string, PreviewResult>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, start] = useTransition();
  const row = usable.find((l) => l.id === leadId) ?? usable[0];
  const result = row ? data[row.id] : undefined;
  const written = Boolean(row?.personalization?.emails?.length);

  const load = (regenerate: boolean) => row && start(async () => {
    const r = await previewForLead(campaign.id, row.id, null, regenerate);
    if (!r.ok) { setErrors((e) => ({ ...e, [row.id]: r.error })); toast.error(r.error); return; }
    setErrors((e) => ({ ...e, [row.id]: "" }));
    setData((d) => ({ ...d, [row.id]: r }));
  });

  // Show already-written emails without spending AI calls.
  useEffect(() => {
    if (row && written && !data[row.id] && !loading) load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.id]);

  if (!row) {
    return <Card><CardHeader title="Preview" /><Empty title="Add leads to preview">Each lead&apos;s company is researched and their emails written before anything is sent.</Empty></Card>;
  }

  const a = result?.research?.analysis;
  return (
    <Card>
      <CardHeader title="Research & emails" description="Exactly what this lead will receive." />
      <div className="px-4 pb-3 flex gap-2">
        <LeadPicker leads={usable} value={row.id} onChange={setLeadId} />
        <Button onClick={() => load(Boolean(result || written))} disabled={loading} title={result || written ? "Research again and rewrite" : "Research this company and write the emails"}>
          {loading ? <Spinner /> : result || written ? <RefreshCw size={14} /> : <Sparkles size={14} />}{result || written ? "Rewrite" : "Research & write"}
        </Button>
      </div>
      {dirty && <p className="mx-4 mb-3 text-[12px] text-warn">Save the sequence first — the AI writes from the saved instructions.</p>}
      {loading && (
        <div className="mx-4 mb-4 rounded-lg bg-panel-2 px-3 py-3 text-[13px] text-muted flex items-center gap-2"><Spinner />Reading {row.leads.website || row.leads.email.split("@")[1]} and writing… (10–30s)</div>
      )}
      {errors[row.id] && !loading && <p className="mx-4 mb-3 text-[12.5px] text-bad">{errors[row.id]}</p>}
      {!result && !loading && !errors[row.id] && (
        <Empty icon={<Building2 size={24} />} title="Not written yet">
          The background worker writes these automatically. Click “Research & write” to do this lead now and review it.
        </Empty>
      )}
      {result && !loading && (
        <div className="grid gap-3 px-4 pb-4 fade-in">
          {result.research ? (
            <div className="rounded-xl border border-line p-3 text-[12.5px] grid gap-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <Globe size={13} className="text-faint" />
                <span className="font-medium text-[13px]">{a?.company_name || result.research.domain}</span>
                {a && <Badge tone={a.fit_score >= 7 ? "good" : a.fit_score >= 4 ? "warn" : "bad"}>fit {a.fit_score}/10</Badge>}
                {a && <Badge>{a.confidence} confidence</Badge>}
                {result.research.status === "failed" && <Badge tone="bad">site unreachable</Badge>}
              </div>
              {a?.what_they_do && <p className="text-ink/90">{a.what_they_do}</p>}
              {a?.facts?.length ? <ul className="list-disc pl-4 text-muted grid gap-0.5">{a.facts.map((f) => <li key={f}>{f}</li>)}</ul> : null}
              {a?.best_service && <p><span className="text-faint">Best fit:</span> {a.best_service}</p>}
              {a?.angle && <p><span className="text-faint">Angle:</span> {a.angle}</p>}
              {result.research.tech?.length ? <div className="flex flex-wrap gap-1">{result.research.tech.map((t) => <Badge key={t}>{t}</Badge>)}</div> : null}
              {result.research.error && <p className="text-bad">{result.research.error}</p>}
            </div>
          ) : (
            <p className="text-[12.5px] text-muted">No company website to research (personal email address) — written from the lead&apos;s name and title only.</p>
          )}
          {result.emails.map((e) => (
            <EmailCard key={e.step} label={e.step === 1 ? "Email 1" : `Email ${e.step} · after ${e.delay_days} days`}
              from={campaign.name} to={result.lead.email} subject={e.subject} body={e.body} spam={e.spam} />
          ))}
          {result.prepStatus === "review" && (
            <ActionButton variant="primary" action={() => approveLeads(campaign.id, [row.id])}><CheckCheck size={14} />Approve this lead</ActionButton>
          )}
        </div>
      )}
    </Card>
  );
}

function TemplatePreview({ campaign, steps, leads, sender, activeStep }: {
  campaign: Campaign; steps: StepInput[]; leads: CampaignLeadRow[]; sender?: PublicMailbox; activeStep: number;
}) {
  const [leadId, setLeadId] = useState(leads[0]?.id ?? "");
  const [aiLines, setAiLines] = useState<Record<string, string>>({});
  const [loading, start] = useTransition();
  const row = leads.find((l) => l.id === leadId) ?? leads[0];

  if (!row) {
    return <Card><CardHeader title="Preview" /><Empty title="Add leads to preview">The preview shows each email exactly as a real lead will receive it.</Empty></Card>;
  }

  const aiLine = aiLines[row.id] ?? row.personalization?.ai_line;
  const generate = (regenerate: boolean) => start(async () => {
    const r = await previewForLead(campaign.id, row.id, steps, regenerate);
    if (!r.ok) return void toast.error(r.error);
    if (r.aiLine) setAiLines((m) => ({ ...m, [row.id]: r.aiLine! }));
  });

  const ctx = {
    lead: row.leads,
    aiLine: aiLine ?? (campaign.ai_enabled ? "⟨AI line — click Generate⟩" : ""),
    senderName: sender?.from_name,
    signature: sender?.signature,
    unsubscribeUrl: "",
    seed: `${row.id}:${activeStep + 1}`,
  };
  const step = steps[activeStep] ?? steps[0];
  let subject = render(step.subject, ctx);
  if (activeStep > 0 && !subject) subject = `Re: ${render(steps[0].subject, { ...ctx, seed: `${row.id}:1` })}`;
  let body = render(step.body, ctx);
  if (sender?.signature && !step.body.includes("{{signature")) body += `\n\n${render(sender.signature, ctx)}`;
  if (campaign.include_unsubscribe) body += `\n\nNot the right person, or not interested? Just reply "no" and I won't email again.`;
  const missing = [...missingVariables(step.subject, ctx), ...missingVariables(step.body, ctx)].filter((v) => v !== "ai_line");

  return (
    <Card>
      <CardHeader title={`Preview · Email ${activeStep + 1}`} description="Updates as you type. Click a step on the left to preview it." />
      <div className="px-4 pb-3 flex gap-2">
        <LeadPicker leads={leads} value={row.id} onChange={setLeadId} />
        {campaign.ai_enabled && (
          <Button onClick={() => generate(Boolean(aiLine))} disabled={loading}>
            {loading ? <Spinner /> : aiLine ? <RefreshCw size={14} /> : <Sparkles size={14} />}{aiLine ? "Redo" : "Generate"}
          </Button>
        )}
      </div>
      <div className="mx-4 mb-4">
        <EmailCard from={sender ? `${sender.from_name || sender.email} <${sender.email}>` : "no mailbox selected"} to={row.leads.email}
          subject={subject} body={body} spam={checkContent(subject, body, { allowLinks: 1, isFollowUp: activeStep > 0 })} />
      </div>
      {missing.length > 0 && (
        <div className="mx-4 mb-4 -mt-1 text-[12px] text-warn">This lead has no value for {missing.map((m) => `{{${m}}}`).join(", ")} — add a fallback like {"{{company|your team}}"}.</div>
      )}
    </Card>
  );
}

/* ─────────────────────────── Leads ─────────────────────────── */

const PREP_LABEL: Record<string, { label: string; tone: "good" | "warn" | "bad" | "info" | "neutral" }> = {
  pending: { label: "queued for AI", tone: "neutral" },
  working: { label: "writing…", tone: "info" },
  review: { label: "needs approval", tone: "warn" },
  ready: { label: "written", tone: "good" },
  failed: { label: "AI failed", tone: "bad" },
  skipped: { label: "skipped", tone: "neutral" },
};

function LeadsTab({ campaign, leads, statusCounts, prepCounts, tags, stats }: Props) {
  const ai = campaign.mode === "ai";
  const [tag, setTag] = useState<string>(tags[0]?.tag ?? "__all");
  const [filter, setFilter] = useState<string>("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const shown = filter.startsWith("prep:") ? leads.filter((l) => l.prep_status === filter.slice(5) && ["queued", "in_progress"].includes(l.status))
    : filter ? leads.filter((l) => l.status === filter) : leads;
  const total = n(stats?.leads);
  const ids = [...selected];

  return (
    <div className="grid gap-4">
      <Card className="p-4 flex flex-wrap items-end gap-3">
        <Field label="Add leads from" className="min-w-[220px]">
          <Select value={tag} onChange={(e) => setTag(e.target.value)}>
            {tags.map((t) => <option key={t.tag} value={t.tag}>Tag: {t.tag} ({t.n})</option>)}
            <option value="__all">All leads</option>
          </Select>
        </Field>
        <ActionButton variant="primary" action={() => enrollLeads(campaign.id, tag === "__all" ? null : tag)}><UserPlus size={15} />Add to campaign</ActionButton>
        <span className="text-[12.5px] text-muted self-center">or</span>
        <AddLeadsButton campaignId={campaign.id} label="Add people by hand" />
        <p className="text-[12.5px] text-muted basis-full">Unsubscribed, bounced, invalid and blocked emails are skipped. Leads already in this campaign aren&apos;t added twice.</p>
      </Card>

      <div className="flex flex-wrap gap-1.5">
        <FilterChip active={!filter} onClick={() => setFilter("")}>All {total}</FilterChip>
        {["queued", "in_progress", "replied", "completed", "bounced", "unsubscribed", "skipped", "failed"].map((s) =>
          statusCounts[s] ? <FilterChip key={s} active={filter === s} onClick={() => setFilter(s)}>{s.replace("_", " ")} {statusCounts[s]}</FilterChip> : null)}
        {ai && ["review", "failed", "pending"].map((s) =>
          prepCounts[s] ? <FilterChip key={s} active={filter === `prep:${s}`} onClick={() => setFilter(`prep:${s}`)}>{PREP_LABEL[s].label} {prepCounts[s]}</FilterChip> : null)}
      </div>

      {shown.length === 0 ? (
        <Card><Empty icon={<UserPlus size={26} />} title={leads.length ? "Nothing in this filter" : "No leads in this campaign yet"}>{leads.length ? "" : "Import leads on the Leads page with a tag, then add that tag here."}</Empty></Card>
      ) : (
        <Card className="overflow-hidden">
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-line bg-accent-soft/60">
              <span className="text-[13px] font-medium mr-auto">{selected.size} selected</span>
              {ai && <ActionButton size="sm" action={async () => { const r = await approveLeads(campaign.id, ids); setSelected(new Set()); return r; }}><CheckCheck size={14} />Approve</ActionButton>}
              {ai && <ActionButton size="sm" action={async () => { const r = await rewriteLeads(campaign.id, ids); setSelected(new Set()); return r; }}><RefreshCw size={14} />Rewrite</ActionButton>}
              <ActionButton size="sm" variant="danger" confirm="Remove selected leads from this campaign?"
                action={async () => { const r = await removeCampaignLeads(campaign.id, ids); setSelected(new Set()); return r; }}>
                <Trash2 size={14} />Remove
              </ActionButton>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="bg-panel-2/50"><tr>
                <Th className="w-10" /><Th>Lead</Th><Th>Company</Th>{ai && <Th>Fit</Th>}{ai && <Th>AI email</Th>}<Th>Status</Th><Th>Sent</Th><Th>Next email</Th>
              </tr></thead>
              <tbody>
                {shown.map((l) => (
                  <tr key={l.id} className="hover:bg-panel-2/60">
                    <Td><input type="checkbox" className="accent-[var(--accent)]" checked={selected.has(l.id)}
                      onChange={() => setSelected((s) => { const x = new Set(s); if (x.has(l.id)) x.delete(l.id); else x.add(l.id); return x; })} /></Td>
                    <Td>
                      <div className="font-medium">{leadName(l.leads)}</div>
                      {(l.leads.first_name || l.leads.last_name) && <div className="text-[12px] text-muted">{l.leads.email}</div>}
                    </Td>
                    <Td className="max-w-[200px] truncate">{l.leads.company || <span className="text-faint">{l.leads.email.split("@")[1]}</span>}</Td>
                    {ai && <Td className="tabular-nums">{l.fit_score != null ? <Badge tone={l.fit_score >= 7 ? "good" : l.fit_score >= 4 ? "warn" : "bad"}>{l.fit_score}/10</Badge> : <span className="text-faint">—</span>}</Td>}
                    {ai && (
                      <Td>
                        {["queued", "in_progress"].includes(l.status) && l.current_step === 0
                          ? <Badge tone={PREP_LABEL[l.prep_status]?.tone ?? "neutral"}>{PREP_LABEL[l.prep_status]?.label ?? l.prep_status}</Badge>
                          : <span className="text-faint">—</span>}
                        {l.prep_error && l.prep_status !== "ready" && <div className="text-[11.5px] text-bad mt-0.5 max-w-[220px] truncate" title={l.prep_error}>{l.prep_error}</div>}
                      </Td>
                    )}
                    <Td>
                      <StatusBadge status={l.status} />
                      {l.skip_reason && <div className="text-[11.5px] text-muted mt-0.5 max-w-[240px] truncate" title={l.skip_reason}>{l.skip_reason}</div>}
                      {l.last_error && !["replied", "skipped"].includes(l.status) && <div className="text-[11.5px] text-bad mt-0.5 max-w-[240px] truncate" title={l.last_error}>{l.last_error}</div>}
                    </Td>
                    <Td className="tabular-nums text-muted">{l.current_step}</Td>
                    <Td className="text-muted whitespace-nowrap">
                      {["queued", "in_progress"].includes(l.status)
                        ? campaign.status !== "active" ? "paused" : new Date(l.next_send_at) <= new Date() ? "due now" : timeAgo(l.next_send_at)
                        : "—"}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > leads.length && <div className="px-3 h-10 flex items-center text-[12.5px] text-muted">Showing first {leads.length} of {total}</div>}
        </Card>
      )}
      {ai && (
        <div className="flex justify-end">
          <ActionButton size="sm" variant="ghost" confirm="Rewrite the emails for every lead that hasn't been contacted yet? Uses AI quota." action={() => rewriteLeads(campaign.id)}>
            <FileText size={14} />Rewrite all not-yet-sent
          </ActionButton>
        </div>
      )}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={cx("h-7 px-2.5 rounded-full text-[12.5px] capitalize border transition-colors tabular-nums",
      active ? "bg-ink text-bg border-ink" : "border-line text-muted hover:text-ink hover:bg-panel")}>{children}</button>
  );
}

/* ─────────────────────────── Settings ─────────────────────────── */

function SettingsTab({ campaign, mailboxes, attachedMailboxIds }: Props) {
  const [f, setF] = useState({
    name: campaign.name, daily_limit: campaign.daily_limit, track_opens: campaign.track_opens, track_clicks: campaign.track_clicks,
    stop_on_reply: campaign.stop_on_reply, include_unsubscribe: campaign.include_unsubscribe, ai_enabled: campaign.ai_enabled,
    ai_prompt: campaign.ai_prompt, sender_context: campaign.sender_context, mailbox_ids: attachedMailboxIds,
    mode: campaign.mode, min_fit_score: campaign.min_fit_score, require_approval: campaign.require_approval,
  });
  const [saving, run] = useAction();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));
  const chosen = mailboxes.filter((m) => f.mailbox_ids.includes(m.id) && m.status === "active");
  const capacity = chosen.reduce((s, m) => s + effectiveDailyLimit(m), 0);
  const fullCapacity = chosen.reduce((s, m) => s + Math.min(400, m.daily_limit), 0);

  return (
    <div className="grid lg:grid-cols-2 gap-4 items-start">
      <Card className="lg:col-span-2">
        <CardHeader title="How emails are written" />
        <div className="grid sm:grid-cols-2 gap-3 px-4 pb-4">
          {([
            { v: "ai", t: "AI-researched (recommended)", d: "Reads each prospect's website, scores fit, picks the right Grevya service and writes every email individually." },
            { v: "template", t: "Template", d: "You write the emails with {{variables}} and spintax. Optional one-line AI opener." },
          ] as const).map((o) => (
            <button key={o.v} type="button" onClick={() => set("mode", o.v)}
              className={cx("text-left rounded-xl border p-3.5 transition-colors", f.mode === o.v ? "border-accent bg-accent-soft/50 ring-2 ring-accent/20" : "border-line hover:bg-panel-2")}>
              <div className="font-medium text-[13.5px]">{o.t}</div>
              <div className="text-[12.5px] text-muted mt-0.5">{o.d}</div>
            </button>
          ))}
          {f.mode !== campaign.mode && <p className="sm:col-span-2 text-[12.5px] text-warn">Saving will pause this campaign and replace the sequence with the {f.mode === "ai" ? "AI-researched" : "template"} starter sequence. Emails already sent are not affected.</p>}
        </div>
      </Card>

      <Card>
        <CardHeader title="Sending" />
        <div className="grid gap-4 px-4 pb-4">
          <Field label="Campaign name"><Input value={f.name} onChange={(e) => set("name", e.target.value)} /></Field>
          <div className="grid gap-2">
            <div className="text-[12.5px] font-medium">Send from</div>
            {mailboxes.length === 0 && <p className="text-[12.5px] text-muted">No mailboxes yet — <Link className="text-accent underline" href="/mailboxes">add one</Link>.</p>}
            {mailboxes.map((m) => {
              const on = f.mailbox_ids.includes(m.id);
              return (
                <label key={m.id} className={cx("flex items-center gap-3 rounded-lg border px-3 py-2 cursor-pointer transition-colors", on ? "border-accent/50 bg-accent-soft/40" : "border-line hover:bg-panel-2")}>
                  <input type="checkbox" className="accent-[var(--accent)]" checked={on} onChange={() => set("mailbox_ids", on ? f.mailbox_ids.filter((x) => x !== m.id) : [...f.mailbox_ids, m.id])} />
                  <span className="flex-1 min-w-0 truncate">{m.email}</span>
                  {m.status !== "active" && <StatusBadge status={m.status} />}
                  <span className="text-[12px] text-muted tabular-nums">{effectiveDailyLimit(m)}/day</span>
                </label>
              );
            })}
            <p className="text-[12px] text-muted">
              Rotates between selected mailboxes; follow-ups come from the mailbox that sent the first email.
              Capacity today: <b className="text-ink">{capacity}</b>{fullCapacity > capacity && <> (up to {fullCapacity}/day once warm-up finishes)</>}.
              {fullCapacity < 800 && " For 800/day you need at least two mailboxes at 400."}
            </p>
          </div>
          <Field label="Campaign daily limit" hint="Max emails this campaign sends per day across all its mailboxes (first emails + follow-ups).">
            <Input type="number" min={1} value={f.daily_limit} onChange={(e) => set("daily_limit", Number(e.target.value))} />
          </Field>
          <Toggle label="Stop sequence when they reply" checked={f.stop_on_reply} onChange={(v) => set("stop_on_reply", v)} />
          <Toggle label="Opt-out line + List-Unsubscribe header" hint="Adds “reply no and I won't email again” (no link) plus the header Gmail/Yahoo use for their Unsubscribe button. Required by anti-spam rules — keep on." checked={f.include_unsubscribe} onChange={(v) => set("include_unsubscribe", v)} />
          <Toggle label="Track opens" hint="Adds an invisible image. Hurts inbox placement on cold email and Apple Mail inflates it — replies are the metric that matters." checked={f.track_opens} onChange={(v) => set("track_opens", v)} />
          <Toggle label="Track link clicks" hint="Rewrites links through your app URL (needs a public APP_URL)." checked={f.track_clicks} onChange={(v) => set("track_clicks", v)} />
        </div>
      </Card>

      <Card>
        <CardHeader title={<span className="flex items-center gap-1.5"><Sparkles size={15} className="text-accent" />AI</span>} />
        <div className="grid gap-4 px-4 pb-4">
          {f.mode === "ai" ? (
            <>
              <Field label="Skip leads with fit below" hint="The AI scores each company 0–10 against your profile. Low-fit leads are skipped so your daily emails go to the best prospects. 0 = never skip.">
                <Select value={f.min_fit_score} onChange={(e) => set("min_fit_score", Number(e.target.value))}>
                  {[0, 2, 3, 4, 5, 6, 7].map((v) => <option key={v} value={v}>{v === 0 ? "Don't skip any" : `${v}/10`}</option>)}
                </Select>
              </Field>
              <Toggle label="Approve emails before they send" hint="Every written email waits in “needs approval” until you approve it. Good for the first few days; turn off once you trust the output." checked={f.require_approval} onChange={(v) => set("require_approval", v)} />
            </>
          ) : (
            <Toggle label="Generate {{ai_line}} for each lead" checked={f.ai_enabled} onChange={(v) => set("ai_enabled", v)} />
          )}
          <Field label="Who this campaign targets" hint="Added to your company profile for this campaign only.">
            <Textarea rows={3} value={f.sender_context} onChange={(e) => set("sender_context", e.target.value)}
              placeholder="Operations and IT heads at mid-size manufacturers in South India who still process POs and invoices manually." />
          </Field>
          <Field label="Extra writing instructions" hint="Optional. Tone, what to emphasise, what to avoid.">
            <Textarea rows={3} value={f.ai_prompt} onChange={(e) => set("ai_prompt", e.target.value)}
              placeholder="Lead with document processing for manufacturers, NL→SQL for finance teams. Keep it under 90 words." />
          </Field>
        </div>
      </Card>

      <div className="lg:col-span-2 flex justify-end">
        <Button variant="primary" disabled={saving} onClick={() => run(() => saveCampaignSettings(campaign.id, f))}>{saving && <Spinner />}Save settings</Button>
      </div>
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
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
