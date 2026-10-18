"use client";

import { CheckCircle2, Copy, Download, MailCheck, Search, UserPlus, UserSearch } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { findOne, saveToLeads, verifyBatch } from "@/app/actions/verifier";
import { AddLeadsDialog, type CampaignOption, type LeadPrefill } from "@/components/add-leads";
import { Spinner, useAction, useConfirm } from "@/components/client";
import { Badge, Button, Card, CardHeader, Field, Input, Select, Skeleton, StatusBadge, Td, Textarea, Th, cx } from "@/components/ui";
import type { FindResult } from "@/lib/email-finder";
import type { VerifyResult } from "@/lib/email-verify";
import { fmtNum } from "@/lib/format";
import { VERIFY_LABEL } from "@/lib/labels";

type Tab = "find" | "verify";
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const MAX_VERIFY = 1000;

/** Results and inputs survive navigation (per browser tab). Only rendered after hydration (useHydrated), so reading storage up front is safe. */
function useSessionState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial; // storage blocked or bad JSON: start empty
    }
  });
  useEffect(() => {
    try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* full or blocked: not worth failing over */ }
  }, [key, value]);
  return [value, setValue] as const;
}

const noSubscribe = () => () => {};
/** False while rendering on the server and hydrating, true after (and on client-side navigations). */
function useHydrated() {
  return useSyncExternalStore(noSubscribe, () => true, () => false);
}

/** Results saved before the rewording mention network ports; say it in plain words. */
function plainReason(s: string): string {
  return /port 25/i.test(s) ? "The domain accepts email, but this network can't ask its mail server whether the mailbox exists." : s;
}

const FOOTNOTE = <>This network can&apos;t talk to some mail servers directly, so some company addresses (e.g. GoDaddy) show <i>Couldn&apos;t confirm</i>. They can still be emailed; bounces are watched.</>;

export function FindView({ campaigns, presetCampaign, smtpUnavailable }: { campaigns: CampaignOption[]; presetCampaign: string; smtpUnavailable: boolean }) {
  const sp = useSearchParams();
  const tab: Tab = sp.get("tab") === "verify" ? "verify" : "find";
  const setTab = (t: Tab) => {
    // Switching tabs needs no server data, so only the URL changes (no round trip).
    const next = new URLSearchParams(window.location.search);
    if (t === "find") next.delete("tab");
    else next.set("tab", t);
    const qs = next.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  };
  const footnote = smtpUnavailable ? <p className="text-[12px] text-faint leading-snug">{FOOTNOTE}</p> : null;
  // The tabs restore their inputs and results from sessionStorage, which the server can't see.
  const hydrated = useHydrated();

  return (
    <div className="grid gap-4">
      <div role="tablist" aria-label="Find or verify" className="inline-flex rounded-lg border border-line p-0.5 justify-self-start">
        {([["find", "Find email", UserSearch], ["verify", "Verify emails", MailCheck]] as const).map(([k, l, Icon]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={cx("h-8 px-3 rounded-md text-[13px] inline-flex items-center gap-1.5 transition-colors", tab === k ? "bg-accent-soft text-accent font-medium" : "text-muted hover:text-ink")}>
            <Icon size={14} />{l}
          </button>
        ))}
      </div>
      {!hydrated ? <Skeleton className="h-44" /> : <>
        {/* Both stay mounted so a running check keeps going while you look at the other tab. */}
        <div className={tab === "find" ? "" : "hidden"}><FindTab campaigns={campaigns} preset={presetCampaign} footnote={footnote} /></div>
        <div className={tab === "verify" ? "" : "hidden"}><VerifyTab campaigns={campaigns} preset={presetCampaign} footnote={footnote} /></div>
      </>}
    </div>
  );
}

/* ───────────── Find ───────────── */

type FindRow = { first: string; last: string; domain: string; result?: FindResult | { ok: false; error: string } };

const isConfirmed = (r: FindResult) => r.best?.mailbox === "exists" || r.verdict === "confirmed";

