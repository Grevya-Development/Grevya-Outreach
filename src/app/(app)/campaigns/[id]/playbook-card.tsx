"use client";

import { ArrowDown, ArrowUp, BookOpenText, Save } from "lucide-react";
import { useState, type ReactNode } from "react";
import { saveCampaignPlaybook } from "@/app/actions/campaigns";
import { Spinner, useAction } from "@/components/client";
import { Button, Card, CardHeader, cx, Field, Input, Textarea } from "@/components/ui";
import { PILLARS, type EmailLength, type EmailStyle, type Pillar, type Playbook, type Section } from "@/lib/playbook-shared";

const STYLES: [EmailStyle, string, string][] = [
  ["use_case", "Use case", "Their problem → what we'd build → the outcome"],
  ["question", "Question", "One sharp question about a likely problem"],
  ["insight", "Insight", "An industry insight, tied to one use case"],
  ["story", "Story", "A short, true result from your proof list"],
];
const LENGTHS: [EmailLength, string][] = [["short", "Short · 45–80 words"], ["medium", "Medium · 70–110"], ["long", "Long · 100–150"]];
const SECTION_LABEL: Record<Section, string> = {
  opener: "Opener — one true, specific thing about them",
  problem: "Problem — the pain, named concretely",
  solution: "Solution — what we'd build, and with what",
  proof: "Proof — one real result from your profile",
  ask: "Ask — the call to action",
};
const ALL_SECTIONS: Section[] = ["opener", "problem", "solution", "proof", "ask"];

/** Like Field, but for a group of several controls (a <label> would forward clicks to the first one). */
function Group({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="grid grid-cols-1 gap-1.5 min-w-0">
      <span className="text-[12.5px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="text-[12px] text-muted leading-snug">{hint}</span>}
    </div>
  );
}

/** Segmented control: one choice from a short list. */
function Choice<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1 rounded-lg border border-line bg-panel-2 p-1">
      {options.map(([v, text]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}
          className={cx("rounded-md px-2.5 h-8 text-[12.5px] transition-colors", value === v ? "bg-panel shadow-sm font-medium text-ink" : "text-muted hover:text-ink")}>
          {text}
        </button>
      ))}
    </div>
  );
}

