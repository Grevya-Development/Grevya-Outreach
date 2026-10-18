"use client";

import { ChevronLeft, ChevronRight, FileUp, Search, ShieldCheck, Tag, Trash2, Upload, Users } from "lucide-react";
import Papa from "papaparse";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { deleteLeads, importLeads, tagLeads, verifyLeads } from "@/app/actions/leads";
import { ActionButton, Dialog, Spinner } from "@/components/client";
import { Badge, Button, Card, Empty, Field, Input, Select, StatusBadge, Td, Th, cx } from "@/components/ui";
import type { Lead } from "@/lib/types";

const FIELDS = [
  { key: "email", label: "Email", guess: /^e-?mail|email address|work email/i },
  { key: "first_name", label: "First name", guess: /^first|^fname|given/i },
  { key: "last_name", label: "Last name", guess: /^last|^lname|surname|family/i },
  { key: "company", label: "Company", guess: /company|organi[sz]ation|account|business/i },
  { key: "title", label: "Job title", guess: /title|position|role|designation/i },
  { key: "website", label: "Website", guess: /website|domain|url|site/i },
  { key: "linkedin", label: "LinkedIn", guess: /linkedin/i },
  { key: "phone", label: "Phone", guess: /phone|mobile/i },
  { key: "city", label: "City", guess: /city|location/i },
  { key: "notes", label: "Notes", guess: /note|comment|about|description|bio/i },
] as const;

function toggle(set: Set<string>, id: string): Set<string> {
  const n = new Set(set);
  if (n.has(id)) n.delete(id);
  else n.add(id);
  return n;
}