function FindTab({ campaigns, preset, footnote }: { campaigns: CampaignOption[]; preset: string; footnote: React.ReactNode }) {
  const [f, setF] = useSessionState("leads-find:one", { first: "", last: "", domain: "" });
  const [result, setResult] = useSessionState<FindResult | null>("leads-find:result", null);
  const [bulk, setBulk] = useSessionState("leads-find:bulk", "");
  const [rows, setRows] = useSessionState<FindRow[]>("leads-find:rows", []);
  const [loading, setLoading] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<number | null>(null);
  const [adding, setAdding] = useState<LeadPrefill | null>(null);

  const one = async () => {
    if (!f.first.trim() || !f.domain.trim()) return;
    setLoading(true);
    setResult(null);
    try {
      const r = await findOne(f);
      if (!r.ok) toast.error(r.error);
      else setResult(r);
    } catch (err) {
      toast.error((err as Error).message || "Something went wrong");
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
      <Card className="p-4 grid gap-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="First name"><Input value={f.first} placeholder="Priya" onChange={(e) => setF({ ...f, first: e.target.value })} /></Field>
          <Field label="Last name"><Input value={f.last} placeholder="Sharma" onChange={(e) => setF({ ...f, last: e.target.value })} /></Field>
          <Field label="Company website"><Input value={f.domain} placeholder="acme.com" onChange={(e) => setF({ ...f, domain: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") void one(); }} /></Field>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-[12px] text-muted">{loading ? "Looking at the company's website and mail server. This can take up to 30 seconds." : "Works best with the company's website (acme.com)."}</span>
          <Button variant="primary" onClick={() => void one()} disabled={loading || !f.first.trim() || !f.domain.trim()}>
            {loading ? <><Spinner />Finding…</> : <><Search size={15} />Find email</>}
          </Button>
        </div>
        {footnote}
      </Card>

      {result && <FindCard r={result} first={f.first} last={f.last} onAdd={(p) => setAdding(p)} />}

      <Card className="p-4 grid gap-3">
        <div className="font-semibold text-[14px]">A list of people</div>
        <Textarea rows={5} value={bulk} onChange={(e) => setBulk(e.target.value)} className="font-mono text-[12.5px]" aria-label="People to find, one per line"
          placeholder={"Priya Sharma, acme.com\nRahul Mehta, delhivery.com\nAnita, Rao, tvsmotor.com"} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-[12.5px] text-muted">One person per line: name and company website. Up to 100.{parsedBulk.length ? ` ${parsedBulk.length} ready.` : ""}</span>
          <Button onClick={() => void runBulk()} disabled={!parsedBulk.length || bulkProgress !== null}>
            {bulkProgress !== null ? <><Spinner />Finding {bulkProgress + 1} of {parsedBulk.length}…</> : <><UserSearch size={15} />Find all</>}
          </Button>
        </div>
        {bulkProgress !== null && parsedBulk.length > 0 && (
          <div className="h-1.5 rounded-full bg-panel-2 overflow-hidden"><div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${(bulkProgress / parsedBulk.length) * 100}%` }} /></div>
        )}
        {rows.length > 0 && (
          <>
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full text-[13px]">
                <thead className="bg-panel-2/50"><tr><Th>Lead</Th><Th>Website</Th><Th>Best email</Th><Th>Result</Th></tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <Td className="whitespace-nowrap">{r.first} {r.last}</Td>
                      <Td className="text-muted">{r.domain}</Td>
                      <Td className="font-medium">
                        {!r.result ? <span className="text-faint font-normal">{bulkProgress === i ? "Finding…" : "Waiting"}</span>
                          : !r.result.ok ? <span className="text-bad text-[12.5px] font-normal">{r.result.error}</span>
                          : r.result.best?.email ?? <span className="text-faint font-normal">—</span>}
                      </Td>
                      <Td>{r.result?.ok ? <Verdict r={r.result} /> : null}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {found.length > 0 && bulkProgress === null && (
              <SaveForm campaigns={campaigns} preset={preset} label={`Add ${fmtNum(found.length)} as leads`} defaultList="found"
                rows={found.map((r) => {
                  const res = r.result as FindResult;
                  return { email: res.best!.email, first_name: r.first, last_name: r.last, website: res.domain, status: isConfirmed(res) ? "valid" : "unknown" };
                })} />
            )}
          </>
        )}
      </Card>

      {adding && <AddLeadsDialog campaigns={campaigns} defaultCampaignId={preset || undefined} defaultTab="one" prefill={adding} onClose={() => setAdding(null)} />}
    </div>
  );
}

function Verdict({ r }: { r: FindResult }) {
  if (!r.best) return <Badge dot>Not found</Badge>;
  if (isConfirmed(r)) return <Badge tone="good" dot>Confirmed</Badge>;
  return <Badge tone="warn" dot>Best guess</Badge>;
}

function FindCard({ r, first, last, onAdd }: { r: FindResult; first: string; last: string; onAdd: (p: LeadPrefill) => void }) {
  const best = r.best;
  const confirmed = isConfirmed(r);
  const copy = (email: string) => navigator.clipboard.writeText(email).then(() => toast.success("Copied"), () => toast.error("Couldn't copy"));
  const reason = best?.evidence[0] ?? r.notes.find((n) => !/port 25|this network can't ask/i.test(n));
  const heading = !best ? "Not found" : confirmed ? "Confirmed"
    : r.acceptAll ? "Best guess (this company's mail server accepts any address)" : "Best guess (couldn't confirm from this network)";
  return (
    <Card className="fade-in">
      <CardHeader title={`${first} ${last}`.trim() || r.name} description={`${r.domain}${r.provider ? ` · ${r.provider}` : ""}`} />
      <div className="px-4 pb-4 grid gap-3">
        <div className={cx("rounded-xl border p-3.5", confirmed ? "border-good/30 bg-good-soft" : "border-line bg-panel-2/50")}>
          <div className={cx("text-[12.5px] font-medium", confirmed ? "text-good" : best ? "text-warn" : "text-muted")}>{heading}</div>
          {best ? (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {confirmed && <CheckCircle2 size={17} className="text-good" />}
              <span className="text-[16px] font-semibold break-all">{best.email}</span>
              <button type="button" className="text-muted hover:text-ink" aria-label="Copy email" onClick={() => copy(best.email)}><Copy size={14} /></button>
              <span className="text-[11.5px] text-faint tabular-nums">{best.confidence}% sure</span>
            </div>
          ) : <p className="mt-1 text-[13px] text-muted">No likely address. Check the website, or try the full name.</p>}
          {reason && <p className="mt-1.5 text-[12.5px] text-muted">{reason}</p>}
        </div>
        {r.candidates.length > 1 && (
          <details className="text-[12.5px]">
            <summary className="cursor-pointer select-none text-muted">Other possibilities</summary>
            <div className="mt-2 grid gap-1">
              {r.candidates.slice(1).map((c) => (
                <div key={c.email} className="flex items-center justify-between gap-3">
                  <button type="button" className="truncate text-left hover:underline" title="Copy" onClick={() => copy(c.email)}>{c.email}</button>
                  <span className="text-faint tabular-nums shrink-0">{c.mailbox === "exists" ? "confirmed" : `${c.confidence}%`}</span>
                </div>
              ))}
            </div>
          </details>
        )}
        {best && (
          <Button variant="secondary" className="justify-self-start"
            onClick={() => onAdd({ email: best.email, first_name: first.trim(), last_name: last.trim(), website: r.domain })}>
            <UserPlus size={15} />Add as lead
          </Button>
        )}
      </div>
    </Card>
  );
}

/* ───────────── Verify ───────────── */

function VerifyTab({ campaigns, preset, footnote }: { campaigns: CampaignOption[]; preset: string; footnote: React.ReactNode }) {
  const [text, setText] = useSessionState("leads-verify:text", "");
  const [results, setResults] = useSessionState<VerifyResult[]>("leads-verify:results", []);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [filter, setFilter] = useState("");
  const emails = useMemo(() => [...new Set((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()))], [text]);
  const shown = filter ? results.filter((r) => r.status === filter) : results;
  const counts = results.reduce<Record<string, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});

  const run = async () => {
    if (!emails.length || emails.length > MAX_VERIFY) return;
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
      toast.error((err as Error).message || "Something went wrong");
    } finally {
      setProgress(null);
    }
  };

  const csv = () => {
    const rows = [["email", "result", "score", "reason", "suggestion", "provider"],
      ...results.map((r) => [r.email, VERIFY_LABEL[r.status] ?? r.status, String(r.score), plainReason(r.reason), r.suggestion ?? "", r.provider ?? ""])];
    const blob = new Blob(["﻿" + rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\r\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "checked-emails.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const copyValid = () => {
    const valid = results.filter((r) => r.status === "valid").map((r) => r.email);
    if (!valid.length) return toast.error("No valid addresses to copy");
    navigator.clipboard.writeText(valid.join("\n")).then(() => toast.success(`Copied ${fmtNum(valid.length)} valid address${valid.length === 1 ? "" : "es"}`), () => toast.error("Couldn't copy"));
  };

  return (
    <div className="grid gap-4">
      <Card className="p-4 grid gap-3">
        <Field label="Emails to check" hint="Paste anything: one per line, comma-separated, or a whole block of text. Up to 1,000 at a time. Leads you already have get the result too.">
          <Textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-[12.5px]"
            placeholder={"priya@acme.com\nrahul.mehta@delhivery.com, info@tvsmotor.com\nsomeone@gmial.com"} />
        </Field>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className={cx("text-[12.5px]", emails.length > MAX_VERIFY ? "text-bad" : "text-muted")}>
            {emails.length > MAX_VERIFY ? `${fmtNum(emails.length)} addresses: check up to 1,000 at a time` : emails.length ? `${fmtNum(emails.length)} unique address${emails.length === 1 ? "" : "es"} found` : "No addresses yet"}
          </span>
          <Button variant="primary" onClick={() => void run()} disabled={!emails.length || Boolean(progress) || emails.length > MAX_VERIFY}>
            {progress ? <><Spinner />Checking {fmtNum(progress.done)} of {fmtNum(progress.total)}…</> : <><MailCheck size={15} />Check {emails.length ? fmtNum(emails.length) : ""} email{emails.length === 1 ? "" : "s"}</>}
          </Button>
        </div>
        {progress && <div className="h-1.5 rounded-full bg-panel-2 overflow-hidden"><div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>}
        {footnote}
      </Card>

      {results.length > 0 && (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 border-b border-line">
            <Chip active={!filter} onClick={() => setFilter("")}>All {fmtNum(results.length)}</Chip>
            {(["valid", "risky", "invalid", "unknown"] as const).map((s) => counts[s] ? <Chip key={s} active={filter === s} onClick={() => setFilter(s)}>{VERIFY_LABEL[s]} {fmtNum(counts[s])}</Chip> : null)}
            <span className="ml-auto flex flex-wrap gap-2">
              <Button size="sm" onClick={copyValid}><Copy size={14} />Copy valid</Button>
              <Button size="sm" onClick={csv}><Download size={14} />Download CSV</Button>
            </span>
          </div>
          <div className="px-3 py-2.5 border-b border-line">
            <SaveForm campaigns={campaigns} preset={preset} label="Add as leads" defaultList="checked"
              rows={results.filter((r) => r.status !== "invalid").map((r) => ({ email: r.email, status: r.status }))} />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="bg-panel-2/50"><tr><Th>Email</Th><Th>Result</Th><Th>Why</Th><Th>Provider</Th></tr></thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.email} className="hover:bg-panel-2/60">
                    <Td className="font-medium max-w-[260px] truncate">{r.email}</Td>
                    <Td className="whitespace-nowrap">
                      <StatusBadge status={r.status} kind="verify" />
                      <span className="ml-1.5 text-[11.5px] text-faint tabular-nums">{r.score}</span>
                    </Td>
                    <Td className="text-muted min-w-[220px]">
                      {plainReason(r.reason)}
                      {r.suggestion && <button type="button" className="block text-accent text-[12px] hover:underline" onClick={() => setText((t) => t.replace(r.email, r.suggestion!))}>Did you mean {r.suggestion}? (fix in list)</button>}
                      <span className="flex flex-wrap gap-1 mt-1">
                        {r.checks.role && <Badge>Shared address (info@, sales@…)</Badge>}
                        {r.source === "history" && <Badge tone="good">From your own data</Badge>}
                        {r.checks.freeMail && <Badge>Personal email</Badge>}
                        {r.checks.acceptAll && <Badge tone="warn">Accepts any address</Badge>}
                        {r.source === "cache" && <Badge>Checked earlier</Badge>}
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
          <div><Badge tone="good" dot>{VERIFY_LABEL.valid}</Badge> the mailbox exists. Safe to email.</div>
          <div><Badge tone="warn" dot>{VERIFY_LABEL.risky}</Badge> the company accepts any address, a shared address (info@), or a likely typo. Send carefully.</div>
          <div><Badge dot>{VERIFY_LABEL.unknown}</Badge> the domain accepts email but its server wouldn&apos;t confirm the mailbox (common with big providers). Fine to email; bounces are watched.</div>
          <div><Badge tone="bad" dot>{VERIFY_LABEL.invalid}</Badge> doesn&apos;t exist, no mail server, or a throwaway address. Don&apos;t send: it would hurt your sender reputation.</div>
        </Card>
      )}
    </div>
  );
}

/* ───────────── Shared ───────────── */

type SaveRow = { email: string; first_name?: string; last_name?: string; website?: string; status: string };

/** "Add as leads" button that opens a small List + Campaign form in place. */
function SaveForm({ rows, campaigns, preset, label, defaultList }: { rows: SaveRow[]; campaigns: CampaignOption[]; preset: string; label: string; defaultList: string }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState(defaultList);
  const [campaign, setCampaign] = useState(preset);
  const [pending, run] = useAction();
  const { confirm, element } = useConfirm();
  if (!open) {
    return <Button size="sm" variant="secondary" className="justify-self-start" disabled={!rows.length} onClick={() => setOpen(true)}><UserPlus size={14} />{label}</Button>;
  }
  const save = async () => {
    const c = campaigns.find((x) => x.id === campaign);
    const restart = c?.status === "completed" && await confirm({
      title: `${c.name} had finished. Restart it for these leads?`,
      body: "Restart it to start emailing them now. Cancel still adds them, and the campaign waits, paused, until you resume it.",
      confirmLabel: "Restart it",
    });
    run(() => saveToLeads(rows, [list], campaign || null, { restart }), () => setOpen(false));
  };
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-line p-2.5 fade-in">
      <Field label="List name" className="w-40"><Input value={list} onChange={(e) => setList(e.target.value)} className="h-8" /></Field>
      <Field label="Add to campaign" className="w-56">
        <Select value={campaign} onChange={(e) => setCampaign(e.target.value)} className="h-8">
          <option value="">None</option>
          {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}{c.status === "draft" ? " (not launched)" : c.status === "completed" ? " (finished)" : ""}</option>)}
        </Select>
      </Field>
      <Button size="sm" variant="primary" disabled={pending || !rows.length} onClick={() => void save()}>{pending && <Spinner />}Add {fmtNum(rows.length)} lead{rows.length === 1 ? "" : "s"}</Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      {element}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cx("h-7 px-2.5 rounded-full text-[12.5px] border transition-colors tabular-nums",
      active ? "bg-ink text-bg border-ink" : "border-line text-muted hover:text-ink hover:bg-panel")}>{children}</button>
  );
}
