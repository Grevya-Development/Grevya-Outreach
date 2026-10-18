"use client";

import { Building2, CheckCircle2, ChevronDown, Copy, Download, Globe, MailCheck, Search, ShieldCheck, UserPlus, UserSearch, Users } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { toast } from "sonner";
import { findOne, saveToLeads, searchCompany, verifyBatch } from "@/app/actions/verifier";
import type { CampaignOption } from "@/components/add-leads";
import { Spinner } from "@/components/client";
import { Badge, Button, Card, Empty, Skeleton, Td, Textarea, Th, cx, type Tone } from "@/components/ui";
import type { DomainSearchResult } from "@/lib/domain-search";
import type { FindResult } from "@/lib/email-finder";
import { fmtNum } from "@/lib/format";
import type { VerifyReport } from "@/lib/verify-report";

type Mode = "company" | "name" | "verify";
type Failure = { ok: false; error: string };
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/* ───────────── small helpers ───────────── */

/** Inputs and results survive navigation (per browser tab). Rendered only after hydration. */
function useSessionState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full/blocked */ }
  }, [key, value]);
  return [value, setValue] as const;
}

const noSubscribe = () => () => {};
function useHydrated() {
  return useSyncExternalStore(noSubscribe, () => true, () => false);
}

/** A status line that steps through what the lookup is doing, so a 10–20s wait never feels stuck. */
function useProgressLine(active: boolean, steps: string[]) {
  const [i, setI] = useState(0);
  const [wasActive, setWasActive] = useState(active);
  // Restart from the first step each time a lookup starts (adjusting state during render).
  if (active !== wasActive) {
    setWasActive(active);
    if (active) setI(0);
  }
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setI((n) => Math.min(n + 1, steps.length - 1)), 3500);
    return () => clearInterval(id);
  }, [active, steps.length]);
  return steps[i];
}

const initials = (s: string) => {
  const parts = s.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase() || "?";
};

function copy(text: string, what = "Copied") {
  navigator.clipboard.writeText(text).then(() => toast.success(what), () => toast.error("Couldn't copy"));
}

function downloadCsv(name: string, rows: (string | number)[][]) {
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = name;
  a.click();
}

const VERDICT: Record<FindResult["verdict"], { label: string; tone: Tone }> = {
  confirmed: { label: "Confirmed", tone: "good" },
  likely: { label: "Likely", tone: "warn" },
  guess: { label: "Best guess", tone: "neutral" },
};

const VERIFY_TONE: Record<string, Tone> = { valid: "good", invalid: "bad", risky: "warn", unknown: "neutral" };
const VERIFY_WORD: Record<string, string> = { valid: "Valid", invalid: "Invalid", risky: "Risky", unknown: "Unverifiable" };

/* ───────────── page ───────────── */

