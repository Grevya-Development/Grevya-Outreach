"use client";

import { ChevronLeft, ChevronRight, Plus, RefreshCw, Send, Shuffle, Sparkles, TextCursorInput, Wand2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { aiDraftStep, previewForLead, saveSteps, type StepInput } from "@/app/actions/campaigns";
import { Dialog, Menu, Spinner, useAction } from "@/components/client";
import { Button, Card, CardHeader, Empty, Input, Textarea, cx } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import { checkContent, type SpamReport } from "@/lib/spamcheck";
import { missingVariables, render, type TemplateLead } from "@/lib/template";
import { EditFooter, useUnsavedGuard } from "./builder";
import { EmailCard, TestStepDialog } from "./campaign-client";

export type PreviewLeadItem = { id: string; label: string };
export type SelectedPreview = {
  id: string;
  status: string;
  prepStatus: string | null;
  skipReason: string | null;
  lead: TemplateLead & { id: string };
  aiLine: string | null;
  /** AI mode: the stored emails, rendered on the server exactly as they'll be sent. */
  aiEmails: { label: string; subject: string; body: string; spam: SpamReport }[] | null;
  /** "Name <email>" of the account this lead's emails come from. */
  from: string;
};
type Sender = { email: string; from_name: string; signature: string };
type CampaignInfo = { id: string; name: string; status: string; mode: "ai" | "template"; include_unsubscribe: boolean; ai_enabled: boolean };

const PLACEHOLDER_RE = /<[^<>\n]{3,}>/g;
const OPT_OUT = `Not the right person, or not interested? Just reply "no" and I won't email again.`;

export function SequenceTab({
  campaign, builder, confirmed, steps: initial, previewLeads, selected, sender, customKeys, unsentWritten, editedCount, progress, viewParam, backHref, nextHref,
}: {
  campaign: CampaignInfo;
  builder: boolean;
  /** The sequence has been saved since the campaign was made (always true before migration 0004). */
  confirmed: boolean;
  steps: StepInput[];
  previewLeads: PreviewLeadItem[];
  selected: SelectedPreview | null;
  sender: Sender | null;
  /** Custom CSV fields found on this campaign's leads (for the Insert menu). */
  customKeys: string[];
  /** AI emails written for leads not yet contacted (they'd be rewritten). */
  unsentWritten: number;
  /** …of which the user edited by hand. */
  editedCount: number;
  progress: { done: number; total: number } | null;
  viewParam: string;
  backHref?: string;
  nextHref?: string;
}) {
  const ai = campaign.mode === "ai";
  const router = useRouter();
  const saved = useMemo(() => JSON.stringify(initial), [initial]);
  const [steps, setSteps] = useState<StepInput[]>(initial);
  const [active, setActive] = useState(0);
  const [saving, runSave] = useAction();
  const [ask, setAsk] = useState<((v: boolean | null) => void) | null>(null);
  const dirty = JSON.stringify(steps) !== saved;
  useUnsavedGuard(dirty);
  const update = (i: number, patch: Partial<StepInput>) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  /** "Rewrite them" (true) / "Keep them (only new leads)" (false) / closed (null). */
  const askRewrite = () => new Promise<boolean | null>((resolve) => setAsk(() => (v: boolean | null) => { setAsk(null); resolve(v); }));

  const save = async () => {
    // A draft whose sequence was already saved just moves on (saving it the first time confirms it).
    if (builder && !dirty && confirmed && nextHref) return router.push(nextHref, { scroll: false });
    const instructionsChanged = ai && JSON.stringify(steps.map((s) => s.body)) !== JSON.stringify(initial.map((s) => s.body));
    let rewrite = false;
    if (instructionsChanged && unsentWritten > 0) {
      const choice = await askRewrite();
      if (choice === null) return;
      rewrite = choice;
    }
    runSave(() => saveSteps(campaign.id, steps, { rewrite }), () => { if (builder && nextHref) router.push(nextHref, { scroll: false }); });
  };

  return (
    <div className="grid gap-4 min-w-0">
      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)] gap-5 items-start">
        <div className="grid gap-3 min-w-0">
          {ai && (
            <div className="rounded-xl bg-accent-soft/60 px-4 py-3 text-[13px] flex gap-2.5">
              <Sparkles size={16} className="text-accent shrink-0 mt-0.5" />
              <div>
                <b>AI-written.</b> For every lead the AI reads their company website, scores the fit and writes each email from your instructions below. Subjects are written per lead.
              </div>
            </div>
          )}
          {steps.map((step, i) => (
            <div key={i}>
              {i > 0 && (
                <div className="flex flex-wrap items-center gap-2 py-2 pl-4 text-[12.5px] text-muted">
                  <span className="w-px h-5 bg-line" />
                  Wait
                  <Input type="number" min={1} max={60} value={step.delay_days} aria-label={`Days before email ${i + 1}`}
                    onChange={(e) => update(i, { delay_days: Number(e.target.value) })} className="w-16 h-7 text-center" />
                  days, then, if no reply…
                </div>
              )}
              <StepEditor ai={ai} index={i} step={step} active={active === i} campaignId={campaign.id} customKeys={customKeys}
                onFocus={() => setActive(i)} onChange={(patch) => update(i, patch)}
                onRemove={steps.length > 1 ? () => { setSteps((s) => s.filter((_, j) => j !== i)); setActive(0); } : undefined} />
            </div>
          ))}
          {steps.length < 6 && (
            <div>
              <Button onClick={() => { setSteps((s) => [...s, { delay_days: 3, subject: "", body: "" }]); setActive(steps.length); }}>
                <Plus size={15} />Add follow-up
              </Button>
            </div>
          )}
          {!ai && <VariableHelp />}
        </div>

        <div className="lg:sticky lg:top-4 min-w-0">
          <PreviewPanel campaign={campaign} steps={steps} activeStep={active} previewLeads={previewLeads} selected={selected} sender={sender}
            progress={progress} dirty={dirty} viewParam={viewParam} />
        </div>
      </div>

      <EditFooter builder={builder} backHref={backHref} dirty={dirty} saving={saving} onSave={save} onDiscard={() => setSteps(initial)} />

      {ask && (
        <Dialog open onClose={() => ask(null)} title={`Rewrite ${fmtNum(unsentWritten)} email${unsentWritten === 1 ? "" : "s"} that haven't been sent?`}
          footer={<>
            <Button onClick={() => ask(false)}>Keep them (only new leads)</Button>
            <Button variant="primary" onClick={() => ask(true)} data-autofocus="">Rewrite them</Button>
          </>}>
          <p className="text-[13.5px] text-muted leading-relaxed">
            The AI already wrote emails for {fmtNum(unsentWritten)} lead{unsentWritten === 1 ? "" : "s"} with the old instructions. Rewrite them with the new ones, or keep them and use the new instructions only for leads written from now on.
            {editedCount > 0 && <> ({fmtNum(editedCount)} you edited by hand will also be rewritten.)</>}
          </p>
        </Dialog>
      )}
    </div>
  );
}

