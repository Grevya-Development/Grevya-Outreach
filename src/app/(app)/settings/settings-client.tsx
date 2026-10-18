"use client";

import { Globe, Plus, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";
import { addSuppression, importProfile, removeSuppression, saveProfile, testGroq } from "@/app/actions/misc";
import { ActionButton, Spinner, useAction } from "@/components/client";
import { Button, Field, Input, Textarea, timeAgo } from "@/components/ui";
import type { CompanyProfile } from "@/lib/research";

export function GroqTest() {
  return <ActionButton size="sm" className="justify-self-start" action={testGroq}>Test Groq connection</ActionButton>;
}

export function SuppressionList({ rows }: { rows: { email: string; reason: string; created_at: string }[] }) {
  const [text, setText] = useState("");
  const [pending, run] = useAction();
  return (
    <div className="px-4 pb-4 grid gap-3">
      <div className="flex gap-2 items-start">
        <Textarea rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste emails to block (comma or newline separated)" className="flex-1" />
        <Button disabled={pending || !text.trim()} onClick={() => run(() => addSuppression(text), () => setText(""))}>{pending ? <Spinner /> : <Plus size={15} />}Block</Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-[13px] text-muted">No blocked addresses.</p>
      ) : (
        <div className="rounded-lg border border-line divide-y divide-line max-h-80 overflow-y-auto">
          {rows.map((r) => (
            <div key={r.email} className="flex items-center gap-3 px-3 h-10 text-[13px]">
              <span className="flex-1 truncate">{r.email}</span>
              <span className="text-[12px] text-muted">{r.reason}</span>
              <span className="text-[12px] text-faint w-16 text-right tabular-nums">{timeAgo(r.created_at)}</span>
              <ActionButton size="sm" variant="ghost" className="w-7 px-0" title="Unblock" confirm={`Allow emailing ${r.email} again?`} action={() => removeSuppression(r.email)}><X size={14} /></ActionButton>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const PROFILE_FIELDS: { key: keyof CompanyProfile; label: string; hint?: string; rows?: number; placeholder?: string }[] = [
  { key: "name", label: "Company name", placeholder: "Grevya" },
  { key: "website", label: "Website", placeholder: "https://grevya.com" },
  { key: "one_liner", label: "What you do (one sentence)", rows: 2, placeholder: "We design, build and run Gen AI applications for enterprises — from first pilot to production in weeks." },
  { key: "services", label: "Services (one per line)", rows: 6, hint: "The AI picks the one that fits each prospect best.", placeholder: "- Agentic AI systems (multi-agent copilots for claims, support, ops)\n- Natural-language-to-SQL for business teams\n- Document processing automation (15+ formats)\n- Supply-chain analytics assistants\n- Recruiting automation: screen, score, schedule" },
  { key: "proof", label: "Proof & results (only real ones)", rows: 4, hint: "The AI may only quote numbers listed here. Leave empty rather than guess.", placeholder: "- Gen AI pilot shipped in 3 weeks\n- 45% lower inventory costs for a manufacturing client" },
  { key: "ideal_customer", label: "Ideal customer", rows: 2, placeholder: "Mid-size and enterprise companies in manufacturing, finance and logistics with manual, document-heavy workflows" },
  { key: "cta", label: "Your ask", placeholder: "Worth a 15-minute look at what a pilot could do for your team?" },
  { key: "tone", label: "Tone", placeholder: "Direct, warm, plain English. No hype." },
  { key: "sender_name", label: "Sender name", placeholder: "Kavin" },
  { key: "sender_title", label: "Sender title", placeholder: "Founder, Grevya" },
  { key: "address", label: "Company address (added under emails)", hint: "Anti-spam laws (e.g. US CAN-SPAM) require a physical address in commercial email.", placeholder: "Grevya Pvt Ltd, street, city, PIN, India" },
];

export function ProfileForm({ initial }: { initial: CompanyProfile }) {
  const [p, setP] = useState(initial);
  const [saving, runSave] = useAction();
  const [importing, setImporting] = useState(false);
  const dirty = JSON.stringify(p) !== JSON.stringify(initial);
  const set = (k: keyof CompanyProfile, v: string) => setP((x) => ({ ...x, [k]: v }));

  const doImport = async () => {
    const site = p.website || "https://grevya.com";
    setImporting(true);
    try {
      const r = await importProfile(site);
      if (!r.ok) return void toast.error(r.error);
      setP((x) => {
        const next = { ...x };
        for (const [k, v] of Object.entries(r.profile)) if (v && !x[k as keyof CompanyProfile]?.trim()) next[k as keyof CompanyProfile] = String(v);
        return next;
      });
      toast.success("Filled empty fields from your website — review and save");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="px-4 pb-4 grid gap-4">
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-accent-soft/60 px-3 py-2.5 text-[13px]">
        <Sparkles size={15} className="text-accent shrink-0" />
        <span className="flex-1 min-w-[200px]">Let the AI read your website and draft this for you. Only empty fields are filled.</span>
        <Button size="sm" onClick={doImport} disabled={importing}>{importing ? <Spinner /> : <Globe size={14} />}Import from website</Button>
      </div>
      <div className="grid md:grid-cols-2 gap-3">
        {PROFILE_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint} className={f.rows && f.rows > 2 ? "md:col-span-2" : undefined}>
            {f.rows ? (
              <Textarea rows={f.rows} value={p[f.key]} placeholder={f.placeholder} onChange={(e) => set(f.key, e.target.value)} />
            ) : (
              <Input value={p[f.key]} placeholder={f.placeholder} onChange={(e) => set(f.key, e.target.value)} />
            )}
          </Field>
        ))}
      </div>
      <div className="flex items-center justify-end gap-3">
        {dirty && <span className="text-[12.5px] text-warn">Unsaved changes</span>}
        <Button variant="primary" disabled={!dirty || saving} onClick={() => runSave(() => saveProfile(p))}>{saving && <Spinner />}Save profile</Button>
      </div>
    </div>
  );
}
