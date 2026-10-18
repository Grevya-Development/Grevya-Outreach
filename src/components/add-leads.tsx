"use client";

import { CheckCircle2, ChevronDown, ClipboardList, FileUp, Plus, Search, Upload, UserPlus } from "lucide-react";
import Link from "next/link";
import Papa from "papaparse";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { addLeadsManually, importLeads, type AddSummary } from "@/app/actions/leads";
import { fmtNum } from "@/lib/format";
import { parseLeads } from "@/lib/parse-leads";
import { Dialog, Menu, Spinner, useConfirm } from "./client";
import { Button, ButtonLink, Field, Input, Select, Textarea, cx } from "./ui";

export type AddLeadsTab = "csv" | "paste" | "one";
export type CampaignOption = { id: string; name: string; status?: string };
export type LeadPrefill = { email?: string; first_name?: string; last_name?: string; website?: string; company?: string };

type Props = {
  campaigns?: CampaignOption[];
  /** Fixed target (opened from a campaign): the picker is replaced by "Adding to {campaignName}". */
  campaignId?: string;
  campaignName?: string;
  campaignStatus?: string;
  /** Preselected (but changeable) campaign in the picker, e.g. /leads/find?campaign=… */
  defaultCampaignId?: string;
  label?: string;
  variant?: "primary" | "secondary";
  defaultTab?: AddLeadsTab;
  defaultOpen?: boolean;
  /** Primary "Add leads" plus a ▾ menu (Upload CSV / Paste a list / Add one lead / Find email). */
  split?: boolean;
  prefill?: LeadPrefill;
};

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

const TABS: [AddLeadsTab, string, typeof Upload][] = [["csv", "Upload CSV", Upload], ["paste", "Paste a list", ClipboardList], ["one", "One lead", UserPlus]];

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
const varKey = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/** Drops `?add=` from the URL once the dialog it opened is closed (so a refresh doesn't reopen it). */
function clearAddParam() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("add")) return;
    url.searchParams.delete("add");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  } catch { /* cosmetic only */ }
}

export function AddLeadsButton(props: Props) {
  const { label = "Add leads", variant, split, defaultTab, defaultOpen } = props;
  const [open, setOpen] = useState<AddLeadsTab | null>(defaultOpen ? defaultTab ?? "csv" : null);
  const close = () => { setOpen(null); clearAddParam(); };
  const v = variant ?? (split ? "primary" : "secondary");

  return (
    <>
      {split ? (
        <div className="inline-flex">
          <Button variant={v} className="rounded-r-none" onClick={() => setOpen("csv")}><Plus size={15} />{label}</Button>
          <Menu align="end"
            trigger={<Button variant={v} className={cx("rounded-l-none w-8 px-0", v === "primary" ? "border-l border-accent-ink/25" : "border-l-0")} aria-label="More ways to add leads"><ChevronDown size={15} /></Button>}
            items={[
              { label: "Upload CSV", icon: <Upload />, onSelect: () => setOpen("csv") },
              { label: "Paste a list", icon: <ClipboardList />, onSelect: () => setOpen("paste") },
              { label: "Add one lead", icon: <UserPlus />, onSelect: () => setOpen("one") },
              { label: "Find email", icon: <Search />, href: "/leads/find" },
            ]} />
        </div>
      ) : (
        <Button variant={v} onClick={() => setOpen(defaultTab ?? "csv")}><UserPlus size={15} />{label}</Button>
      )}
      {open && <AddLeadsDialog {...props} defaultTab={open} onClose={close} />}
    </>
  );
}

type Done = Omit<AddSummary, "ok" | "message"> & { tag: string; campaign: CampaignOption | null };