export function FindView({ campaigns, presetCampaign, smtpUnavailable }: { campaigns: CampaignOption[]; presetCampaign: string; smtpUnavailable: boolean }) {
  const sp = useSearchParams();
  const initial = sp.get("mode") ?? (sp.get("tab") === "verify" ? "verify" : "name");
  const [mode, setModeState] = useState<Mode>(initial === "company" || initial === "verify" ? initial : "name");
  const setMode = (m: Mode) => {
    setModeState(m);
    const next = new URLSearchParams(window.location.search);
    next.delete("tab");
    next.set("mode", m);
    window.history.replaceState(null, "", `?${next.toString()}`);
  };
  const hydrated = useHydrated();
  const target = campaigns.find((c) => c.id === presetCampaign) ?? null;

  const save = async (rows: { email: string; first_name?: string; last_name?: string; company?: string; website?: string; status: string }[]) => {
    const r = await saveToLeads(rows, ["found"], target?.id ?? null);
    if (r.ok) toast.success(r.message ?? "Saved", r.action ? { action: { label: r.action.label, onClick: () => { window.location.href = r.action!.href; } } } : undefined);
    else toast.error(r.error);
  };

  const TABS: [Mode, string, string, typeof Search][] = [
    ["company", "Find email by company", "List the people and the email format at a company", Building2],
    ["name", "Find email by name", "Find one person's work email", UserSearch],
    ["verify", "Verify email", "Check if an email address is valid", MailCheck],
  ];

  return (
    <div className="grid gap-5 max-w-3xl mx-auto w-full">
      <div role="tablist" aria-label="Find or verify" className="flex flex-wrap justify-center gap-1 rounded-xl border border-line bg-panel-2/60 p-1 sm:justify-self-center">
        {TABS.map(([k, label, tip, Icon]) => (
          <button key={k} type="button" role="tab" aria-selected={mode === k} title={tip} onClick={() => setMode(k)}
            className={cx("h-9 px-3.5 rounded-lg text-[13.5px] inline-flex items-center gap-1.5 transition-colors",
              mode === k ? "bg-panel text-ink font-medium shadow-[0_1px_2px_rgb(0_0_0/0.06),0_0_0_1px_var(--line)]" : "text-muted hover:text-ink")}>
            <Icon size={15} />{label}
          </button>
        ))}
      </div>
      {target && <p className="text-center text-[12.5px] text-muted">Saved leads go straight into <b className="text-ink">{target.name}</b>.</p>}

      {!hydrated ? <Skeleton className="h-16" /> : <>
        {/* All three stay mounted, so a running lookup keeps going while you look at another tab. */}
        <div className={mode === "company" ? "" : "hidden"}><CompanyTab save={save} /></div>
        <div className={mode === "name" ? "" : "hidden"}><NameTab save={save} /></div>
        <div className={mode === "verify" ? "" : "hidden"}><VerifyTab save={save} /></div>
      </>}

      {smtpUnavailable && (
        <p className="text-center text-[12px] text-faint leading-snug">
          Some mail servers (GoDaddy, for example) refuse checks from this internet connection, so a few company addresses show “Unverifiable”. Everything else is checked live.
        </p>
      )}
    </div>
  );
}

type SaveFn = (rows: { email: string; first_name?: string; last_name?: string; company?: string; website?: string; status: string }[]) => Promise<void>;

/* ───────────── the big Hunter-style search bar ───────────── */

function SearchBar({ children, button, onSubmit, busy, disabled }: { children: ReactNode; button: string; onSubmit: () => void; busy: boolean; disabled?: boolean }) {
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (!busy && !disabled) onSubmit(); }}
      className="flex flex-col sm:flex-row items-stretch rounded-xl border border-line bg-panel shadow-[0_1px_3px_rgb(0_0_0/0.05)] focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/15 overflow-hidden">
      <div className="flex flex-1 flex-col sm:flex-row items-stretch min-w-0">{children}</div>
      <div className="p-1.5 sm:pl-0">
        <button type="submit" disabled={busy || disabled}
          className="h-11 w-full sm:w-auto px-5 rounded-lg bg-accent text-accent-ink text-[14.5px] font-medium inline-flex items-center justify-center gap-2 hover:opacity-90 disabled:opacity-50 transition-opacity">
          {busy ? <Spinner /> : <Search size={16} />}{button}
        </button>
      </div>
    </form>
  );
}

const barInput = "h-14 w-full min-w-0 bg-transparent px-4 text-[15px] outline-none placeholder:text-faint";

function Working({ line }: { line: string }) {
  return (
    <Card className="p-5 grid gap-3 fade-in">
      <div className="flex items-center gap-2 text-[13px] text-muted"><Spinner />{line}</div>
      <div className="flex items-center gap-4"><Skeleton className="size-14 rounded-full" /><div className="grid gap-2 flex-1"><Skeleton className="h-5 w-2/3" /><Skeleton className="h-4 w-1/3" /></div></div>
      <Skeleton className="h-20" />
    </Card>
  );
}

function Avatar({ text, tone = "neutral" }: { text: string; tone?: Tone }) {
  return (
    <div className={cx("size-14 shrink-0 rounded-full grid place-items-center text-[20px] font-medium",
      tone === "good" ? "bg-good-soft text-good" : tone === "bad" ? "bg-bad-soft text-bad" : tone === "warn" ? "bg-warn-soft text-warn" : "bg-accent-soft text-accent")}>
      {text}
    </div>
  );
}

function BulkToggle({ open, onClick, label }: { open: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} className="justify-self-center inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-ink">
      <ChevronDown size={14} className={cx("transition-transform", open && "rotate-180")} />{label}
    </button>
  );
}

/* ───────────── Find email by company ───────────── */