export function LeadsFilters({ q, tag, status, tags }: { q: string; tag: string; status: string; tags: { tag: string; n: number }[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [text, setText] = useState(q);
  const [pending, start] = useTransition();

  const push = (patch: Record<string, string>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    next.delete("page");
    start(() => router.replace(`${pathname}?${next.toString()}`, { scroll: false }));
  };

  // Debounced search-as-you-type.
  useEffect(() => {
    if (text === q) return;
    const t = setTimeout(() => push({ q: text }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative flex-1 min-w-[220px] max-w-sm">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search name, email, company" className="pl-9" />
      </div>
      <div className="w-44">
        <Select value={tag} onChange={(e) => push({ tag: e.target.value })}>
          <option value="">All tags</option>
          {tags.map((t) => <option key={t.tag} value={t.tag}>{t.tag} ({t.n})</option>)}
        </Select>
      </div>
      <div className="w-36">
      <Select value={status} onChange={(e) => push({ status: e.target.value })}>
        <option value="">Any status</option>
        <option value="active">Active</option>
        <option value="unsubscribed">Unsubscribed</option>
        <option value="bounced">Bounced</option>
        <option value="invalid">Invalid</option>
      </Select>
      </div>
      {pending && <Spinner className="text-faint" />}
    </div>
  );
}

export function LeadsTable({ leads, total, page, pageSize }: { leads: Lead[]; total: number; page: number; pageSize: number }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tagOpen, setTagOpen] = useState(false);
  const router = useRouter();
  const sp = useSearchParams();
  const pathname = usePathname();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const all = leads.length > 0 && leads.every((l) => selected.has(l.id));

  const goto = (p: number) => {
    const next = new URLSearchParams(sp.toString());
    next.set("page", String(p));
    router.push(`${pathname}?${next.toString()}`, { scroll: false });
  };

  if (!leads.length) {
    return <Card><Empty icon={<Users size={28} />} title={total === 0 && !sp.toString() ? "No leads yet" : "No matches"} action={!sp.toString() ? <ImportButton /> : undefined}>
      {!sp.toString() ? "Import a CSV with at least an email column. Extra columns become variables you can use in emails." : "Try a different search or filter."}
    </Empty></Card>;
  }

  const ids = [...selected];
  return (
    <Card className="overflow-hidden">
      {selected.size > 0 && (
        <div className="flex items-center gap-2 px-3 h-11 border-b border-line bg-accent-soft/60 fade-in">
          <span className="text-[13px] font-medium mr-auto">{selected.size} selected</span>
          <Button size="sm" onClick={() => setTagOpen(true)}><Tag size={14} />Tag</Button>
          <ActionButton size="sm" action={() => verifyLeads(ids)}><ShieldCheck size={14} />Verify</ActionButton>
          <ActionButton size="sm" variant="danger" confirm={`Delete ${selected.size} lead(s)? This also removes them from campaigns.`}
            action={async () => { const r = await deleteLeads(ids); setSelected(new Set()); return r; }}><Trash2 size={14} />Delete</ActionButton>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead className="bg-panel-2/50">
            <tr>
              <Th className="w-10"><input type="checkbox" checked={all} onChange={() => setSelected(all ? new Set() : new Set(leads.map((l) => l.id)))} className="accent-[var(--accent)]" /></Th>
              <Th>Email</Th><Th>Name</Th><Th>Company</Th><Th>Title</Th><Th>Tags</Th><Th>Status</Th><Th>Verified</Th>
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => (
              <tr key={l.id} className={cx("hover:bg-panel-2/60 transition-colors", selected.has(l.id) && "bg-accent-soft/40")}>
                <Td><input type="checkbox" checked={selected.has(l.id)} className="accent-[var(--accent)]"
                  onChange={() => setSelected((s) => toggle(s, l.id))} /></Td>
                <Td className="font-medium max-w-[240px] truncate">{l.email}</Td>
                <Td className="whitespace-nowrap">{[l.first_name, l.last_name].filter(Boolean).join(" ") || <span className="text-faint">—</span>}</Td>
                <Td className="max-w-[180px] truncate">{l.company || <span className="text-faint">—</span>}</Td>
                <Td className="max-w-[180px] truncate text-muted">{l.title}</Td>
                <Td><div className="flex gap-1 flex-wrap">{l.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div></Td>
                <Td><StatusBadge status={l.status} /></Td>
                <Td>{l.verify_status ? <StatusBadge status={l.verify_status} /> : <span className="text-faint text-[12px]">not checked</span>}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between px-3 h-11 text-[12.5px] text-muted">
        <span className="tabular-nums">{(page - 1) * pageSize + 1}–{Math.min(total, page * pageSize)} of {total.toLocaleString()}</span>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => goto(page - 1)} aria-label="Previous page"><ChevronLeft size={15} /></Button>
          <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => goto(page + 1)} aria-label="Next page"><ChevronRight size={15} /></Button>
        </div>
      </div>
      {tagOpen && <TagDialog ids={ids} onClose={() => setTagOpen(false)} />}
    </Card>
  );
}

function TagDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const [tag, setTag] = useState("");
  const [pending, start] = useTransition();
  return (
    <Dialog open onClose={onClose} title={`Tag ${ids.length} lead(s)`}
      footer={<Button variant="primary" disabled={pending || !tag.trim()} onClick={() => start(async () => {
        const r = await tagLeads(ids, tag);
        if (r.ok) { toast.success(r.message); onClose(); } else toast.error(r.error);
      })}>{pending && <Spinner />}Add tag</Button>}>
      <Field label="Tag"><Input autoFocus value={tag} onChange={(e) => setTag(e.target.value)} placeholder="e.g. saas-founders-oct" /></Field>
    </Dialog>
  );
}

export function VerifyAllButton() {
  return (
    <ActionButton action={() => verifyLeads()} title="Checks syntax, that the domain accepts email, and flags disposable/role addresses. Up to 300 at a time.">
      <ShieldCheck size={15} />Verify new
    </ActionButton>
  );
}

export function ImportButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}><Upload size={15} />Import CSV</Button>
      {open && <ImportDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [fileName, setFileName] = useState("");
  const [mapping, setMapping] = useState<Record<string, string>>({}); // csv header -> field key | "custom" | ""
  const [tags, setTags] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);

  const parse = (file: File) => {
    setFileName(file.name);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: "greedy",
      transformHeader: (h) => h.trim(),
      complete: (res) => {
        const hs = (res.meta.fields ?? []).filter(Boolean);
        setHeaders(hs);
        setRows(res.data);
        const used = new Set<string>();
        const m: Record<string, string> = {};
        for (const h of hs) {
          const f = FIELDS.find((f) => !used.has(f.key) && f.guess.test(h));
          if (f) { m[h] = f.key; used.add(f.key); } else m[h] = "custom";
        }
        // Fall back to the first column containing an @ for email.
        if (!used.has("email")) {
          const h = hs.find((h) => res.data.slice(0, 20).some((r) => String(r[h] ?? "").includes("@")));
          if (h) m[h] = "email";
        }
        setMapping(m);
        if (!tags) setTags(file.name.replace(/\.csv$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40));
      },
      error: (err) => toast.error(err.message),
    });
  };

  const emailHeader = Object.entries(mapping).find(([, v]) => v === "email")?.[0];
  const customKeys = useMemo(() => headers.filter((h) => mapping[h] === "custom").map((h) => h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")), [headers, mapping]);

  const submit = async () => {
    if (!emailHeader) return toast.error("Map one column to Email");
    const mapped = rows.map((r) => {
      const out: Record<string, string> = {};
      for (const f of FIELDS) {
        const h = headers.find((h) => mapping[h] === f.key);
        if (h) out[f.key] = String(r[h] ?? "");
      }
      headers.forEach((h) => {
        if (mapping[h] === "custom") out[h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")] = String(r[h] ?? "");
      });
      return out;
    });
    const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);
    const totals = { inserted: 0, updated: 0, invalid: 0, suppressed: 0 };
    const CHUNK = 1000;
    setProgress(0);
    try {
      for (let i = 0; i < mapped.length; i += CHUNK) {
        const r = await importLeads(mapped.slice(i, i + CHUNK), tagList, customKeys);
        if (!r.ok) throw new Error(r.error);
        totals.inserted += r.inserted; totals.updated += r.updated; totals.invalid += r.invalid; totals.suppressed += r.suppressed;
        setProgress(Math.min(100, Math.round(((i + CHUNK) / mapped.length) * 100)));
      }
      toast.success(`Imported ${totals.inserted} new, updated ${totals.updated}` + (totals.invalid ? `, skipped ${totals.invalid} invalid` : "") + (totals.suppressed ? `, ${totals.suppressed} on block list` : ""));
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
      setProgress(null);
    }
  };

  return (
    <Dialog open wide onClose={onClose} title="Import leads" description="Duplicates are merged by email. Unsubscribed and bounced people stay blocked."
      footer={rows.length > 0 && (
        <Button variant="primary" onClick={submit} disabled={progress !== null || !emailHeader}>
          {progress !== null ? <><Spinner />Importing {progress}%</> : <>Import {rows.length.toLocaleString()} rows</>}
        </Button>
      )}>
      {!rows.length ? (
        <label
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) parse(f); }}
          className={cx("flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed py-14 cursor-pointer transition-colors",
            drag ? "border-accent bg-accent-soft" : "border-line hover:bg-panel-2")}>
          <FileUp size={26} className="text-faint" />
          <div className="font-medium">Drop a CSV here or click to choose</div>
          <div className="text-[12.5px] text-muted">Exports from Apollo, LinkedIn Sales Navigator, Google Sheets, Excel all work</div>
          <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) parse(f); }} />
        </label>
      ) : (
        <div className="grid gap-4">
          <div className="text-[13px] text-muted"><span className="text-ink font-medium">{fileName}</span> · {rows.length.toLocaleString()} rows · {headers.length} columns</div>
          <div className="rounded-lg border border-line divide-y divide-line">
            {headers.map((h) => (
              <div key={h} className="grid grid-cols-[1fr_180px] sm:grid-cols-[1fr_1fr_180px] items-center gap-3 px-3 py-2">
                <div className="font-medium text-[13px] truncate">{h}</div>
                <div className="hidden sm:block text-[12.5px] text-muted truncate">{rows.slice(0, 3).map((r) => r[h]).filter(Boolean).join(" · ") || "—"}</div>
                <Select value={mapping[h] ?? ""} onChange={(e) => setMapping((m) => {
                  const v = e.target.value;
                  const next = { ...m };
                  // A standard field can only be mapped once.
                  if (v !== "custom" && v !== "") for (const k of Object.keys(next)) if (next[k] === v) next[k] = "custom";
                  next[h] = v;
                  return next;
                })} className="h-8 text-[13px]">
                  {FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                  <option value="custom">Custom variable</option>
                  <option value="">Don&apos;t import</option>
                </Select>
              </div>
            ))}
          </div>
          {customKeys.length > 0 && (
            <p className="text-[12.5px] text-muted">Custom columns become variables: {customKeys.map((k) => <code key={k} className="mx-0.5 px-1 rounded bg-panel-2 text-ink">{`{{${k}}}`}</code>)}</p>
          )}
          <Field label="Tags" hint="Comma-separated. Use a tag to add this batch to a campaign.">
            <Input value={tags} onChange={(e) => setTags(e.target.value)} />
          </Field>
        </div>
      )}
    </Dialog>
  );
}