export function AddLeadsDialog({
  campaigns = [], campaignId, campaignName, campaignStatus, defaultCampaignId, defaultTab = "csv", prefill, onClose,
}: Props & { onClose: () => void }) {
  const router = useRouter();
  const { confirm, element: confirmElement } = useConfirm();
  const [tab, setTab] = useState<AddLeadsTab>(defaultTab);
  const [done, setDone] = useState<Done | null>(null);
  const [busy, setBusy] = useState<number | "busy" | null>(null); // CSV: percent done
  const [listName, setListName] = useState<string | null>(null); // null = not edited: use the tab's default
  const [target, setTarget] = useState(campaignId ?? (defaultCampaignId && campaigns.some((c) => c.id === defaultCampaignId) ? defaultCampaignId : ""));

  // CSV
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [fileName, setFileName] = useState("");
  const [mapping, setMapping] = useState<Record<string, string>>({}); // csv header -> field key | "custom" | ""
  const [drag, setDrag] = useState(false);
  // Paste / one
  const [paste, setPaste] = useState("");
  const [one, setOne] = useState({
    email: prefill?.email ?? "", first_name: prefill?.first_name ?? "", last_name: prefill?.last_name ?? "",
    company: prefill?.company ?? "", title: "", website: prefill?.website ?? "", notes: "",
  });
  const parsed = useMemo(() => parseLeads(paste), [paste]);
  const setField = (k: keyof typeof one, v: string) => setOne((p) => ({ ...p, [k]: v }));

  const fixed: CampaignOption | null = campaignId ? { id: campaignId, name: campaignName ?? "this campaign", status: campaignStatus } : null;
  const targetCampaign = fixed ?? campaigns.find((c) => c.id === target) ?? null;
  const list = listName ?? (tab === "csv" && fileName ? slug(fileName.replace(/\.csv$/i, "")) || "import" : "manual");

  const parse = (file: File) => {
    setFileName(file.name);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: "greedy",
      transformHeader: (h) => h.trim(),
      complete: (res) => {
        const hs = (res.meta.fields ?? []).filter(Boolean);
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
        setHeaders(hs);
        setRows(res.data);
        setMapping(m);
      },
      error: (err) => toast.error(err.message),
    });
  };

  const emailHeader = Object.entries(mapping).find(([, v]) => v === "email")?.[0];
  const customKeys = useMemo(() => headers.filter((h) => mapping[h] === "custom").map(varKey), [headers, mapping]);
  const manual = tab === "one" ? (one.email.includes("@") ? [one] : []) : tab === "paste" ? parsed.leads : [];
  const count = tab === "csv" ? rows.length : manual.length;

  /** A finished campaign that gets new leads either restarts or waits, paused, for the user. */
  const askRestart = async (): Promise<boolean> => {
    if (targetCampaign?.status !== "completed") return false;
    return confirm({
      title: `${targetCampaign.name} had finished. Restart it for these leads?`,
      body: "Restart it to start emailing them now. Cancel still adds them, and the campaign waits, paused, until you resume it.",
      confirmLabel: "Restart it",
    });
  };

  const submit = async () => {
    if (!count) return;
    if (tab === "csv" && !emailHeader) return toast.error("Match one column to Email");
    const restart = await askRestart();
    const campaign = targetCampaign;
    const tags = list.split(",").map((t) => t.trim()).filter(Boolean);
    const totals = { inserted: 0, updated: 0, invalid: 0, suppressed: 0, enrolled: 0 };
    const add = (r: AddSummary) => {
      totals.inserted += r.inserted; totals.updated += r.updated; totals.invalid += r.invalid;
      totals.suppressed += r.suppressed; totals.enrolled += r.enrolled;
    };
    try {
      if (tab === "csv") {
        const mapped = rows.map((r) => {
          const out: Record<string, string> = {};
          for (const f of FIELDS) {
            const h = headers.find((h) => mapping[h] === f.key);
            if (h) out[f.key] = String(r[h] ?? "");
          }
          for (const h of headers) if (mapping[h] === "custom") out[varKey(h)] = String(r[h] ?? "");
          return out;
        });
        const CHUNK = 1000;
        setBusy(0);
        for (let i = 0; i < mapped.length; i += CHUNK) {
          const r = await importLeads(mapped.slice(i, i + CHUNK), tags, customKeys, { campaignId: campaign?.id ?? null, restart });
          if (!r.ok) throw new Error(r.error);
          add(r);
          setBusy(Math.min(100, Math.round(((i + CHUNK) / mapped.length) * 100)));
        }
        router.refresh(); // importLeads doesn't refresh per chunk
      } else {
        setBusy("busy");
        const r = await addLeadsManually({ leads: manual, tags, campaignId: campaign?.id ?? null, restart });
        if (!r.ok) throw new Error(r.error);
        add(r);
      }
      setDone({ ...totals, tag: tags[0] ?? "", campaign: campaign ? { ...campaign, status: campaign.status === "completed" ? (restart ? "active" : "paused") : campaign.status } : null });
    } catch (err) {
      toast.error((err as Error).message || "Something went wrong");
      if (totals.inserted || totals.updated) router.refresh(); // earlier chunks did go in
    } finally {
      setBusy(null);
    }
  };

  const submitLabel = tab === "csv" ? `Import ${fmtNum(count)} lead${count === 1 ? "" : "s"}` : tab === "paste" ? `Add ${fmtNum(count)} lead${count === 1 ? "" : "s"}` : "Add lead";
  const where = (
    <section className="grid gap-3 border-t border-line pt-4">
      <div className="text-[13px] font-semibold">Where to put them</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="List name" hint="Group them so you can add the whole list to a campaign later.">
          <Input value={list} onChange={(e) => setListName(e.target.value)} />
        </Field>
        {fixed ? (
          <Field label="Add to campaign">
            <div className="h-9 flex items-center text-[13.5px] text-muted truncate">Adding to <b className="ml-1 text-ink font-medium truncate">{fixed.name}</b></div>
          </Field>
        ) : (
          <Field label="Add to campaign" hint="Optional. You can also do this later.">
            <Select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">None</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.status === "draft" ? " (not launched)" : c.status === "completed" ? " (finished)" : ""}</option>
              ))}
            </Select>
          </Field>
        )}
      </div>
    </section>
  );

  // The Done screen replaces the form inside the same dialog. The confirm is rendered next to the
  // dialog, not inside it: a nested <dialog>'s close event would also close this one.
  const summary = done && doneView(done, onClose);
  return (
    <>
    <Dialog open wide onClose={onClose} title={done ? "Leads added" : "Add leads"}
      description={done ? undefined : "Duplicates are merged by email. People on your block list are never emailed."}
      footer={summary ? summary.footer : (tab !== "csv" || rows.length > 0) && (
        <Button variant="primary" onClick={submit} disabled={busy !== null || !count || (tab === "csv" && !emailHeader)}>
          {busy !== null ? <><Spinner />{typeof busy === "number" ? `Importing ${busy}%` : "Adding…"}</> : submitLabel}
        </Button>
      )}>
      {summary ? summary.body : <div className="grid gap-4">
        <div role="tablist" aria-label="How to add leads" className="inline-flex flex-wrap rounded-lg border border-line p-0.5 justify-self-start max-w-full">
          {TABS.map(([k, l, Icon]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} disabled={busy !== null} onClick={() => setTab(k)}
              className={cx("h-8 px-3 rounded-md text-[13px] inline-flex items-center gap-1.5 transition-colors", tab === k ? "bg-accent-soft text-accent font-medium" : "text-muted hover:text-ink")}>
              <Icon size={14} />{l}
            </button>
          ))}
        </div>

        {tab === "csv" && (!rows.length ? (
          <label
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) parse(f); }}
            className={cx("flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed py-14 px-4 text-center cursor-pointer transition-colors",
              drag ? "border-accent bg-accent-soft" : "border-line hover:bg-panel-2")}>
            <FileUp size={26} className="text-faint" />
            <div className="font-medium">Drop a CSV here or click to choose</div>
            <div className="text-[12.5px] text-muted">Exports from Apollo, Sales Navigator, Google Sheets or Excel all work. An email column is enough.</div>
            <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) parse(f); }} />
          </label>
        ) : (
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
              <span><span className="text-ink font-medium">{fileName}</span> · {fmtNum(rows.length)} rows · {headers.length} columns</span>
              <button type="button" className="text-accent hover:underline" disabled={busy !== null}
                onClick={() => { setRows([]); setHeaders([]); setMapping({}); setFileName(""); }}>Choose another file</button>
            </div>
            <div className="text-[13px] font-semibold">Match columns</div>
            <div className="rounded-lg border border-line divide-y divide-line">
              {headers.map((h) => (
                <div key={h} className="grid grid-cols-[minmax(0,1fr)_150px] sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_180px] items-center gap-3 px-3 py-2">
                  <div className="font-medium text-[13px] truncate">{h}</div>
                  <div className="hidden sm:block text-[12.5px] text-muted truncate">{rows.slice(0, 3).map((r) => r[h]).filter(Boolean).join(" · ") || "—"}</div>
                  <Select value={mapping[h] ?? ""} aria-label={`Use column ${h} as`} onChange={(e) => setMapping((m) => {
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
            {!emailHeader && <p className="text-[12.5px] text-bad">Match one column to Email to continue.</p>}
            {customKeys.length > 0 && (
              <p className="text-[12.5px] text-muted">Custom columns become variables: {customKeys.map((k) => <code key={k} className="mx-0.5 px-1 rounded bg-panel-2 text-ink">{`{{${k}}}`}</code>)}</p>
            )}
            {where}
          </div>
        ))}

        {tab === "paste" && (
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Textarea rows={8} value={paste} onChange={(e) => setPaste(e.target.value)} className="font-mono text-[12.5px]" aria-label="Leads to add"
                placeholder={"priya@acme.com\nRahul Mehta <rahul@delhivery.com>\nAnita Rao, anita@tvsmotor.com, TVS Motor, Head of IT"} />
              <p className="text-[12px] text-muted">
                One lead per line. Works with plain emails, <code>Name &lt;email&gt;</code>, or <code>Name, email, Company, Title</code> (also pasted spreadsheet rows).
                {paste.trim() && <> Found <b className="text-ink">{fmtNum(parsed.leads.length)}</b> email{parsed.leads.length === 1 ? "" : "s"}{parsed.invalid.length ? `, ${parsed.invalid.length} line${parsed.invalid.length === 1 ? "" : "s"} without an email skipped` : ""}.</>}
              </p>
              {parsed.leads.length > 0 && (
                <div className="rounded-lg border border-line max-h-40 overflow-y-auto divide-y divide-line text-[12.5px]">
                  {parsed.leads.slice(0, 50).map((l) => (
                    <div key={l.email} className="flex gap-3 px-3 py-1.5 min-w-0">
                      <span className="font-medium truncate flex-1">{l.email}</span>
                      <span className="text-muted truncate">{[l.first_name, l.last_name].filter(Boolean).join(" ")}</span>
                      <span className="text-faint truncate hidden sm:inline">{l.company}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {where}
          </div>
        )}

        {tab === "one" && (
          <div className="grid gap-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Email *" className="sm:col-span-2">
                <Input type="email" value={one.email} autoFocus data-autofocus="" placeholder="priya@acme.com" onChange={(e) => setField("email", e.target.value)} />
              </Field>
              <Field label="First name"><Input value={one.first_name} onChange={(e) => setField("first_name", e.target.value)} /></Field>
              <Field label="Last name"><Input value={one.last_name} onChange={(e) => setField("last_name", e.target.value)} /></Field>
              <Field label="Company"><Input value={one.company} onChange={(e) => setField("company", e.target.value)} /></Field>
              <Field label="Job title"><Input value={one.title} onChange={(e) => setField("title", e.target.value)} /></Field>
              <Field label="Website" hint="The AI reads this site to personalise emails" className="sm:col-span-2">
                <Input value={one.website} placeholder="acme.com" onChange={(e) => setField("website", e.target.value)} />
              </Field>
              <Field label="Notes" hint="Anything the AI should know: where you met, what they posted, mutual contacts…" className="sm:col-span-2">
                <Textarea rows={2} value={one.notes} onChange={(e) => setField("notes", e.target.value)} />
              </Field>
            </div>
            {where}
          </div>
        )}
      </div>}
    </Dialog>
    {confirmElement}
    </>
  );
}

function doneView(done: Done, onClose: () => void) {
  const c = done.campaign;
  const parts = [
    `${fmtNum(done.inserted)} new`,
    `${fmtNum(done.updated)} updated`,
    done.invalid ? `${fmtNum(done.invalid)} invalid skipped` : "",
    done.suppressed ? `${fmtNum(done.suppressed)} on block list` : "",
    c ? `${fmtNum(done.enrolled)} added to ${c.name}` : "",
  ].filter(Boolean);
  const listHref = `/leads?tag=${encodeURIComponent(done.tag)}`;
  return {
    footer: <>
        <Button onClick={onClose}>Close</Button>
        {done.tag && <ButtonLink href={listHref} onClick={onClose}>View list</ButtonLink>}
        {c ? (
          <ButtonLink variant="primary" href={c.status === "draft" ? `/campaigns/${c.id}?step=leads` : `/campaigns/${c.id}?tab=leads`} onClick={onClose}>Open campaign</ButtonLink>
        ) : done.tag ? (
          <ButtonLink variant="primary" href={`/campaigns?new=1&list=${encodeURIComponent(done.tag)}`} onClick={onClose}>Create a campaign for this list</ButtonLink>
        ) : null}
      </>,
    body: (
      <div className="flex items-start gap-3 fade-in">
        <CheckCircle2 size={22} className="text-good shrink-0 mt-0.5" />
        <div className="grid gap-1 min-w-0">
          <p className="text-[14px] font-medium tabular-nums">{parts.join(" · ")}</p>
          <p className="text-[13px] text-muted">
            Emails are checked in the background.
            {done.tag && <> They&apos;re in the list <Link href={listHref} onClick={onClose} className="text-accent hover:underline">{done.tag}</Link>.</>}
            {c && done.enrolled < done.inserted + done.updated && " Leads already in the campaign, blocked or invalid were skipped."}
          </p>
        </div>
      </div>
    ),
  };
}