/** The AI playbook: how this campaign's emails are researched and written. */
export function PlaybookCard({ campaignId, playbook }: { campaignId: string; playbook: Playbook }) {
  const [pb, setPb] = useState<Playbook>(playbook);
  const [asDefault, setAsDefault] = useState(false);
  const [saving, run] = useAction();
  const [saved, setSaved] = useState(JSON.stringify(playbook));
  const dirty = JSON.stringify(pb) !== saved;
  const set = <K extends keyof Playbook>(k: K, v: Playbook[K]) => setPb((p) => ({ ...p, [k]: v }));

  const togglePillar = (p: Pillar) =>
    set("pillars", pb.pillars.includes(p) ? pb.pillars.filter((x) => x !== p) : PILLARS.filter((x) => x === p || pb.pillars.includes(x)));
  const move = (i: number, d: -1 | 1) => {
    const s = [...pb.structure];
    const j = i + d;
    if (j < 0 || j >= s.length) return;
    [s[i], s[j]] = [s[j], s[i]];
    set("structure", s);
  };
  const toggleSection = (sec: Section) =>
    set("structure", pb.structure.includes(sec) ? pb.structure.filter((x) => x !== sec) : [...pb.structure.filter((x) => x !== "ask"), sec, ...(pb.structure.includes("ask") ? ["ask" as Section] : [])]);

  const save = () => run(() => saveCampaignPlaybook(campaignId, pb, asDefault), () => { setSaved(JSON.stringify(pb)); setAsDefault(false); });

  return (
    <Card>
      <CardHeader
        title={<span className="flex items-center gap-1.5"><BookOpenText size={15} className="text-accent" />AI playbook — how emails are written</span>}
        description="For every lead the AI reads their website, researches their industry, and drafts 3 use cases from the areas you pick. Email 1 is built around the best one; each follow-up pitches the next." />
      <div className="grid grid-cols-1 gap-5 px-4 pb-4">
        <Group label="What you can pitch" hint="The AI only proposes solutions from the areas you turn on, described in your words. It never invents services beyond these.">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {PILLARS.map((p) => {
              const on = pb.pillars.includes(p);
              return (
                <div key={p} className={cx("rounded-lg border p-2.5 grid gap-2 transition-colors", on ? "border-accent/50 bg-accent-soft/30" : "border-line")}>
                  <label className="flex items-center gap-2 text-[13px] font-medium cursor-pointer select-none">
                    <input type="checkbox" checked={on} onChange={() => togglePillar(p)} className="accent-[var(--accent)] size-4" />
                    {p}
                  </label>
                  {on && (
                    <Textarea rows={2} value={pb.pillar_notes[p] ?? ""} aria-label={`What you do for ${p}`} className="text-[12.5px]"
                      onChange={(e) => set("pillar_notes", { ...pb.pillar_notes, [p]: e.target.value })} placeholder={`What you build under ${p}`} />
                  )}
                </div>
              );
            })}
          </div>
        </Group>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Who you're targeting" hint="Industries, company size, roles. Helps the AI pick the right problems.">
            <Textarea rows={2} value={pb.target} onChange={(e) => set("target", e.target.value)} placeholder="e.g. Mid-size manufacturers and logistics firms in India; COO / Head of Ops" />
          </Field>
          <Field label="Problems to look for" hint="The AI looks for signs of these on their website and in their industry.">
            <Textarea rows={2} value={pb.problem_focus} onChange={(e) => set("problem_focus", e.target.value)} placeholder="e.g. manual document processing, slow quoting, support backlog, data stuck in spreadsheets" />
          </Field>
        </div>

        <Group label="How Email 1 opens">
          <div className="grid gap-1.5">
            <Choice label="Email style" value={pb.style} onChange={(v) => set("style", v)} options={STYLES.map(([v, l]) => [v, l])} />
            <p className="text-[12px] text-muted">{STYLES.find(([v]) => v === pb.style)?.[2]}</p>
          </div>
        </Group>

        <Group label="Email 1 structure" hint="Sections in order. Use the arrows to reorder; remove a section to leave it out.">
          <ol className="grid grid-cols-1 gap-1">
            {pb.structure.map((sec, i) => (
              <li key={sec} className="flex items-center gap-2 rounded-md border border-line px-2 h-9 text-[12.5px]">
                <span className="w-4 text-faint tabular-nums">{i + 1}</span>
                <span className="flex-1 min-w-0 truncate">{SECTION_LABEL[sec]}</span>
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up" className="p-1 text-muted hover:text-ink disabled:opacity-30"><ArrowUp size={14} /></button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === pb.structure.length - 1} aria-label="Move down" className="p-1 text-muted hover:text-ink disabled:opacity-30"><ArrowDown size={14} /></button>
                <button type="button" onClick={() => toggleSection(sec)} disabled={pb.structure.length <= 2} className="px-1.5 text-[12px] text-muted hover:text-bad disabled:opacity-30">Remove</button>
              </li>
            ))}
          </ol>
          {ALL_SECTIONS.some((s) => !pb.structure.includes(s)) && (
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {ALL_SECTIONS.filter((s) => !pb.structure.includes(s)).map((s) => (
                <Button key={s} size="sm" variant="ghost" onClick={() => toggleSection(s)}>+ {s[0].toUpperCase() + s.slice(1)}</Button>
              ))}
            </div>
          )}
        </Group>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Group label="Length">
            <Choice label="Email length" value={pb.length} onChange={(v) => set("length", v)} options={LENGTHS} />
          </Group>
          <Group label="Follow-ups">
            <Choice label="Follow-up strategy" value={pb.follow_up_strategy} onChange={(v) => set("follow_up_strategy", v)}
              options={[["new_use_case", "A new use case each time"], ["same_use_case", "Nudge the same one"]]} />
          </Group>
          <Field label="Tone">
            <Input value={pb.tone} onChange={(e) => set("tone", e.target.value)} placeholder="e.g. Direct, warm, plain English" />
          </Field>
          <Field label="Call to action">
            <Input value={pb.cta} onChange={(e) => set("cta", e.target.value)} placeholder="e.g. Worth a 15-minute call next week?" />
          </Field>
          <Field label="Never say" hint="Words, claims or topics to avoid.">
            <Input value={pb.avoid} onChange={(e) => set("avoid", e.target.value)} placeholder="e.g. 'revolutionary', pricing, competitors by name" />
          </Field>
          <Field label="Always mention" hint="Something every Email 1 should include.">
            <Input value={pb.must_mention} onChange={(e) => set("must_mention", e.target.value)} placeholder="e.g. we run a free 2-week pilot" />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
          <label className="flex items-center gap-2 text-[12.5px] text-muted cursor-pointer select-none">
            <input type="checkbox" checked={asDefault} onChange={(e) => setAsDefault(e.target.checked)} className="accent-[var(--accent)] size-4" />
            Also use as the default for new campaigns
          </label>
          <span className="text-[12px] text-faint">Saving rewrites drafts that haven&apos;t been sent (hand-edited ones are kept).</span>
          <div className="ml-auto flex gap-2">
            {dirty && <Button variant="ghost" onClick={() => setPb(JSON.parse(saved) as Playbook)} disabled={saving}>Discard</Button>}
            <Button variant="primary" onClick={save} disabled={saving || (!dirty && !asDefault) || !pb.pillars.length}>
              {saving ? <Spinner /> : <Save size={14} />}Save playbook
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
