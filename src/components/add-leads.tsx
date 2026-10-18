"use client";

import { ClipboardList, UserPlus } from "lucide-react";
import { useMemo, useState } from "react";
import { addLeadsManually } from "@/app/actions/leads";
import { parseLeads } from "@/lib/parse-leads";
import { Dialog, Spinner, useAction } from "./client";
import { Button, Field, Input, Select, Textarea, cx } from "./ui";

type Mode = "one" | "paste";

export function AddLeadsButton({ campaigns = [], campaignId, label = "Add leads", variant = "secondary" }: {
  campaigns?: { id: string; name: string }[];
  campaignId?: string;
  label?: string;
  variant?: "primary" | "secondary";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}><UserPlus size={15} />{label}</Button>
      {open && <AddLeadsDialog campaigns={campaigns} campaignId={campaignId} onClose={() => setOpen(false)} />}
    </>
  );
}

function AddLeadsDialog({ campaigns, campaignId, onClose }: { campaigns: { id: string; name: string }[]; campaignId?: string; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>("one");
  const [one, setOne] = useState({ email: "", first_name: "", last_name: "", company: "", title: "", website: "", notes: "" });
  const [paste, setPaste] = useState("");
  const [tags, setTags] = useState("manual");
  const [target, setTarget] = useState(campaignId ?? "");
  const [pending, run] = useAction();
  const parsed = useMemo(() => parseLeads(paste), [paste]);
  const set = (k: keyof typeof one, v: string) => setOne((p) => ({ ...p, [k]: v }));

  const leads = mode === "one" ? (one.email.includes("@") ? [one] : []) : parsed.leads;
  const submit = () => run(
    () => addLeadsManually({ leads, tags: tags.split(",").map((t) => t.trim()).filter(Boolean), campaignId: target || null }),
    onClose,
  );

  return (
    <Dialog open onClose={onClose} wide title="Add leads by hand"
      description="Duplicates are merged by email. People on your block list are never emailed."
      footer={<Button variant="primary" onClick={submit} disabled={pending || !leads.length}>{pending && <Spinner />}
        {leads.length > 1 ? `Add ${leads.length} leads` : "Add lead"}{target ? " to campaign" : ""}</Button>}>
      <div className="grid grid-cols-1 gap-4">
        <div className="inline-flex rounded-lg border border-line p-0.5 justify-self-start">
          {([["one", "One person", UserPlus], ["paste", "Paste a list", ClipboardList]] as const).map(([k, l, Icon]) => (
            <button key={k} type="button" onClick={() => setMode(k)}
              className={cx("h-8 px-3 rounded-md text-[13px] inline-flex items-center gap-1.5 transition-colors", mode === k ? "bg-accent-soft text-accent font-medium" : "text-muted hover:text-ink")}>
              <Icon size={14} />{l}
            </button>
          ))}
        </div>

        {mode === "one" ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Email *" className="sm:col-span-2"><Input type="email" value={one.email} autoFocus placeholder="priya@acme.com" onChange={(e) => set("email", e.target.value)} /></Field>
            <Field label="First name"><Input value={one.first_name} onChange={(e) => set("first_name", e.target.value)} /></Field>
            <Field label="Last name"><Input value={one.last_name} onChange={(e) => set("last_name", e.target.value)} /></Field>
            <Field label="Company"><Input value={one.company} onChange={(e) => set("company", e.target.value)} /></Field>
            <Field label="Job title"><Input value={one.title} onChange={(e) => set("title", e.target.value)} /></Field>
            <Field label="Website" hint="The AI researches this site to personalise emails" className="sm:col-span-2">
              <Input value={one.website} placeholder="acme.com" onChange={(e) => set("website", e.target.value)} />
            </Field>
            <Field label="Notes" hint="Anything the AI should know — where you met, what they posted, mutual contacts…" className="sm:col-span-2">
              <Textarea rows={2} value={one.notes} onChange={(e) => set("notes", e.target.value)} />
            </Field>
          </div>
        ) : (
          <div className="grid gap-2">
            <Textarea rows={8} value={paste} autoFocus onChange={(e) => setPaste(e.target.value)} className="font-mono text-[12.5px]"
              placeholder={"priya@acme.com\nRahul Mehta <rahul@delhivery.com>\nAnita Rao, anita@tvsmotor.com, TVS Motor, Head of IT"} />
            <p className="text-[12px] text-muted">
              One person per line. Works with plain emails, <code>Name &lt;email&gt;</code>, or <code>Name, email, Company, Title</code> (also pasted spreadsheet rows).
              {paste.trim() && <> Found <b className="text-ink">{parsed.leads.length}</b> email{parsed.leads.length === 1 ? "" : "s"}{parsed.invalid.length ? `, ${parsed.invalid.length} line(s) without an email skipped` : ""}.</>}
            </p>
            {parsed.leads.length > 0 && (
              <div className="rounded-lg border border-line max-h-40 overflow-y-auto divide-y divide-line text-[12.5px]">
                {parsed.leads.slice(0, 50).map((l) => (
                  <div key={l.email} className="flex gap-3 px-3 py-1.5">
                    <span className="font-medium truncate flex-1">{l.email}</span>
                    <span className="text-muted truncate">{[l.first_name, l.last_name].filter(Boolean).join(" ")}</span>
                    <span className="text-faint truncate">{l.company}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Tags" hint="Comma-separated"><Input value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
          {!campaignId && (
            <Field label="Also add to campaign" hint="Optional">
              <Select value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">— Don&apos;t add to a campaign —</option>
                {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
          )}
        </div>
      </div>
    </Dialog>
  );
}
