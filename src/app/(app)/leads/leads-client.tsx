"use client";

import { ChevronLeft, ChevronRight, ClipboardList, Download, FileUp, ListPlus, MailPlus, MoreHorizontal, Search, SearchCheck, ShieldCheck, Trash2, Users, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { addLeadsToCampaign, addLeadsToList, deleteLeads, requestEmailCheck } from "@/app/actions/leads";
import { AddLeadsDialog, type AddLeadsTab, type CampaignOption } from "@/components/add-leads";
import { ActionButton, Dialog, Menu, Spinner, useAction, useConfirm } from "@/components/client";
import { LeadDrawer } from "@/components/lead-drawer";
import { Badge, Button, Card, Empty, Field, Input, Select, StatusBadge, Td, Th, buttonClass, cx } from "@/components/ui";
import { fmtDate, fmtNum } from "@/lib/format";
import { verifyLabel } from "@/lib/labels";
import type { Lead } from "@/lib/types";
import { hasLeadFilter, leadFilterParams, type LeadFilter, type LeadSelection } from "./tabs";

type TagCount = { tag: string; n: number };

const CHECK_OPTIONS = [["valid", "Valid"], ["risky", "Risky"], ["invalid", "Invalid"], ["unknown", "Couldn't confirm"], ["unchecked", "Not checked yet"]] as const;
const STATUS_OPTIONS = [["active", "Can be emailed"], ["unsubscribed", "Unsubscribed"], ["bounced", "Bounced"], ["invalid", "Invalid email"], ["blocked", "Blocked"]] as const;

function toggle(set: Set<string>, id: string): Set<string> {
  const n = new Set(set);
  if (n.has(id)) n.delete(id);
  else n.add(id);
  return n;
}

const campaignSuffix = (c: CampaignOption) => (c.status === "draft" ? " (not launched)" : c.status === "completed" ? " (finished)" : "");

/** `/leads?…` with some params changed (empty value = removed). Filter changes always go back to page 1. */
function useLeadsHref() {
  const sp = useSearchParams();
  const pathname = usePathname();
  return (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!("page" in patch)) next.delete("page");
    const qs = next.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };
}

/* ───────────── Filters ───────────── */

