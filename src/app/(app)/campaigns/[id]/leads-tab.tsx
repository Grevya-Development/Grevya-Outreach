"use client";

import {
  CheckCheck, ChevronDown, ChevronLeft, ChevronRight, FileUp, ListPlus, Plus, RefreshCw, RotateCcw, Search, SearchCheck, Trash2, UserPlus, Users, X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { approveLeads, enrollLeads, removeCampaignLeads, retryLeads, rewriteLeads, type CampaignLeadSelection } from "@/app/actions/campaigns";
import { AddLeadsDialog, type CampaignOption } from "@/components/add-leads";
import { ActionButton, Dialog, Menu, Spinner, useAction, useConfirm } from "@/components/client";
import { LeadDrawer } from "@/components/lead-drawer";
import { Badge, Button, Card, Empty, Field, Input, Select, StatusBadge, Td, Th, cx } from "@/components/ui";
import { fmtDate, fmtDateTime, fmtNum } from "@/lib/format";
import { campaignLeadStatus, verifyLabel } from "@/lib/labels";
import { BuilderFooter } from "./builder";
import { FilterChip } from "./campaign-client";

export type LeadsTabRow = {
  id: string;
  status: string;
  current_step: number;
  next_send_at: string | null;
  /** next_send_at has passed (worked out on the server). */
  due: boolean;
  last_error: string | null;
  prep_status: string | null;
  prep_error: string | null;
  fit_score: number | null;
  skip_reason: string | null;
  mailbox_id: string | null;
  lead_id: string;
  edited: boolean;
  lastSent: string | null;
  lead: { email: string; first_name: string; last_name: string; company: string; verify_status: string | null };
};

type Campaign = { id: string; name: string; status: string; mode: "ai" | "template" };
type Chip = { key: string; label: string; count: number };
type Tag = { tag: string; n: number };

function toggle(set: Set<string>, id: string): Set<string> {
  const n = new Set(set);
  if (n.has(id)) n.delete(id);
  else n.add(id);
  return n;
}

export function LeadsTab({
  campaign, builder, rows, total, page, pageSize, filter, chips, tags, accounts, totalSteps, checking, aiNote, campaigns, viewParam, nextHref, defaultAdd,
}: {
  campaign: Campaign;
  builder: boolean;
  rows: LeadsTabRow[];
  total: number;
  page: number;
  pageSize: number;
  filter: { q?: string; status?: string };
  chips: Chip[];
  tags: Tag[];
  /** Account id → email, for the Account column. */
  accounts: Record<string, string>;
  totalSteps: number;
  /** Sending is on, so unchecked emails show "Checking…". */
  checking: boolean;
  /** AI draft whose sequence isn't saved yet. */
  aiNote: boolean;
  campaigns: CampaignOption[];
  /** `step=leads` or `tab=leads`. */
  viewParam: string;
  nextHref?: string;
  defaultAdd?: "list";
}) {
  const router = useRouter();
  const ai = campaign.mode === "ai";
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [add, setAdd] = useState<"list" | "csv" | "one" | null>(defaultAdd ?? null);
  const [drawer, setDrawer] = useState<string | null>(null);
  const [text, setText] = useState(filter.q ?? "");
  const [pending, start] = useTransition();

  const href = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(viewParam);
    const cur: Record<string, string | null> = { q: filter.q ?? null, status: filter.status ?? null, page: page > 1 ? String(page) : null, ...patch };
    if (!("page" in patch)) cur.page = null; // filter changes go back to page 1
    for (const [k, v] of Object.entries(cur)) if (v) p.set(k, v);
    return `/campaigns/${campaign.id}?${p.toString()}`;
  };
  const go = (patch: Record<string, string | null>) => start(() => router.replace(href(patch), { scroll: false }));

  // Debounced search-as-you-type.
  useEffect(() => {
    if (text.trim() === (filter.q ?? "")) return;
    const t = setTimeout(() => go({ q: text.trim() || null }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const filtered = !!(filter.q || filter.status);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const pageAll = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const selection: CampaignLeadSelection = allMatching ? { filter } : { ids: [...selected] };
  const count = allMatching ? total : selected.size;
  const clear = () => { setSelected(new Set()); setAllMatching(false); };
  const done = async <T extends { ok: boolean }>(p: Promise<T>) => { const r = await p; if (r.ok) clear(); return r; };
  const editedSelected = allMatching ? null : rows.filter((r) => selected.has(r.id) && r.edited).length;

  const addMenu = (
    <Menu align="end"
      trigger={<Button><Plus size={15} />Add leads<ChevronDown size={14} className="-mr-1 text-muted" /></Button>}
      items={[
        { label: "From a list…", icon: <ListPlus />, onSelect: () => setAdd("list") },
        { label: "Import CSV", icon: <FileUp />, onSelect: () => setAdd("csv") },
        { label: "Add by hand", icon: <UserPlus />, onSelect: () => setAdd("one") },
        { label: "Find email", icon: <SearchCheck />, href: `/leads/find?campaign=${campaign.id}` },
      ]} />
  );

  const dialogs = (
    <>
      {add === "list" && <EnrollFromListDialog campaign={campaign} tags={tags} onClose={() => setAdd(null)} />}
      {(add === "csv" || add === "one") && (
        <AddLeadsDialog campaignId={campaign.id} campaignName={campaign.name} campaignStatus={campaign.status} defaultTab={add} onClose={() => setAdd(null)} />
      )}
      <LeadDrawer leadId={drawer} onClose={() => setDrawer(null)} campaigns={campaigns} checking={checking} />
    </>
  );
  const footer = builder && nextHref ? <BuilderFooter onSaveAndContinue={() => start(() => router.push(nextHref))} saving={pending} /> : null;

  // No leads at all: three ways to add them.
  if (!total && !filtered) {
    return (
      <div className="grid gap-4">
        <Card>
          <Empty icon={<Users size={28} />} title="No leads in this campaign yet">
            Pick one of your lists, import a CSV or add people by hand. Leads already in the campaign, blocked or invalid are skipped.
          </Empty>
          <div className="grid sm:grid-cols-3 gap-3 px-4 pb-6 -mt-6 max-w-2xl mx-auto">
            <Tile primary icon={<ListPlus size={18} />} title="Pick a list"
              sub={tags.length ? tags.slice(0, 3).map((t) => `${t.tag} (${fmtNum(t.n)})`).join(" · ") + (tags.length > 3 ? " …" : "") : "All your leads"}
              onClick={() => setAdd("list")} />
            <Tile icon={<FileUp size={18} />} title="Import CSV" sub="Map columns, they're added here" onClick={() => setAdd("csv")} />
            <Tile icon={<UserPlus size={18} />} title="Add by hand" sub="One lead or a pasted list" onClick={() => setAdd("one")} />
          </div>
          {aiNote && <p className="px-4 pb-5 -mt-2 text-center text-[12.5px] text-muted">AI starts researching and writing once you save the sequence (next step).</p>}
        </Card>
        {dialogs}
        {footer}
      </div>
    );
  }

  return (
    <div className="grid gap-3 min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search name, email, company" className="pl-9" aria-label="Search leads" />
        </div>
        {pending && <Spinner className="text-faint" />}
        <div className="ml-auto">{addMenu}</div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <FilterChip href={href({ status: null })} active={!filter.status}>All <span className="opacity-70">{fmtNum(chips.reduce((s, c) => (c.key === "all" ? c.count : s), 0))}</span></FilterChip>
        {chips.filter((c) => c.key !== "all" && (c.count > 0 || filter.status === c.key)).map((c) => (
          <FilterChip key={c.key} href={href({ status: c.key })} active={filter.status === c.key}>{c.label} <span className="opacity-70">{fmtNum(c.count)}</span></FilterChip>
        ))}
      </div>
      {aiNote && <p className="text-[12.5px] text-muted">AI starts researching and writing once you save the sequence (next step).</p>}

      {!rows.length ? (
        <Card>
          <Empty icon={<Search size={26} />} title="No leads match"
            action={<Button onClick={() => { setText(""); go({ q: null, status: null }); }}><X size={14} />Clear filters</Button>} />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          {count > 0 && (
            <div className="border-b border-line bg-accent-soft/60 fade-in">
              <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="text-[13px] font-medium mr-auto tabular-nums">{fmtNum(count)} selected</span>
                {ai && <ActionButton size="sm" action={() => done(approveLeads(campaign.id, selection))}><CheckCheck size={14} />Approve</ActionButton>}
                {ai && (
                  <ActionButton size="sm"
                    confirm={{
                      title: `Rewrite the emails for ${fmtNum(count)} lead${count === 1 ? "" : "s"}?`,
                      body: editedSelected === null
                        ? "Only leads who haven't had Email 1 yet are rewritten. Emails you edited by hand are kept."
                        : editedSelected > 0
                          ? `Only leads who haven't had Email 1 yet are rewritten. ${fmtNum(editedSelected)} you edited by hand are kept.`
                          : "Only leads who haven't had Email 1 yet are rewritten.",
                      confirmLabel: "Rewrite",
                    }}
                    action={() => done(rewriteLeads(campaign.id, selection))}><RefreshCw size={14} />Rewrite</ActionButton>
                )}
                <ActionButton size="sm" action={() => done(retryLeads(campaign.id, selection))}><RotateCcw size={14} />Retry</ActionButton>
                <ActionButton size="sm" variant="danger"
                  confirm={{ title: `Remove ${fmtNum(count)} lead${count === 1 ? "" : "s"} from this campaign?`, body: "They stay in your leads, and emails already sent stay in the totals. They get no more emails from this campaign.", confirmLabel: "Remove" }}
                  action={async () => {
                    const r = await done(removeCampaignLeads(campaign.id, selection));
                    // The page would be empty: step back one (the server would redirect anyway).
                    if (r.ok && page > 1 && (allMatching || pageAll)) go({ page: page - 1 > 1 ? String(page - 1) : null });
                    return r;
                  }}><Trash2 size={14} />Remove</ActionButton>
              </div>
              {pageAll && total > rows.length && (
                <div className="px-3 pb-2 text-[12.5px] text-muted">
                  {allMatching ? (
                    <>All {fmtNum(total)} matching leads are selected. <button type="button" className="text-accent font-medium hover:underline" onClick={clear}>Clear selection</button></>
                  ) : (
                    <>All {fmtNum(rows.length)} on this page selected. <button type="button" className="text-accent font-medium hover:underline" onClick={() => setAllMatching(true)}>Select all {fmtNum(total)} matching</button></>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="relative overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="bg-panel-2/50">
                <tr>
                  <Th className="w-10">
                    <input type="checkbox" checked={pageAll} aria-label="Select all on this page" className="accent-[var(--accent)]"
                      onChange={() => { setAllMatching(false); setSelected(pageAll ? new Set() : new Set(rows.map((r) => r.id))); }} />
                  </Th>
                  <Th>Lead</Th><Th>Company</Th>{ai && <Th>Fit</Th>}<Th>Status</Th><Th>Email check</Th><Th>Last sent</Th><Th>Next email</Th><Th>Account</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const st = campaignLeadStatus(r, { mode: campaign.mode, totalSteps, campaignStatus: campaign.status });
                  const reason = st.detail ?? (st.label === "AI couldn't write" ? r.prep_error ?? undefined : undefined);
                  const waiting = r.status === "queued" || r.status === "in_progress";
                  const name = [r.lead.first_name, r.lead.last_name].filter(Boolean).join(" ");
                  return (
                    <tr key={r.id} className={cx("hover:bg-panel-2/60 transition-colors", selected.has(r.id) && "bg-accent-soft/40")}>
                      <Td>
                        <input type="checkbox" checked={allMatching || selected.has(r.id)} aria-label={`Select ${r.lead.email}`} className="accent-[var(--accent)]"
                          onChange={() => { setAllMatching(false); setSelected((s) => toggle(s, r.id)); }} />
                      </Td>
                      <Td className="max-w-[240px]">
                        <button type="button" onClick={() => setDrawer(r.lead_id)} className="text-left min-w-0 max-w-full hover:underline underline-offset-2">
                          <div className="font-medium truncate">{name || r.lead.email}</div>
                          {name && <div className="text-[12px] text-muted truncate">{r.lead.email}</div>}
                        </button>
                      </Td>
                      <Td className="max-w-[180px] truncate">{r.lead.company || <span className="text-faint">{r.lead.email.split("@")[1]}</span>}</Td>
                      {ai && (
                        <Td className="tabular-nums whitespace-nowrap">
                          {r.fit_score != null
                            ? <span title="How well the company matches who you sell to, judged by AI from their website."><Badge tone={r.fit_score >= 7 ? "good" : r.fit_score >= 4 ? "warn" : "bad"}>Fit {r.fit_score}/10</Badge></span>
                            : <span className="text-faint">—</span>}
                        </Td>
                      )}
                      <Td>
                        <Badge tone={st.tone} dot>{st.label}</Badge>
                        {reason && <div className="text-[11.5px] text-muted mt-0.5 max-w-[240px] truncate" title={reason}>{reason}</div>}
                      </Td>
                      <Td className="whitespace-nowrap">
                        {r.lead.verify_status ? <StatusBadge status={r.lead.verify_status} kind="verify" /> : <span className="text-faint text-[12px]">{verifyLabel(null, checking)}</span>}
                      </Td>
                      <Td className="whitespace-nowrap text-muted tabular-nums">{r.lastSent ? fmtDate(r.lastSent) : <span className="text-faint">—</span>}</Td>
                      <Td className="whitespace-nowrap text-muted tabular-nums">
                        {!waiting ? <span className="text-faint">—</span> : campaign.status !== "active" ? "Paused" : r.due ? "Due now" : fmtDateTime(r.next_send_at)}
                      </Td>
                      <Td className="max-w-[180px] truncate text-muted">{r.mailbox_id ? accounts[r.mailbox_id] ?? <span className="text-faint">Removed account</span> : <span className="text-faint">—</span>}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 min-h-11 py-1.5 text-[12.5px] text-muted">
            <span className="tabular-nums">{fmtNum((page - 1) * pageSize + 1)}–{fmtNum(Math.min(total, page * pageSize))} of {fmtNum(total)}</span>
            {pages > 1 && (
              <div className="flex items-center gap-1">
                <span className="tabular-nums mr-1">Page {fmtNum(page)} of {fmtNum(pages)}</span>
                <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => go({ page: page - 1 > 1 ? String(page - 1) : null })} aria-label="Previous page"><ChevronLeft size={15} /></Button>
                <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => go({ page: String(page + 1) })} aria-label="Next page"><ChevronRight size={15} /></Button>
              </div>
            )}
          </div>
        </Card>
      )}
      {dialogs}
      {footer}
    </div>
  );
}

function Tile({ icon, title, sub, onClick, primary }: { icon: React.ReactNode; title: string; sub: string; onClick: () => void; primary?: boolean }) {
  return (
    <button type="button" onClick={onClick}
      className={cx("flex flex-col items-start gap-1.5 rounded-xl border p-3.5 text-left transition-colors min-w-0",
        primary ? "border-accent/40 bg-accent-soft/60 hover:bg-accent-soft" : "border-line hover:bg-panel-2")}>
      <span className={primary ? "text-accent" : "text-muted"}>{icon}</span>
      <span className="text-[13.5px] font-medium">{title}</span>
      <span className="text-[12px] text-muted truncate max-w-full">{sub}</span>
    </button>
  );
}

/* ───────────── Add from a list ───────────── */

type Enrollable = { total: number; already_in: number; blocked: number; not_emailable: number; invalid: number; in_other_active: number; will_add: number | null };

/** "Add 420 leads. Skipped: 12 already in this campaign · 3 on block list …" */
function summary(e: Enrollable): string {
  if (e.will_add == null) return "Leads already in the campaign, blocked or invalid are skipped.";
  const skipped = [
    e.already_in && `${fmtNum(e.already_in)} already in this campaign`,
    e.blocked && `${fmtNum(e.blocked)} on block list`,
    e.invalid && `${fmtNum(e.invalid)} invalid`,
    e.not_emailable && `${fmtNum(e.not_emailable)} can't be emailed`,
  ].filter(Boolean);
  return `Add ${fmtNum(e.will_add)} lead${e.will_add === 1 ? "" : "s"}.`
    + (skipped.length ? ` Skipped: ${skipped.join(" · ")}.` : "")
    + (e.in_other_active ? ` ${fmtNum(e.in_other_active)} ${e.in_other_active === 1 ? "is" : "are"} also in another active campaign.` : "");
}

function EnrollFromListDialog({ campaign, tags, onClose }: { campaign: Campaign; tags: Tag[]; onClose: () => void }) {
  const router = useRouter();
  const [choice, setChoice] = useState(tags[0]?.tag ?? "__all");
  const [result, setResult] = useState<{ key: string; data: Enrollable | null; error?: string } | null>(null);
  const [pending, run] = useAction();
  const { confirm, element } = useConfirm();
  const all = choice === "__all";

  // What adding this list would do (a GET route, so nothing changes until you confirm).
  useEffect(() => {
    const ac = new AbortController();
    const qs = all ? "all=1" : `tag=${encodeURIComponent(choice)}`;
    fetch(`/api/campaigns/${campaign.id}/enrollable?${qs}`, { signal: ac.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 401 ? "Your session expired. Sign in again." : "Couldn't count the leads");
        setResult({ key: choice, data: (await r.json()) as Enrollable });
      })
      .catch((err: Error) => { if (err.name !== "AbortError") setResult({ key: choice, data: null, error: err.message }); });
    return () => ac.abort();
  }, [campaign.id, choice, all]);

  const loading = result?.key !== choice;
  const e = loading ? null : result?.data ?? null;
  const willAdd = e?.will_add ?? null;

  const submit = async () => {
    if (all) {
      const n = willAdd ?? e?.total ?? 0;
      const ok = await confirm({
        title: `Add ${fmtNum(n)} leads to ${campaign.name}?`,
        body: "That's every lead you have. Type the number to confirm.",
        confirmLabel: "Add all leads", requireText: String(n),
      });
      if (!ok) return;
    }
    let restart = false;
    if (campaign.status === "completed") {
      restart = await confirm({
        title: `${campaign.name} had finished. Restart it for these ${willAdd != null ? fmtNum(willAdd) + " " : ""}leads?`,
        body: "Restart it to start emailing them now. Cancel still adds them, and the campaign waits, paused, until you resume it.",
        confirmLabel: "Restart it",
      });
    }
    run(() => enrollLeads(campaign.id, all ? { all: true } : { tag: choice }, { restart }), () => { onClose(); router.refresh(); });
  };

  return (
    <Dialog open onClose={onClose} title="Add leads from a list"
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit} disabled={pending || loading || willAdd === 0}>
          {pending && <Spinner />}{willAdd != null ? `Add ${fmtNum(willAdd)} lead${willAdd === 1 ? "" : "s"}` : "Add leads"}
        </Button>
      </>}>
      <div className="grid gap-4">
        <Field label="List">
          <Select value={choice} onChange={(ev) => setChoice(ev.target.value)} data-autofocus="">
            {tags.map((t) => <option key={t.tag} value={t.tag}>{t.tag} ({fmtNum(t.n)})</option>)}
            <option value="__all">All leads</option>
          </Select>
        </Field>
        <div className="rounded-lg bg-panel-2 px-3 py-2.5 text-[13px] min-h-10 flex items-center gap-2">
          {loading ? <><Spinner className="text-faint" /><span className="text-muted">Counting…</span></>
            : result?.error ? <span className="text-bad">{result.error}</span>
              : e ? <span>{summary(e)}</span> : null}
        </div>
        {!tags.length && <p className="text-[12.5px] text-muted">You have no lists yet. Lists are made when you import leads. <Link href="/leads?add=csv" className="text-accent underline">Import leads</Link></p>}
      </div>
      {element}
    </Dialog>
  );
}
