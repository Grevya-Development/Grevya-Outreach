"use client";

import { CheckCircle2, Copy, Download, MailCheck, Search, ShieldAlert, ShieldCheck, UserPlus, UserSearch } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { findOne, saveToLeads, verifyBatch, type VerifierCapabilities } from "@/app/actions/verifier";
import { Spinner, useAction } from "@/components/client";
import { Badge, Button, Card, CardHeader, Empty, Field, Input, Select, Td, Textarea, Th, cx } from "@/components/ui";
import type { FindResult } from "@/lib/email-finder";
import type { VerifyResult } from "@/lib/email-verify";

type Tab = "verify" | "find";
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

const STATUS: Record<string, { label: string; tone: "good" | "bad" | "warn" | "neutral" }> = {
  valid: { label: "Valid", tone: "good" },
  invalid: { label: "Invalid", tone: "bad" },
  risky: { label: "Risky", tone: "warn" },
  unknown: { label: "Unconfirmed", tone: "neutral" },
};

export function VerifierView({ capabilities: cap, campaigns }: { capabilities: VerifierCapabilities; campaigns: { id: string; name: string }[] }) {
  const [tab, setTab] = useState<Tab>("verify");
  return (
    <div className="grid gap-4">
      <Card className="px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
        <span className="flex items-center gap-1.5">
          {cap.smtp ? <ShieldCheck size={15} className="text-good" /> : <ShieldAlert size={15} className="text-warn" />}
          <b>Mailbox check:</b>
          <span className="text-muted">{cap.smtp ? "on — we ask each company's mail server whether the mailbox exists (nothing is sent)" : "off — outgoing port 25 is blocked on this network, so we check the domain only"}</span>
        </span>
      </Card>

      <div className="flex gap-1 border-b border-line">
        {([["verify", "Verify emails", MailCheck], ["find", "Find someone's email", UserSearch]] as const).map(([k, l, Icon]) => (
          <button key={k} onClick={() => setTab(k)} className={cx("relative h-9 px-3 text-[13.5px] inline-flex items-center gap-1.5 transition-colors", tab === k ? "text-ink font-medium" : "text-muted hover:text-ink")}>
            <Icon size={15} />{l}
            {tab === k && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
          </button>
        ))}
      </div>

      <div className={tab === "verify" ? "" : "hidden"}><VerifyTab campaigns={campaigns} /></div>
      <div className={tab === "find" ? "" : "hidden"}><FindTab campaigns={campaigns} /></div>
    </div>
  );
}

/* ───────────── Verify ───────────── */

function VerifyTab({ campaigns }: { campaigns: { id: string; name: string }[] }) {
  const [text, setText] = useState("");
  const [results, setResults] = useState<VerifyResult[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [filter, setFilter] = useState<string>("");
  const emails = useMemo(() => [...new Set((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()))], [text]);
  const shown = filter ? results.filter((r) => r.status === filter) : results;
  const counts = results.reduce<Record<string, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});

  const run = async () => {
    if (!emails.length) return;
    setResults([]);
    setFilter("");
    setProgress({ done: 0, total: emails.length });
    try {
      for (let i = 0; i < emails.length; i += 25) {
        const batch = await verifyBatch(emails.slice(i, i + 25));
        setResults((r) => [...r, ...batch]);
        setProgress({ done: Math.min(emails.length, i + 25), total: emails.length });
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setProgress(null);
    }
  };

  const csv = () => {
    const rows = [["email", "status", "score", "reason", "suggestion", "provider"], ...results.map((r) => [r.email, r.status, String(r.score), r.reason, r.suggestion ?? "", r.provider ?? ""])];
    const blob = new Blob([rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "verified-emails.csv";
    a.click();
  };

  return (
    <div className="grid gap-4">
      <Card className="p-4 grid gap-3">
        <Field label="Emails to check" hint="Paste anything — one per line, comma-separated, or a whole block of text. Up to 1,000 at a time.">
          <Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-[12.5px]"
            placeholder={"priya@acme.com\nrahul.mehta@delhivery.com, info@tvsmotor.com\nsomeone@gmial.com"} />
        </Field>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-[12.5px] text-muted">{emails.length ? `${emails.length} unique address${emails.length === 1 ? "" : "es"} found` : "No addresses yet"}</span>
          <Button variant="primary" onClick={run} disabled={!emails.length || Boolean(progress) || emails.length > 1000}>
            {progress ? <><Spinner />Checking {progress.done}/{progress.total}…</> : <><MailCheck size={15} />Verify {emails.length || ""}</>}
          </Button>
        </div>
        {progress && <div className="h-1.5 rounded-full bg-panel-2 overflow-hidden"><div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>}
      </Card>

      {results.length > 0 && (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 border-b border-line">
            <Chip active={!filter} onClick={() => setFilter("")}>All {results.length}</Chip>
            {(["valid", "risky", "unknown", "invalid"] as const).map((s) => counts[s] ? <Chip key={s} active={filter === s} onClick={() => setFilter(s)}>{STATUS[s].label} {counts[s]}</Chip> : null)}
            <span className="ml-auto flex flex-wrap gap-2">
              <Button size="sm" onClick={() => { navigator.clipboard.writeText(results.filter((r) => r.status === "valid").map((r) => r.email).join("\n")); toast.success("Valid addresses copied"); }}><Copy size={14} />Copy valid</Button>
              <Button size="sm" onClick={csv}><Download size={14} />CSV</Button>
              <SaveButton campaigns={campaigns} rows={results.filter((r) => r.status === "valid" || r.status === "risky" || r.status === "unknown").map((r) => ({ email: r.email, status: r.status }))} label="Save non-invalid to Leads" />
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="bg-panel-2/50"><tr><Th>Email</Th><Th>Result</Th><Th>Why</Th><Th>Provider</Th></tr></thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.email} className="hover:bg-panel-2/60">
                    <Td className="font-medium max-w-[260px] truncate">{r.email}</Td>
                    <Td className="whitespace-nowrap">
                      <Badge tone={STATUS[r.status].tone} dot>{STATUS[r.status].label}</Badge>
                      <span className="ml-1.5 text-[11.5px] text-faint tabular-nums">{r.score}</span>
                    </Td>
                    <Td className="text-muted">
                      {r.reason}
                      {r.suggestion && <button className="block text-accent text-[12px] hover:underline" onClick={() => setText((t) => t.replace(r.email, r.suggestion!))}>Did you mean {r.suggestion}? (fix in list)</button>}
                      <span className="flex flex-wrap gap-1 mt-1">
                        {r.checks.role && <Badge>shared address (info@, sales@…)</Badge>}
                        {r.source === "history" && <Badge tone="good">from your own data</Badge>}
                        {r.checks.freeMail && <Badge>personal email</Badge>}
                        {r.checks.acceptAll && <Badge tone="warn">accept-all domain</Badge>}
                        {r.source === "cache" && <Badge>checked earlier</Badge>}
                      </span>
                    </Td>
                    <Td className="text-muted text-[12.5px] max-w-[200px] truncate">{r.provider ?? "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {!results.length && !progress && (
        <Card className="p-4 text-[13px] text-muted grid gap-1.5">
          <div className="font-medium text-ink">What the results mean</div>
          <div><Badge tone="good" dot>Valid</Badge> the mailbox exists — safe to email.</div>
          <div><Badge tone="warn" dot>Risky</Badge> accept-all domain, shared address (info@), or a likely typo — send carefully.</div>
          <div><Badge dot>Unconfirmed</Badge> the domain accepts email but the server wouldn&apos;t confirm the mailbox (common with big providers).</div>
          <div><Badge tone="bad" dot>Invalid</Badge> doesn&apos;t exist, no mail server, or a disposable address — don&apos;t send; it would hurt your sender reputation.</div>
        </Card>
      )}
    </div>
  );
}

/* ───────────── Find ───────────── */

type FindRow = { first: string; last: string; domain: string; result?: FindResult | { ok: false; error: string } };

function FindTab({ campaigns }: { campaigns: { id: string; name: string }[] }) {
  const [f, setF] = useState({ first: "", last: "", domain: "" });
  const [result, setResult] = useState<FindResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [bulk, setBulk] = useState("");
  const [rows, setRows] = useState<FindRow[]>([]);
  const [bulkProgress, setBulkProgress] = useState<number | null>(null);

  const one = async () => {
    setLoading(true);
    setResult(null);
    try {
      const r = await findOne(f);
      if (!r.ok) toast.error(r.error);
      else setResult(r);
    } finally {
      setLoading(false);
    }
  };

  const parsedBulk = useMemo<FindRow[]>(() => bulk.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const cells = l.split(/[,\t;]/).map((c) => c.trim()).filter(Boolean);
    const domainCell = cells.find((c) => /\.[a-z]{2,}/i.test(c) && !/\s/.test(c)) ?? "";
    const nameCells = cells.filter((c) => c !== domainCell);
    const names = nameCells.length >= 2 ? [nameCells[0], nameCells[1]] : (nameCells[0] ?? "").split(/\s+/);
    return { first: names[0] ?? "", last: names.slice(1).join(" "), domain: domainCell };
  }).filter((r) => r.first && r.domain).slice(0, 100), [bulk]);

  const runBulk = async () => {
    setRows(parsedBulk.map((r) => ({ ...r })));
    for (let i = 0; i < parsedBulk.length; i++) {
      setBulkProgress(i);
      const r = await findOne(parsedBulk[i]).catch((e) => ({ ok: false as const, error: (e as Error).message }));
      setRows((prev) => prev.map((row, j) => (j === i ? { ...row, result: r } : row)));
    }
    setBulkProgress(null);
  };

  const found = rows.filter((r) => r.result?.ok && r.result.best);
  return (
    <div className="grid gap-4">
      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4 items-start">
        <Card className="p-4 grid gap-3">
          <div className="font-semibold text-[14px]">One person</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="First name"><Input value={f.first} placeholder="Priya" onChange={(e) => setF({ ...f, first: e.target.value })} /></Field>
            <Field label="Last name"><Input value={f.last} placeholder="Sharma" onChange={(e) => setF({ ...f, last: e.target.value })} /></Field>
            <Field label="Company website or domain" className="sm:col-span-2"><Input value={f.domain} placeholder="acme.com" onChange={(e) => setF({ ...f, domain: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && f.first && f.domain && one()} /></Field>
          </div>
          <Button variant="primary" className="justify-self-start" onClick={one} disabled={loading || !f.first || !f.domain}>
            {loading ? <><Spinner />Searching… (up to 30s)</> : <><Search size={15} />Find email</>}
          </Button>
        </Card>

        {result ? <FindCard r={result} first={f.first} last={f.last} campaigns={campaigns} /> : (
          <Card className="p-4 text-[13px] text-muted grid gap-1.5">
            <div className="font-medium text-ink">How it finds the address</div>
            <div>1. Builds the common formats (priya.sharma@, priya@, psharma@ …).</div>
            <div>2. Learns the company&apos;s format from leads you already have there and from addresses on its website.</div>
            <div>3. Asks the company&apos;s mail server which one exists (nothing is sent){" "}and spots &ldquo;accept-all&rdquo; domains where no address can be confirmed.</div>
          </Card>
        )}
      </div>

      <Card className="p-4 grid gap-3">
        <div className="font-semibold text-[14px]">A list of people</div>
        <Textarea rows={5} value={bulk} onChange={(e) => setBulk(e.target.value)} className="font-mono text-[12.5px]"
          placeholder={"Priya Sharma, acme.com\nRahul Mehta, delhivery.com\nAnita, Rao, tvsmotor.com"} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-[12.5px] text-muted">One person per line: name and company domain. {parsedBulk.length ? `${parsedBulk.length} ready.` : ""} Up to 100.</span>
          <Button variant="primary" onClick={runBulk} disabled={!parsedBulk.length || bulkProgress !== null}>
            {bulkProgress !== null ? <><Spinner />Finding {bulkProgress + 1}/{parsedBulk.length}…</> : <><UserSearch size={15} />Find all</>}
          </Button>
        </div>
        {rows.length > 0 && (
          <>
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-[13px]">
                <thead className="bg-panel-2/50"><tr><Th>Person</Th><Th>Domain</Th><Th>Best email</Th><Th>Confidence</Th></tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <Td className="whitespace-nowrap">{r.first} {r.last}</Td>
                      <Td className="text-muted">{r.domain}</Td>
                      <Td className="font-medium">
                        {!r.result ? <span className="text-faint">{bulkProgress === i ? "searching…" : "waiting"}</span>
                          : !r.result.ok ? <span className="text-bad text-[12.5px]">{r.result.error}</span>
                          : r.result.best?.email ?? "—"}
                      </Td>
                      <Td>{r.result?.ok && r.result.best ? <Confidence c={r.result.best.confidence} confirmed={r.result.best.mailbox === "exists"} acceptAll={r.result.acceptAll} /> : null}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {found.length > 0 && bulkProgress === null && (
              <div className="flex justify-end">
                <SaveButton campaigns={campaigns} label={`Save ${found.length} to Leads`}
                  rows={found.map((r) => {
                    const res = r.result as FindResult;
                    return { email: res.best!.email, first_name: r.first, last_name: r.last, website: res.domain, status: res.best!.mailbox === "exists" ? "valid" : "unknown" };
                  })} />
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

function Confidence({ c, confirmed, acceptAll }: { c: number; confirmed: boolean; acceptAll: boolean | null }) {
  const tone = confirmed ? "good" : c >= 50 ? "warn" : "neutral";
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone={tone} dot>{confirmed ? "Confirmed" : acceptAll ? "Best guess (accept-all)" : "Best guess"}</Badge>
      <span className="text-[11.5px] text-faint tabular-nums">{c}%</span>
    </span>
  );
}

function FindCard({ r, first, last, campaigns }: { r: FindResult; first: string; last: string; campaigns: { id: string; name: string }[] }) {
  const best = r.best;
  return (
    <Card className="fade-in">
      <CardHeader title={`${first} ${last}`.trim() || r.name} description={`${r.domain}${r.provider ? ` · ${r.provider}` : ""}`} />
      <div className="px-4 pb-4 grid gap-3">
        {best ? (
          <div className={cx("rounded-xl border p-3.5", best.mailbox === "exists" ? "border-good/30 bg-good-soft" : "border-line bg-panel-2/50")}>
            <div className="flex flex-wrap items-center gap-2">
              {best.mailbox === "exists" && <CheckCircle2 size={17} className="text-good" />}
              <span className="text-[16px] font-semibold break-all">{best.email}</span>
              <button className="text-muted hover:text-ink" aria-label="Copy" onClick={() => { navigator.clipboard.writeText(best.email); toast.success("Copied"); }}><Copy size={14} /></button>
            </div>
            <div className="mt-1.5"><Confidence c={best.confidence} confirmed={best.mailbox === "exists"} acceptAll={r.acceptAll} /></div>
            {best.evidence.length > 0 && <ul className="mt-2 text-[12.5px] text-muted list-disc pl-4 grid gap-0.5">{best.evidence.map((e) => <li key={e}>{e}</li>)}</ul>}
          </div>
        ) : <Empty title="No likely address found" />}
        {r.notes.map((n) => <p key={n} className="text-[12.5px] text-muted">{n}</p>)}
        {r.candidates.length > 1 && (
          <details className="text-[12.5px]">
            <summary className="cursor-pointer select-none text-muted">Other possibilities</summary>
            <div className="mt-2 grid gap-1">
              {r.candidates.slice(1).map((c) => (
                <div key={c.email} className="flex items-center justify-between gap-3">
                  <span className="truncate">{c.email}</span>
                  <span className="text-faint tabular-nums shrink-0">{c.mailbox === "exists" ? "confirmed" : `${c.confidence}%`}</span>
                </div>
              ))}
            </div>
          </details>
        )}
        {best && (
          <SaveButton campaigns={campaigns} label="Save to Leads"
            rows={[{ email: best.email, first_name: first, last_name: last, website: r.domain, status: best.mailbox === "exists" ? "valid" : "unknown" }]} />
        )}
      </div>
    </Card>
  );
}

function SaveButton({ rows, campaigns, label }: { rows: { email: string; first_name?: string; last_name?: string; website?: string; status: string }[]; campaigns: { id: string; name: string }[]; label: string }) {
  const [open, setOpen] = useState(false);
  const [tags, setTags] = useState("verified");
  const [campaign, setCampaign] = useState("");
  const [pending, run] = useAction();
  if (!open) return <Button size="sm" variant="primary" className="justify-self-start" disabled={!rows.length} onClick={() => setOpen(true)}><UserPlus size={14} />{label}</Button>;
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-line p-2.5 fade-in">
      <Field label="Tags" className="w-36"><Input value={tags} onChange={(e) => setTags(e.target.value)} className="h-8" /></Field>
      <Field label="Campaign (optional)" className="w-52">
        <Select value={campaign} onChange={(e) => setCampaign(e.target.value)} className="h-8">
          <option value="">— none —</option>
          {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </Field>
      <Button size="sm" variant="primary" disabled={pending} onClick={() => run(() => saveToLeads(rows, tags.split(","), campaign || null), () => setOpen(false))}>{pending && <Spinner />}Save {rows.length}</Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={cx("h-7 px-2.5 rounded-full text-[12.5px] border transition-colors tabular-nums",
      active ? "bg-ink text-bg border-ink" : "border-line text-muted hover:text-ink hover:bg-panel")}>{children}</button>
  );
}