export function LeadsFilters({ filter, tags }: { filter: LeadFilter; tags: TagCount[] }) {
  const router = useRouter();
  const href = useLeadsHref();
  const [text, setText] = useState(filter.q ?? "");
  const [pending, start] = useTransition();
  const push = (patch: Record<string, string | null>) => start(() => router.replace(href(patch), { scroll: false }));

  // Debounced search-as-you-type.
  useEffect(() => {
    if (text.trim() === (filter.q ?? "")) return;
    const t = setTimeout(() => push({ q: text.trim() }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const any = hasLeadFilter(filter);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative flex-1 min-w-[200px] max-w-sm">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search name, email, company" className="pl-9" aria-label="Search leads" />
      </div>
      <div className="w-40 lg:hidden">
        <Select value={filter.tag ?? ""} onChange={(e) => push({ tag: e.target.value })} aria-label="List">
          <option value="">All lists</option>
          {filter.tag && !tags.some((t) => t.tag === filter.tag) && <option value={filter.tag}>{filter.tag}</option>}
          {tags.map((t) => <option key={t.tag} value={t.tag}>{t.tag} ({fmtNum(t.n)})</option>)}
        </Select>
      </div>
      <div className="w-40">
        <Select value={filter.check ?? ""} onChange={(e) => push({ check: e.target.value })} aria-label="Email check">
          <option value="">Any email check</option>
          {CHECK_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
      </div>
      <div className="w-40">
        <Select value={filter.status ?? ""} onChange={(e) => push({ status: e.target.value })} aria-label="Status">
          <option value="">Any status</option>
          {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
      </div>
      {pending && <Spinner className="text-faint" />}
      {any && (
        <Button size="sm" variant="ghost" onClick={() => { setText(""); push({ q: null, tag: null, check: null, status: null }); }}>
          <X size={14} />Clear filters
        </Button>
      )}
    </div>
  );
}

/* ───────────── Lists rail (lg+) ───────────── */

export function ListsRail({ tags, total, active, campaigns }: { tags: TagCount[]; total: number; active?: string; campaigns: CampaignOption[] }) {
  const href = useLeadsHref();
  const [picker, setPicker] = useState<TagCount | null>(null);
  const item = (on: boolean) => cx("flex-1 min-w-0 flex items-center gap-2 h-8 px-2.5 rounded-lg text-[13px] transition-colors",
    on ? "bg-accent-soft text-accent font-medium" : "text-muted hover:text-ink hover:bg-panel-2");
  return (
    <nav aria-label="Lists" className="hidden lg:grid gap-0.5 content-start sticky top-6">
      <div className="px-2.5 pb-1.5 text-[11.5px] font-medium uppercase tracking-[0.08em] text-faint">Lists</div>
      <Link href={href({ tag: null, lead: null })} scroll={false} className={item(!active)} aria-current={!active ? "page" : undefined}>
        <span className="truncate flex-1">All leads</span><span className="tabular-nums text-[12px] opacity-80">{fmtNum(total)}</span>
      </Link>
      {tags.map((t) => (
        <div key={t.tag} className="group flex items-center gap-0.5">
          <Link href={href({ tag: t.tag, lead: null })} scroll={false} className={item(active === t.tag)} aria-current={active === t.tag ? "page" : undefined} title={t.tag}>
            <span className="truncate flex-1">{t.tag}</span><span className="tabular-nums text-[12px] opacity-80">{fmtNum(t.n)}</span>
          </Link>
          <Menu align="end"
            trigger={<button type="button" aria-label={`Actions for list ${t.tag}`} className={buttonClass("ghost", "sm", "w-7 h-7 px-0 opacity-60 group-hover:opacity-100 focus-visible:opacity-100")}><MoreHorizontal size={15} /></button>}
            items={[
              { label: "Start a campaign with this list", icon: <MailPlus />, href: `/campaigns?new=1&list=${encodeURIComponent(t.tag)}` },
              { label: "Add to campaign…", icon: <ListPlus />, onSelect: () => setPicker(t), disabled: !campaigns.length },
            ]} />
        </div>
      ))}
      {!tags.length && <p className="px-2.5 pt-1 text-[12px] text-faint">Lists you import or create show up here.</p>}
      {picker && (
        <AddToCampaignDialog selection={{ filter: { tag: picker.tag } }} count={picker.n} campaigns={campaigns}
          what={`the list “${picker.tag}”`} onClose={() => setPicker(null)} />
      )}
    </nav>
  );
}

/* ───────────── Table ───────────── */

export function LeadsTable({
  leads, total, page, pageSize, filter, checking, unchecked, campaigns, tags,
}: {
  leads: Lead[];
  total: number;
  page: number;
  pageSize: number;
  filter: LeadFilter;
  /** Sending is on, so unchecked emails are being checked in the background. */
  checking: boolean;
  unchecked: number;
  campaigns: CampaignOption[];
  tags: TagCount[];
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [dialog, setDialog] = useState<"campaign" | "list" | null>(null);
  const [addTab, setAddTab] = useState<AddLeadsTab | null>(null);
  const router = useRouter();
  const href = useLeadsHref();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const pageAll = leads.length > 0 && leads.every((l) => selected.has(l.id));
  const filtered = hasLeadFilter(filter);

  if (!leads.length) {
    if (!filtered) {
      return (
        <Card>
          <Empty icon={<Users size={28} />} title="No leads yet">
            Upload a CSV from Apollo, Sales Navigator or a spreadsheet (an email column is enough; name, company and website make AI emails better).
          </Empty>
          <div className="grid sm:grid-cols-3 gap-3 px-4 pb-6 -mt-6 max-w-2xl mx-auto">
            <Tile primary icon={<FileUp size={18} />} title="Upload CSV" sub="Map columns, pick a list" onClick={() => setAddTab("csv")} />
            <Tile icon={<ClipboardList size={18} />} title="Paste a list" sub="Emails, or Name, email, company" onClick={() => setAddTab("paste")} />
            <Tile icon={<SearchCheck size={18} />} title="Find someone's email" sub="From a name and a website" href="/leads/find" />
          </div>
          {addTab && <AddLeadsDialog campaigns={campaigns} defaultTab={addTab} onClose={() => setAddTab(null)} />}
        </Card>
      );
    }
    return (
      <Card>
        <Empty icon={<Search size={26} />} title="No leads match these filters"
          action={<Button onClick={() => router.replace(href({ q: null, tag: null, check: null, status: null }), { scroll: false })}><X size={14} />Clear filters</Button>} />
      </Card>
    );
  }

  const selection: LeadSelection = allMatching ? { filter } : { ids: [...selected] };
  const count = allMatching ? total : selected.size;
  const exportHref = `/api/leads/export?${allMatching ? leadFilterParams(filter).toString() : new URLSearchParams({ ids: [...selected].join(",") }).toString()}`;
  const clear = () => { setSelected(new Set()); setAllMatching(false); };
  const goto = (p: number) => router.push(href({ page: p > 1 ? String(p) : null }), { scroll: false });
  const openLead = (id: string) => {
    // Opens the drawer without a server round trip; the URL (?lead=) still links to it.
    const next = new URLSearchParams(window.location.search);
    next.set("lead", id);
    window.history.pushState(null, "", `?${next.toString()}`);
  };

  return (
    <Card className="overflow-hidden">
      {count > 0 ? (
        <div className="border-b border-line bg-accent-soft/60 fade-in">
          <div className="flex flex-wrap items-center gap-2 px-3 py-2">
            <span className="text-[13px] font-medium mr-auto tabular-nums">{fmtNum(count)} selected</span>
            <Button size="sm" onClick={() => setDialog("campaign")} disabled={!campaigns.length} title={campaigns.length ? undefined : "Create a campaign first"}>
              <MailPlus size={14} />Add to campaign
            </Button>
            <Button size="sm" onClick={() => setDialog("list")}><ListPlus size={14} />Add to list</Button>
            <ActionButton size="sm" action={async () => { const r = await requestEmailCheck(selection); if (r.ok) clear(); return r; }}>
              <ShieldCheck size={14} />Check emails
            </ActionButton>
            <a href={exportHref} download className={buttonClass("secondary", "sm")}><Download size={14} />Export CSV</a>
            <ActionButton size="sm" variant="danger"
              confirm={{ title: `Delete ${fmtNum(count)} lead${count === 1 ? "" : "s"}?`, body: "They are also removed from campaigns. This can't be undone.", confirmLabel: "Delete" }}
              action={async () => {
                const r = await deleteLeads(selection);
                if (r.ok) {
                  const emptied = allMatching || leads.every((l) => selected.has(l.id));
                  clear();
                  // The page would be empty: step back one (the server would redirect anyway).
                  if (emptied && page > 1) router.replace(href({ page: allMatching || page - 1 <= 1 ? null : String(page - 1) }), { scroll: false });
                }
                return r;
              }}><Trash2 size={14} />Delete</ActionButton>
          </div>
          {pageAll && total > leads.length && (
            <div className="px-3 pb-2 text-[12.5px] text-muted">
              {allMatching ? (
                <>All {fmtNum(total)} matching leads are selected. <button type="button" className="text-accent font-medium hover:underline" onClick={clear}>Clear selection</button></>
              ) : (
                <>All {fmtNum(leads.length)} on this page selected. <button type="button" className="text-accent font-medium hover:underline" onClick={() => setAllMatching(true)}>Select all {fmtNum(total)} matching</button></>
              )}
            </div>
          )}
        </div>
      ) : unchecked > 0 ? (
        <div className="flex items-center gap-2 px-3 h-10 border-b border-line text-[12.5px] text-muted">
          {checking ? <Spinner className="size-3 text-faint" /> : <ShieldCheck size={14} className="text-faint" />}
          {checking ? `Checking ${fmtNum(unchecked)} email${unchecked === 1 ? "" : "s"} in the background` : `${fmtNum(unchecked)} email${unchecked === 1 ? "" : "s"} will be checked when sending is on`}
        </div>
      ) : null}
      <div className="relative overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead className="bg-panel-2/50">
            <tr>
              <Th className="w-10">
                <input type="checkbox" checked={pageAll} aria-label="Select all on this page" className="accent-[var(--accent)]"
                  onChange={() => { setAllMatching(false); setSelected(pageAll ? new Set() : new Set(leads.map((l) => l.id))); }} />
              </Th>
              <Th>Name</Th><Th>Email</Th><Th>Company</Th><Th>Email check</Th><Th>Lists</Th><Th>Added</Th>
            </tr>
          </thead>
          <tbody>
            {leads.map((l) => {
              const name = [l.first_name, l.last_name].filter(Boolean).join(" ");
              return (
                <tr key={l.id} tabIndex={0} onClick={() => openLead(l.id)}
                  onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) openLead(l.id); }}
                  className={cx("cursor-pointer hover:bg-panel-2/60 transition-colors outline-none focus-visible:bg-panel-2", selected.has(l.id) && "bg-accent-soft/40")}>
                  <Td onClick={(e) => e.stopPropagation()} className="cursor-default">
                    <input type="checkbox" checked={allMatching || selected.has(l.id)} aria-label={`Select ${l.email}`} className="accent-[var(--accent)]"
                      onChange={() => { setAllMatching(false); setSelected((s) => toggle(s, l.id)); }} />
                  </Td>
                  <Td className="font-medium whitespace-nowrap max-w-[200px] truncate">{name || <span className="text-faint font-normal">—</span>}</Td>
                  <Td className="max-w-[240px] truncate">{l.email}</Td>
                  <Td className="max-w-[180px] truncate">{l.company || <span className="text-faint">—</span>}</Td>
                  <Td className="whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5">
                      {l.verify_status ? <StatusBadge status={l.verify_status} kind="verify" /> : <span className="text-faint text-[12px]">{verifyLabel(null, checking)}</span>}
                      {l.status !== "active" && <StatusBadge status={l.status} kind="lead" />}
                    </span>
                  </Td>
                  <Td><div className="flex gap-1 flex-wrap max-w-[220px]">{l.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div></Td>
                  <Td className="whitespace-nowrap text-muted tabular-nums">{fmtDate(l.created_at)}</Td>
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
            <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => goto(page - 1)} aria-label="Previous page"><ChevronLeft size={15} /></Button>
            <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => goto(page + 1)} aria-label="Next page"><ChevronRight size={15} /></Button>
          </div>
        )}
      </div>
      {dialog === "campaign" && (
        <AddToCampaignDialog selection={selection} count={count} campaigns={campaigns} onClose={() => setDialog(null)} onDone={clear} />
      )}
      {dialog === "list" && <AddToListDialog selection={selection} count={count} tags={tags} onClose={() => setDialog(null)} onDone={clear} />}
    </Card>
  );
}

function Tile({ icon, title, sub, onClick, href, primary }: { icon: React.ReactNode; title: string; sub: string; onClick?: () => void; href?: string; primary?: boolean }) {
  const cls = cx("flex flex-col items-start gap-1.5 rounded-xl border p-3.5 text-left transition-colors",
    primary ? "border-accent/40 bg-accent-soft/60 hover:bg-accent-soft" : "border-line hover:bg-panel-2");
  const inner = <>
    <span className={primary ? "text-accent" : "text-muted"}>{icon}</span>
    <span className="text-[13.5px] font-medium">{title}</span>
    <span className="text-[12px] text-muted">{sub}</span>
  </>;
  return href ? <Link href={href} className={cls}>{inner}</Link> : <button type="button" onClick={onClick} className={cls}>{inner}</button>;
}

/* ───────────── Bulk dialogs ───────────── */

function AddToCampaignDialog({ selection, count, campaigns, what, onClose, onDone }: {
  selection: LeadSelection; count: number; campaigns: CampaignOption[]; what?: string; onClose: () => void; onDone?: () => void;
}) {
  const [id, setId] = useState(campaigns.find((c) => c.status !== "completed")?.id ?? campaigns[0]?.id ?? "");
  const [pending, run] = useAction();
  const { confirm, element } = useConfirm();
  const c = campaigns.find((x) => x.id === id);

  const submit = async () => {
    if (!c) return;
    const restart = c.status === "completed" && await confirm({
      title: `${c.name} had finished. Restart it for these leads?`,
      body: "Restart it to start emailing them now. Cancel still adds them, and the campaign waits, paused, until you resume it.",
      confirmLabel: "Restart it",
    });
    run(() => addLeadsToCampaign(c.id, selection, { restart }), () => { onDone?.(); onClose(); });
  };

  return (
    <>
      <Dialog open onClose={onClose} title="Add to campaign"
        description={`${what ? `${what[0].toUpperCase()}${what.slice(1)}` : `${fmtNum(count)} lead${count === 1 ? "" : "s"}`}${what ? ` (${fmtNum(count)} lead${count === 1 ? "" : "s"})` : ""}. Blocked, bounced and invalid leads, and anyone already in the campaign, are skipped.`}
        footer={<>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={pending || !c}>{pending && <Spinner />}Add {fmtNum(count)} to campaign</Button>
        </>}>
        <Field label="Campaign">
          <Select value={id} onChange={(e) => setId(e.target.value)}>
            {campaigns.map((x) => <option key={x.id} value={x.id}>{x.name}{campaignSuffix(x)}</option>)}
          </Select>
        </Field>
      </Dialog>
      {/* Outside the dialog: a nested <dialog>'s close event would also close this one. */}
      {element}
    </>
  );
}

function AddToListDialog({ selection, count, tags, onClose, onDone }: { selection: LeadSelection; count: number; tags: TagCount[]; onClose: () => void; onDone?: () => void }) {
  const [tag, setTag] = useState("");
  const [pending, run] = useAction();
  const submit = () => run(() => addLeadsToList(selection, tag), () => { onDone?.(); onClose(); });
  return (
    <Dialog open onClose={onClose} title={`Add ${fmtNum(count)} lead${count === 1 ? "" : "s"} to a list`}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={pending || !tag.trim()} onClick={submit}>{pending && <Spinner />}Add to list</Button>
      </>}>
      <form onSubmit={(e) => { e.preventDefault(); if (tag.trim()) submit(); }}>
        <Field label="List name" hint="Pick an existing list or type a new name.">
          <Input value={tag} onChange={(e) => setTag(e.target.value)} list="lead-lists" placeholder="e.g. saas-founders-oct" data-autofocus="" />
        </Field>
        <datalist id="lead-lists">{tags.map((t) => <option key={t.tag} value={t.tag} />)}</datalist>
      </form>
    </Dialog>
  );
}

/* ───────────── Drawer (?lead=) ───────────── */

/** Opens the lead drawer for `?lead=`; closing it drops the param without a server round trip. */
export function LeadDrawerHost({ campaigns, checking }: { campaigns: CampaignOption[]; checking: boolean }) {
  const sp = useSearchParams();
  const leadId = sp.get("lead");
  const close = () => {
    const next = new URLSearchParams(window.location.search);
    next.delete("lead");
    const qs = next.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  };
  return <LeadDrawer leadId={leadId} onClose={close} campaigns={campaigns} checking={checking} />;
}