/* ───────────── one step ───────────── */

function StepEditor({ ai, index, step, active, campaignId, customKeys, onFocus, onChange, onRemove }: {
  ai: boolean; index: number; step: StepInput; active: boolean; campaignId: string; customKeys: string[];
  onFocus: () => void; onChange: (p: Partial<StepInput>) => void; onRemove?: () => void;
}) {
  const [lastField, setLastField] = useState<"subject" | "body">("body");
  const [briefOpen, setBriefOpen] = useState(false);
  const [brief, setBrief] = useState("");
  const [drafting, startDraft] = useTransition();

  /** Inserts at the cursor of the field last typed in (the body by default). */
  const insert = (token: string) => {
    const field = lastField;
    const el = document.getElementById(`step-${index}-${field}`) as HTMLInputElement | HTMLTextAreaElement | null;
    const value = field === "subject" ? step.subject : step.body;
    const a = el?.selectionStart ?? value.length;
    const b = el?.selectionEnd ?? value.length;
    onChange({ [field]: value.slice(0, a) + token + value.slice(b) });
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(a + token.length, a + token.length); });
  };

  const draft = () => startDraft(async () => {
    const r = await aiDraftStep(campaignId, index, brief);
    if (!r.ok) return void toast.error(r.error);
    onChange(index === 0 ? { subject: r.subject, body: r.body } : { body: r.body });
    setBriefOpen(false);
    toast.success("Draft written. Edit it so it sounds like you");
  });

  const placeholders = [...new Set(`${step.subject}\n${step.body}`.match(PLACEHOLDER_RE) ?? [])];
  const title = index === 0 ? "Email 1" : `Email ${index + 1} · follow-up (same thread)`;
  const insertItems = [
    ["First name", "{{first_name|there}}"], ["Last name", "{{last_name}}"], ["Company", "{{company|your team}}"], ["Job title", "{{title}}"],
    ["Website", "{{website}}"], ["AI opening line", "{{ai_line}}"], ["Signature", "{{signature}}"],
    ...customKeys.map((k) => [k.replace(/_/g, " "), `{{${k}}}`]),
  ].map(([label, token]) => ({ label, onSelect: () => insert(token) }));

  return (
    <Card className={cx("transition-shadow", active && "ring-2 ring-accent/25 border-accent/40")} onFocusCapture={onFocus}>
      <div className="flex items-center justify-between px-4 pt-3">
        <div className="text-[13px] font-semibold">{title}</div>
        {onRemove && <Button size="sm" variant="ghost" className="w-8 px-0" onClick={onRemove} aria-label={`Remove email ${index + 1}`} title="Remove this email"><X size={15} /></Button>}
      </div>
      {briefOpen && (
        <div className="mx-4 mt-3 rounded-lg bg-accent-soft/60 p-3 grid gap-2 fade-in">
          <Textarea rows={2} autoFocus value={brief} onChange={(e) => setBrief(e.target.value)}
            placeholder="What should this email say? e.g. We build AI pilots in 3 weeks. Ask if they have a document-heavy process to automate." />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setBriefOpen(false)}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={draft} disabled={drafting || !brief.trim()}>{drafting ? <Spinner /> : <Sparkles size={14} />}Write it</Button>
          </div>
        </div>
      )}
      <div className="grid gap-2 p-4 pt-3">
        {ai ? (
          <>
            <label htmlFor={`step-${index}`} className="text-[12px] text-muted">What should this email say? (instructions for the AI)</label>
            <Textarea id={`step-${index}`} rows={3} value={step.body} onChange={(e) => onChange({ body: e.target.value })} className="text-[13.5px]"
              placeholder={index === 0 ? "e.g. Open with a specific detail about their company and connect it to our best-fit service with one proof point." : "e.g. Share a different use case for their industry."} />
            <p className="text-[11.5px] text-faint">
              {index === 0
                ? "The AI builds this email around the best of 3 use cases it drafts for each lead. Style, structure, length and tone are set in Options → AI playbook."
                : "Pitches the next use case from the lead's research (or nudges the same one, per your playbook)."}
            </p>
          </>
        ) : (
          <>
            <Input id={`step-${index}-subject`} value={step.subject} aria-label="Subject" onFocus={() => setLastField("subject")}
              onChange={(e) => onChange({ subject: e.target.value })}
              placeholder={index === 0 ? "Subject" : "Subject (leave empty to reply in the same thread, recommended)"} className="font-medium" />
            <Textarea id={`step-${index}-body`} rows={index === 0 ? 10 : 5} value={step.body} aria-label="Body" onFocus={() => setLastField("body")}
              onChange={(e) => onChange({ body: e.target.value })} placeholder="Write your email…" className="text-[13.5px]" />
            <div className="flex flex-wrap items-center gap-1.5">
              <Menu align="start" trigger={<Button size="sm"><TextCursorInput size={14} />Insert</Button>} items={insertItems} />
              <Button size="sm" onClick={() => insert("{Hi|Hey|Hello}")} title="Each lead gets one of the options, so no two emails are identical"><Shuffle size={14} />Variations…</Button>
              <Button size="sm" variant="ghost" onClick={() => setBriefOpen((v) => !v)}><Wand2 size={14} />Write with AI</Button>
              {placeholders.length > 0 && (
                <span className="ml-auto text-[12px] text-warn" title={placeholders.join(", ")}>
                  {placeholders.length === 1 ? "1 thing still to fill in" : `${placeholders.length} things still to fill in`}: <span className="font-mono">{placeholders.slice(0, 3).join(", ")}{placeholders.length > 3 ? "…" : ""}</span>
                </span>
              )}
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
      <summary className="cursor-pointer select-none">How personal fields work</summary>
      <ul className="mt-2 grid gap-1.5 list-disc pl-4">
        <li><code className="text-ink">{"{{first_name|there}}"}</code> puts in the lead&apos;s first name, or “there” when it&apos;s empty.</li>
        <li><code className="text-ink">{"{{ai_line}}"}</code> is the AI opening line: one sentence the AI writes for each lead.</li>
        <li><code className="text-ink">{"{Hi|Hey|Hello}"}</code> is a variation: each lead gets one of the options.</li>
        <li>Any extra CSV column works too, e.g. <code className="text-ink">{"{{industry}}"}</code>.</li>
        <li>Text like <code className="text-ink">&lt;your result&gt;</code> is a placeholder: replace it before launching.</li>
      </ul>
    </details>
  );
}