function CompanyTab({ save }: { save: SaveFn }) {
  const [q, setQ] = useSessionState("find:company:q", "");
  const [res, setRes] = useSessionState<DomainSearchResult | null>("find:company:res", null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const line = useProgressLine(busy, ["Finding the company…", "Reading their website…", "Looking for people and published addresses…", "Working out their email format…"]);

  const run = async (query = q) => {
    setBusy(true); setError(""); setRes(null);
    try {
      const r = await searchCompany(query);
      if (!r.ok) setError(r.error); else setRes(r);
    } catch (e) { setError((e as Error).message || "Something went wrong"); } finally { setBusy(false); }
  };

  return (
    <div className="grid gap-4">
      <SearchBar button="Find emails" busy={busy} disabled={!q.trim()} onSubmit={() => run()}>
        <Globe size={18} className="hidden sm:block self-center ml-4 text-faint shrink-0" />
        <input className={barInput} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Company name or website, e.g. TVS Motor or tvsmotor.com" aria-label="Company" />
      </SearchBar>
      {error && <p className="text-[13px] text-bad text-center">{error}</p>}
      {busy && <Working line={line} />}

      {res && !busy && (
        <div className="grid gap-4 fade-in">
          {res.companyMatches.length > 1 && (
            <p className="text-[12.5px] text-muted text-center">
              Did you mean:{" "}
              {res.companyMatches.filter((m) => m.domain !== res.domain).map((m, i) => (
                <button key={m.domain} type="button" onClick={() => { setQ(m.domain); void run(m.domain); }} className="text-accent hover:underline">
                  {i ? " · " : ""}{m.name} ({m.domain})
                </button>
              ))}
            </p>
          )}
          <Card className="p-5 grid gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <Avatar text={res.domain.slice(0, 2).toUpperCase()} />
              <div className="min-w-0">
                <div className="text-[17px] font-semibold">{res.domain}</div>
                <div className="text-[12.5px] text-muted">{[res.provider, res.domainAgeDays != null && `domain ${Math.floor(res.domainAgeDays / 365)} yr old`, !res.acceptsMail && "no mail server"].filter(Boolean).join(" · ")}</div>
              </div>
            </div>
            {res.pattern ? (
              <div className="rounded-lg bg-panel-2/60 px-4 py-3">
                <div className="text-[12px] uppercase tracking-wide text-faint">Email format</div>
                <div className="flex flex-wrap items-center gap-2 mt-0.5">
                  <span className="text-[15px] font-medium">{res.pattern.example}</span>
                  <Badge tone={res.pattern.confidence >= 80 ? "good" : "warn"}>{res.pattern.confidence}% confidence</Badge>
                </div>
                <details className="mt-1.5 text-[12.5px] text-muted">
                  <summary className="cursor-pointer select-none">Why we think so</summary>
                  <ul className="mt-1 list-disc pl-4 grid gap-0.5">{res.pattern.evidence.map((e) => <li key={e}>{e}</li>)}</ul>
                </details>
              </div>
            ) : (
              <p className="text-[13px] text-muted">We couldn&apos;t work out their email format yet. Use “Find email by name”: the first confirmed result teaches it for everyone at {res.domain}.</p>
            )}
            {res.notes.map((n) => <p key={n} className="text-[12.5px] text-faint">{n}</p>)}
          </Card>

          <Card className="overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-line">
              <div className="font-semibold text-[14px] flex items-center gap-1.5"><Users size={15} />People <span className="text-faint font-normal">{fmtNum(res.people.length)}</span></div>
              {res.people.length > 0 && (
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => downloadCsv(`${res.domain}-emails.csv`, [["name", "email", "source"], ...res.people.map((p) => [p.name ?? "", p.email, p.source])])}><Download size={14} />CSV</Button>
                  <Button size="sm" variant="primary" onClick={() => save(res.people.map((p) => ({ email: p.email, first_name: p.name?.split(" ")[0], last_name: p.name?.split(" ").slice(1).join(" "), website: res.domain, status: "unknown" })))}><UserPlus size={14} />Save all</Button>
                </div>
              )}
            </div>
            {res.people.length === 0 ? (
              <Empty icon={<Users size={24} />} title="No people published on their website">Many companies don&apos;t list staff emails. Search a person by name instead.</Empty>
            ) : (
              <ul className="divide-y divide-line">
                {res.people.map((p) => (
                  <li key={p.email} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                    <div className="size-9 shrink-0 rounded-full grid place-items-center bg-accent-soft text-accent text-[13px] font-medium">{initials(p.name ?? p.email)}</div>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium truncate">{p.name ?? "Name not listed"}</div>
                      <div className="text-[12.5px] text-muted truncate">{p.email}</div>
                    </div>
                    <Badge>{p.source === "website" ? "On their website" : "In your leads"}</Badge>
                    <Button size="sm" variant="ghost" aria-label="Copy" onClick={() => copy(p.email)}><Copy size={14} /></Button>
                    <Button size="sm" onClick={() => save([{ email: p.email, first_name: p.name?.split(" ")[0], last_name: p.name?.split(" ").slice(1).join(" "), website: res.domain, status: "unknown" }])}>Save as lead</Button>
                  </li>
                ))}
              </ul>
            )}
            {res.roleInboxes.length > 0 && (
              <details className="border-t border-line px-4 py-3 text-[13px]">
                <summary className="cursor-pointer select-none text-muted">Shared inboxes ({res.roleInboxes.length}): info@, sales@ and similar</summary>
                <div className="mt-2 flex flex-wrap gap-2">{res.roleInboxes.map((r) => <button key={r.email} type="button" onClick={() => copy(r.email)} className="rounded-md bg-panel-2 px-2 py-1 text-[12.5px] hover:text-accent">{r.email}</button>)}</div>
              </details>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

/* ───────────── Find email by name ───────────── */

type BulkRow = { name: string; company: string; result?: FindResult | Failure };

function NameTab({ save }: { save: SaveFn }) {
  const [f, setF] = useSessionState("find:name:q", { name: "", company: "" });
  const [res, setRes] = useSessionState<FindResult | null>("find:name:res", null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [bulkOpen, setBulkOpen] = useSessionState("find:name:bulkOpen", false);
  const [bulk, setBulk] = useSessionState("find:name:bulk", "");
  const [rows, setRows] = useSessionState<BulkRow[]>("find:name:rows", []);
  const [bulkAt, setBulkAt] = useState<number | null>(null);
  const line = useProgressLine(busy, ["Finding the company…", "Reading their website for the email format…", "Asking their mail server…", "Checking public profiles…"]);

  const run = async () => {
    setBusy(true); setError(""); setRes(null);
    try {
      const r = await findOne({ name: f.name, company: f.company });
      if (!r.ok) setError(r.error); else setRes(r);
    } catch (e) { setError((e as Error).message || "Something went wrong"); } finally { setBusy(false); }
  };

  const parsed = useMemo<BulkRow[]>(() => bulk.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const at = l.match(/^(.*?)\s*@\s*(\S+)$/);
    if (at) return { name: at[1], company: at[2] };
    const cells = l.split(/[,\t;]/).map((c) => c.trim()).filter(Boolean);
    return { name: cells.slice(0, -1).join(" "), company: cells[cells.length - 1] ?? "" };
  }).filter((r) => r.name && r.company).slice(0, 100), [bulk]);

  const runBulk = async () => {
    setRows(parsed.map((r) => ({ ...r })));
    for (let i = 0; i < parsed.length; i++) {
      setBulkAt(i);
      const r = await findOne(parsed[i]).catch((e) => ({ ok: false as const, error: (e as Error).message }));
      setRows((prev) => prev.map((row, j) => (j === i ? { ...row, result: r } : row)));
    }
    setBulkAt(null);
  };
  const foundRows = rows.filter((r) => r.result?.ok && r.result.best);

  return (
    <div className="grid gap-4">
      <SearchBar button="Find email" busy={busy} disabled={!f.name.trim() || !f.company.trim()} onSubmit={run}>
        <input className={barInput} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Full name, e.g. Priya Sharma" aria-label="Full name" />
        <span className="hidden sm:grid place-items-center px-3 text-faint border-x border-line text-[15px]">@</span>
        <input className={cx(barInput, "border-t border-line sm:border-t-0")} value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} placeholder="Company name or website" aria-label="Company" />
      </SearchBar>
      {error && <p className="text-[13px] text-bad text-center">{error}</p>}
      {busy && <Working line={line} />}
      {res && !busy && <FindCard r={res} onSave={() => save([{ email: res.best!.email, first_name: f.name.split(" ")[0], last_name: f.name.split(" ").slice(1).join(" "), website: res.domain, status: res.best!.mailbox === "exists" ? "valid" : "unknown" }])} />}

      <BulkToggle open={bulkOpen} onClick={() => setBulkOpen(!bulkOpen)} label="Find many at once" />
      {bulkOpen && (
        <Card className="p-4 grid gap-3 fade-in">
          <Textarea rows={5} value={bulk} onChange={(e) => setBulk(e.target.value)} className="font-mono text-[12.5px]"
            placeholder={"Priya Sharma, acme.com\nRahul Mehta @ Delhivery\nAnita Rao, TVS Motor"} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-[12.5px] text-muted">One person per line: name, then company name or website. Up to 100.{parsed.length ? ` ${parsed.length} ready.` : ""}</span>
            <Button variant="primary" onClick={runBulk} disabled={!parsed.length || bulkAt !== null}>
              {bulkAt !== null ? <><Spinner />Finding {bulkAt + 1} of {parsed.length}…</> : <><UserSearch size={15} />Find all</>}
            </Button>
          </div>
          {rows.length > 0 && (
            <>
              <div className="relative overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-[13px]">
                  <thead className="bg-panel-2/50"><tr><Th>Person</Th><Th>Company</Th><Th>Email</Th><Th>Result</Th></tr></thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i}>
                        <Td className="whitespace-nowrap">{r.name}</Td>
                        <Td className="text-muted">{r.result?.ok ? r.result.domain : r.company}</Td>
                        <Td className="font-medium">
                          {!r.result ? <span className="text-faint">{bulkAt === i ? "searching…" : "waiting"}</span>
                            : !r.result.ok ? <span className="text-bad text-[12.5px]">{r.result.error}</span>
                            : r.result.best?.email ?? "—"}
                        </Td>
                        <Td>{r.result?.ok && r.result.best ? <Badge tone={VERDICT[r.result.verdict].tone} dot>{VERDICT[r.result.verdict].label} · {r.result.best.confidence}%</Badge> : null}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {foundRows.length > 0 && bulkAt === null && (
                <div className="flex justify-end gap-2">
                  <Button size="sm" onClick={() => downloadCsv("found-emails.csv", [["name", "company", "email", "result", "confidence"], ...foundRows.map((r) => { const x = r.result as FindResult; return [r.name, x.domain, x.best!.email, VERDICT[x.verdict].label, x.best!.confidence]; })])}><Download size={14} />CSV</Button>
                  <Button size="sm" variant="primary" onClick={() => save(foundRows.map((r) => { const x = r.result as FindResult; return { email: x.best!.email, first_name: r.name.split(" ")[0], last_name: r.name.split(" ").slice(1).join(" "), website: x.domain, status: x.best!.mailbox === "exists" ? "valid" : "unknown" }; }))}>
                    <UserPlus size={14} />Save {foundRows.length} as leads
                  </Button>
                </div>
              )}
            </>
          )}
        </Card>
      )}
    </div>
  );
}

function FindCard({ r, onSave }: { r: FindResult; onSave: () => void }) {
  const best = r.best;
  if (!best) return <Card><Empty icon={<UserSearch size={24} />} title="No likely address found">Check the company website and the spelling of the name.</Empty></Card>;
  const v = VERDICT[r.verdict];
  return (
    <Card className="fade-in overflow-hidden">
      <div className="flex flex-wrap items-center gap-4 p-5">
        <Avatar text={initials(r.name || best.email)} tone={v.tone === "good" ? "good" : undefined} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[18px] font-semibold break-all">{best.email}</span>
            {best.mailbox === "exists" && <CheckCircle2 size={18} className="text-good" />}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Badge tone={v.tone} dot>{v.label} · {best.confidence}%</Badge>
            <span className="text-[12.5px] text-muted">{r.name} · {r.domain}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => copy(best.email)}><Copy size={14} />Copy</Button>
          <Button size="sm" variant="primary" onClick={onSave}><UserPlus size={14} />Save as lead</Button>
        </div>
      </div>
      <div className="border-t border-line bg-panel-2/40 px-5 py-4 grid gap-3 text-[13px]">
        {best.evidence.length > 0 && (
          <div>
            <div className="font-medium mb-1">Why we think so</div>
            <ul className="list-disc pl-4 grid gap-0.5 text-muted">{best.evidence.map((e) => <li key={e}>{e}</li>)}</ul>
          </div>
        )}
        {r.acceptAll && <p className="text-warn text-[12.5px]">This company accepts mail for any address, so its mail server can&apos;t confirm which one is real.</p>}
        {r.notes.map((n) => <p key={n} className="text-[12.5px] text-faint">{n}</p>)}
        {r.candidates.length > 1 && (
          <details>
            <summary className="cursor-pointer select-none text-muted">Other possibilities ({r.candidates.length - 1})</summary>
            <ul className="mt-2 grid gap-1">
              {r.candidates.slice(1).map((c) => (
                <li key={c.email} className="flex items-center justify-between gap-3">
                  <button type="button" onClick={() => copy(c.email)} className="truncate hover:text-accent text-left">{c.email}</button>
                  <span className="text-faint tabular-nums shrink-0">{c.mailbox === "exists" ? "confirmed" : `${c.confidence}%`}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Card>
  );
}

/* ───────────── Verify email ───────────── */

function VerifyTab({ save }: { save: SaveFn }) {
  const [q, setQ] = useSessionState("find:verify:q", "");
  const [res, setRes] = useSessionState<VerifyReport | null>("find:verify:res", null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [bulkOpen, setBulkOpen] = useSessionState("find:verify:bulkOpen", false);
  const [text, setText] = useSessionState("find:verify:bulk", "");
  const [results, setResults] = useSessionState<VerifyReport[]>("find:verify:results", []);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [filter, setFilter] = useState("");
  const line = useProgressLine(busy, ["Checking the format and domain…", "Asking the mail server…", "Checking public profiles…"]);

  const run = async () => {
    const email = (q.match(EMAIL_RE) ?? [q.trim()])[0];
    setBusy(true); setError(""); setRes(null);
    try {
      const [r] = await verifyBatch([email], true);
      if (r) setRes(r); else setError("Enter an email address");
    } catch (e) { setError((e as Error).message || "Something went wrong"); } finally { setBusy(false); }
  };

  const emails = useMemo(() => [...new Set((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()))], [text]);
  const runBulk = async () => {
    setResults([]); setFilter(""); setProgress({ done: 0, total: emails.length });
    try {
      for (let i = 0; i < emails.length; i += 25) {
        const batch = await verifyBatch(emails.slice(i, i + 25));
        setResults((r) => [...r, ...batch]);
        setProgress({ done: Math.min(emails.length, i + 25), total: emails.length });
      }
    } catch (e) { toast.error((e as Error).message); } finally { setProgress(null); }
  };
  const counts = results.reduce<Record<string, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
  const shown = filter ? results.filter((r) => r.status === filter) : results;

  return (
    <div className="grid gap-4">
      <SearchBar button="Verify email" busy={busy} disabled={!q.trim()} onSubmit={run}>
        <MailCheck size={18} className="hidden sm:block self-center ml-4 text-faint shrink-0" />
        <input className={barInput} value={q} onChange={(e) => setQ(e.target.value)} placeholder="name@company.com" aria-label="Email address" inputMode="email" />
      </SearchBar>
      {error && <p className="text-[13px] text-bad text-center">{error}</p>}
      {busy && <Working line={line} />}
      {res && !busy && <VerifyCard r={res} onSave={() => save([{ email: res.email, status: res.status }])} onFix={(s) => { setQ(s); }} />}

      <BulkToggle open={bulkOpen} onClick={() => setBulkOpen(!bulkOpen)} label="Verify a list" />
      {bulkOpen && (
        <Card className="p-4 grid gap-3 fade-in">
          <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} className="font-mono text-[12.5px]"
            placeholder={"priya@acme.com\nrahul.mehta@delhivery.com, info@tvsmotor.com"} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-[12.5px] text-muted">Paste anything: one per line, comma-separated, or a block of text. Up to 1,000.{emails.length ? ` ${fmtNum(emails.length)} found.` : ""}</span>
            <Button variant="primary" onClick={runBulk} disabled={!emails.length || Boolean(progress) || emails.length > 1000}>
              {progress ? <><Spinner />Checking {progress.done}/{progress.total}…</> : <><ShieldCheck size={15} />Verify {emails.length || ""}</>}
            </Button>
          </div>
          {progress && <div className="h-1.5 rounded-full bg-panel-2 overflow-hidden"><div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>}
          {results.length > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip active={!filter} onClick={() => setFilter("")}>All {results.length}</Chip>
                {(["valid", "risky", "unknown", "invalid"] as const).map((s) => counts[s] ? <Chip key={s} active={filter === s} onClick={() => setFilter(s)}>{VERIFY_WORD[s]} {counts[s]}</Chip> : null)}
                <span className="ml-auto flex gap-2">
                  <Button size="sm" onClick={() => copy(results.filter((r) => r.status === "valid").map((r) => r.email).join("\n"), "Valid addresses copied")}><Copy size={14} />Copy valid</Button>
                  <Button size="sm" onClick={() => downloadCsv("verified-emails.csv", [["email", "result", "score", "reason", "suggestion"], ...results.map((r) => [r.email, VERIFY_WORD[r.status], r.score, r.reason, r.suggestion ?? ""])])}><Download size={14} />CSV</Button>
                  <Button size="sm" variant="primary" onClick={() => save(results.filter((r) => r.status !== "invalid").map((r) => ({ email: r.email, status: r.status })))}><UserPlus size={14} />Save usable as leads</Button>
                </span>
              </div>
              <div className="relative overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-[13px]">
                  <thead className="bg-panel-2/50"><tr><Th>Email</Th><Th>Result</Th><Th>Why</Th></tr></thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr key={r.email}>
                        <Td className="font-medium max-w-[240px] truncate">{r.email}</Td>
                        <Td className="whitespace-nowrap"><Badge tone={VERIFY_TONE[r.status]} dot>{VERIFY_WORD[r.status]}</Badge> <span className="text-[11.5px] text-faint tabular-nums">{r.score}</span></Td>
                        <Td className="text-muted">{r.reason}{r.suggestion && <span className="block text-accent text-[12px]">Did you mean {r.suggestion}?</span>}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}

function VerifyCard({ r, onSave, onFix }: { r: VerifyReport; onSave: () => void; onFix: (s: string) => void }) {
  const tone = VERIFY_TONE[r.status];
  const via = r.signals.gravatar ? "a public profile" : r.source === "smtp" ? "the company's mail server" : r.source === "history" ? "your own data" : r.source === "cache" ? "an earlier check" : "the domain's mail setup";
  return (
    <Card className="fade-in overflow-hidden">
      <div className="flex flex-wrap items-center gap-4 p-5">
        <Avatar text={r.initials} tone={tone} />
        <div className="min-w-0 flex-1">
          <div className="text-[17px] font-semibold break-all">{r.headline}</div>
          <div className="text-[13px] text-muted mt-0.5">{r.summary}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Badge tone={tone} dot>{VERIFY_WORD[r.status]}</Badge>
            <span className="text-[12px] text-faint tabular-nums">Score {r.score}/100</span>
          </div>
        </div>
        {r.status !== "invalid" && <Button size="sm" onClick={onSave}><UserPlus size={14} />Save as lead</Button>}
      </div>
      {r.suggestion && (
        <div className="px-5 pb-3 -mt-2 text-[13px]">
          <button type="button" className="text-accent hover:underline" onClick={() => onFix(r.suggestion!)}>Did you mean {r.suggestion}? Check that instead</button>
        </div>
      )}
      <div className="border-t border-line px-5 py-2.5 text-[12.5px] text-muted">{r.reason}. Checked via {via}.</div>
      <div className="grid sm:grid-cols-2 gap-x-8 gap-y-5 border-t border-line bg-panel-2/40 px-5 py-5">
        {r.subChecks.map((c) => (
          <div key={c.key}>
            <div className="flex items-center gap-2"><span className="font-medium text-[13.5px]">{c.label}</span><Badge tone={c.tone}>{c.value}</Badge></div>
            <p className="mt-1.5 text-[13px] text-muted leading-snug">{c.detail}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cx("h-7 px-2.5 rounded-full text-[12.5px] border transition-colors tabular-nums",
      active ? "bg-ink text-bg border-ink" : "border-line text-muted hover:text-ink hover:bg-panel")}>{children}</button>
  );
}