/* ───────────── preview ───────────── */

function PreviewPanel({ campaign, steps, activeStep, previewLeads, selected, sender, progress, dirty, viewParam }: {
  campaign: CampaignInfo; steps: StepInput[]; activeStep: number; previewLeads: PreviewLeadItem[]; selected: SelectedPreview | null;
  sender: Sender | null; progress: { done: number; total: number } | null; dirty: boolean; viewParam: string;
}) {
  const router = useRouter();
  const ai = campaign.mode === "ai";
  const [moving, startMove] = useTransition();
  const [writing, startWrite] = useTransition();
  const [aiLines, setAiLines] = useState<Record<string, string>>({});
  const [testOpen, setTestOpen] = useState(false);

  if (!selected) {
    return (
      <Card>
        <CardHeader title="Preview" />
        <Empty title="Add leads to preview">The preview shows each email exactly as a real lead will get it.</Empty>
      </Card>
    );
  }

  const i = previewLeads.findIndex((l) => l.id === selected.id);
  const goTo = (id: string) => startMove(() => router.replace(`/campaigns/${campaign.id}?${viewParam}&lead=${id}`, { scroll: false }));
  const prev = i > 0 ? previewLeads[i - 1] : null;
  const next = i >= 0 && i < previewLeads.length - 1 ? previewLeads[i + 1] : !previewLeads.length || i < 0 ? previewLeads[0] ?? null : null;
  const current = previewLeads[i];

  const writeNow = () => startWrite(async () => {
    const r = await previewForLead(campaign.id, selected.id, null, false);
    if (!r.ok) return void toast.error(r.error);
    toast.success("Written");
    router.refresh();
  });
  const usesAiLine = steps.some((s) => /\{\{\s*ai_line/.test(s.body) || /\{\{\s*ai_line/.test(s.subject));
  const aiLine = aiLines[selected.id] ?? selected.aiLine;
  const generateLine = () => startWrite(async () => {
    const r = await previewForLead(campaign.id, selected.id, steps, Boolean(aiLine));
    if (!r.ok) return void toast.error(r.error);
    if (r.aiLine) setAiLines((m) => ({ ...m, [selected.id]: r.aiLine! }));
  });

  return (
    <Card>
      <CardHeader title={ai ? "Emails for a real lead" : `Preview · Email ${activeStep + 1}`}
        description={ai ? "Exactly what this lead will get." : "Updates as you type. Click an email on the left to preview it."}
        actions={<Button size="sm" onClick={() => setTestOpen(true)}><Send size={14} />Send me a test</Button>} />
      <div className="px-4 pb-3 flex items-center gap-2">
        <Button size="sm" variant="ghost" className="w-8 px-0" disabled={!prev || moving} onClick={() => prev && goTo(prev.id)} aria-label="Previous lead"><ChevronLeft size={16} /></Button>
        <div className="flex-1 min-w-0 text-center">
          <div className="text-[13px] font-medium truncate">{current?.label ?? selected.lead.email}</div>
          {previewLeads.length > 0 && i >= 0 && <div className="text-[11.5px] text-faint tabular-nums">Lead {fmtNum(i + 1)} of {fmtNum(previewLeads.length)}</div>}
        </div>
        {moving && <Spinner className="text-faint" />}
        <Button size="sm" variant="ghost" className="w-8 px-0" disabled={!next || moving} onClick={() => next && goTo(next.id)} aria-label="Next lead"><ChevronRight size={16} /></Button>
      </div>

      {ai ? (
        <div className="grid gap-3 px-4 pb-4">
          {dirty && <p className="text-[12px] text-warn">Save the sequence first: the AI writes from the saved instructions.</p>}
          {selected.status === "skipped" ? (
            <p className="text-[13px] text-muted">This lead was skipped{selected.skipReason ? `: ${selected.skipReason}` : "."}</p>
          ) : selected.aiEmails ? (
            selected.aiEmails.map((e) => <EmailCard key={e.label} label={e.label} from={selected.from} to={selected.lead.email} subject={e.subject} body={e.body} spam={e.spam} />)
          ) : (
            <div className="rounded-lg bg-panel-2 px-3 py-4 text-[13px] grid gap-2 justify-items-start">
              <div className="font-medium">Not written yet.</div>
              {progress && progress.total > 0 && <div className="text-muted">AI is writing {fmtNum(progress.done)} of {fmtNum(progress.total)}.</div>}
              {writing
                ? <div className="text-muted flex items-center gap-2"><Spinner />Reading {selected.lead.website || selected.lead.email.split("@")[1]} and writing… (10–30s)</div>
                : <Button size="sm" onClick={writeNow}><Sparkles size={14} />Write this one now</Button>}
            </div>
          )}
        </div>
      ) : (
        <TemplatePreview campaign={campaign} steps={steps} activeStep={activeStep} selected={selected} sender={sender} aiLine={aiLine} />
      )}
      {!ai && campaign.ai_enabled && usesAiLine && (
        <div className="px-4 pb-4 -mt-1">
          <Button size="sm" onClick={generateLine} disabled={writing}>{writing ? <Spinner /> : aiLine ? <RefreshCw size={14} /> : <Sparkles size={14} />}{aiLine ? "Write the opening line again" : "Generate opening line"}</Button>
        </div>
      )}
      {testOpen && (
        <TestStepDialog campaignId={campaign.id} stepCount={steps.length} defaultTo={sender?.email ?? ""} defaultStep={activeStep}
          campaignLeadId={selected.id} leadLabel={current?.label ?? selected.lead.email} onClose={() => setTestOpen(false)} />
      )}
    </Card>
  );
}

function TemplatePreview({ campaign, steps, activeStep, selected, sender, aiLine }: {
  campaign: CampaignInfo; steps: StepInput[]; activeStep: number; selected: SelectedPreview; sender: Sender | null; aiLine: string | null;
}) {
  const ctx = {
    lead: selected.lead,
    aiLine: aiLine ?? (campaign.ai_enabled ? "⟨AI opening line, click Generate⟩" : ""),
    senderName: sender?.from_name,
    signature: sender?.signature,
    unsubscribeUrl: "",
    seed: `${selected.id}:${activeStep + 1}`,
  };
  const step = steps[activeStep] ?? steps[0];
  if (!step) return null;
  let subject = render(step.subject, ctx);
  if (activeStep > 0 && !subject) subject = `Re: ${render(steps[0].subject, { ...ctx, seed: `${selected.id}:1` })}`;
  let body = render(step.body, ctx);
  if (sender?.signature && !/\{\{\s*signature/.test(step.body)) body += `\n\n${render(sender.signature, ctx)}`;
  if (campaign.include_unsubscribe) body += `\n\n${OPT_OUT}`;
  const missing = [...missingVariables(step.subject, ctx), ...missingVariables(step.body, ctx)].filter((v) => v !== "ai_line");

  return (
    <div className="grid gap-2 px-4 pb-4">
      <EmailCard from={selected.from} to={selected.lead.email} subject={subject} body={body}
        spam={checkContent(subject, body, { allowLinks: 1, isFollowUp: activeStep > 0 })} />
      {missing.length > 0 && (
        <p className="text-[12px] text-warn">This lead has nothing for {missing.map((m) => `{{${m}}}`).join(", ")}. Add a fallback like {"{{company|your team}}"}.</p>
      )}
    </div>
  );
}
