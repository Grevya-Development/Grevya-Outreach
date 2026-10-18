"use client";

import { Copy, MailPlus, MoreHorizontal, Reply, Send, ShieldBan, ShieldCheck, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { addLeadsToCampaign, addLeadsToList, deleteLeads, removeLeadFromCampaign, removeLeadFromList, requestEmailCheck, updateLead } from "@/app/actions/leads";
import { addSuppression } from "@/app/actions/misc";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { campaignLeadStatus, CAMPAIGN_STATUS_LABEL, REPLY_KIND_LABEL, replyLabel, verifyLabel, verifyTone } from "@/lib/labels";
import type { Lead } from "@/lib/types";
import { Drawer, Menu, Spinner, useAction, useConfirm, type ActionResult } from "./client";
import { Badge, Button, ButtonLink, Field, Input, Select, Skeleton, StatusBadge, Textarea, cx } from "./ui";

type CampaignOption = { id: string; name: string; status?: string };

type Enrolment = {
  id: string; status: string; current_step: number; next_send_at: string | null; prep_status: string | null;
  skip_reason: string | null; last_error: string | null; created_at: string;
  campaign: { id: string; name: string; status: string; mode: string } | null;
};
type Sent = { id: string; sent_at: string; subject: string; step_number: number; status: string; kind: string | null; campaign_id: string | null };
type Received = { id: string; received_at: string; subject: string; snippet: string; kind: string; sentiment: string | null; campaign_id: string | null };
type DrawerData = { lead: Lead; campaigns: Enrolment[]; steps: Record<string, number>; messages: Sent[]; replies: Received[] };

type Load = { kind: "loading" } | { kind: "ok"; data: DrawerData } | { kind: "missing" } | { kind: "error"; message: string };

const DETAILS = [
  ["first_name", "First name"], ["last_name", "Last name"], ["company", "Company"], ["title", "Job title"],
  ["website", "Website"], ["linkedin", "LinkedIn"],
] as const;
type EditKey = (typeof DETAILS)[number][0] | "notes";

/**
 * Lead details in a right-side sheet: edit fields, lists, campaigns and activity. Data comes from
 * GET /api/leads/{id}; after each change it's fetched again.
 */
export function LeadDrawer({ leadId, onClose, campaigns = [], checking = false }: {
  leadId: string | null;
  onClose: () => void;
  campaigns?: CampaignOption[];
  /** Sending is on, so an unchecked email shows "Checking…". */
  checking?: boolean;
}) {
  if (!leadId) return null;
  return <LeadSheet key={leadId} leadId={leadId} onClose={onClose} campaigns={campaigns} checking={checking} />;
}

function LeadSheet({ leadId, onClose, campaigns, checking }: { leadId: string; onClose: () => void; campaigns: CampaignOption[]; checking: boolean }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [version, setVersion] = useState(0);
  const [edits, setEdits] = useState<Partial<Record<EditKey, string>>>({});
  const [newList, setNewList] = useState("");
  const [target, setTarget] = useState("");
  const [pending, run] = useAction();
  const { confirm, element: confirmElement } = useConfirm();
  const reload = () => setVersion((v) => v + 1);

  useEffect(() => {
    const ac = new AbortController();
    fetch(`/api/leads/${leadId}`, { signal: ac.signal, cache: "no-store" })
      .then(async (r) => {
        if (r.status === 404) return setLoad({ kind: "missing" });
        if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error || "Couldn't load this lead");
        setLoad({ kind: "ok", data: (await r.json()) as DrawerData });
      })
      .catch((err: Error) => { if (!ac.signal.aborted) setLoad({ kind: "error", message: err.message }); });
    return () => ac.abort();
  }, [leadId, version]);

  /** Runs a write, then fetches the drawer again. */
  const write = (fn: () => Promise<ActionResult>, after?: () => void) => run(async () => {
    const r = await fn();
    if (r.ok) { after?.(); reload(); }
    return r;
  });

  if (load.kind !== "ok") {
    return (
      <Drawer open onClose={onClose} title={load.kind === "missing" ? "Lead not found" : "Lead"}
        footer={load.kind !== "loading" && <Button onClick={onClose}>Close</Button>}>
        {load.kind === "loading" && <div className="grid gap-3"><Skeleton className="h-6 w-2/3" /><Skeleton className="h-4 w-1/2" /><Skeleton className="h-40" /><Skeleton className="h-24" /></div>}
        {load.kind === "missing" && <p className="text-[13.5px] text-muted">This lead was deleted.</p>}
        {load.kind === "error" && (
          <div className="grid gap-3 justify-items-start">
            <p className="text-[13.5px] text-muted">{load.message}</p>
            <Button size="sm" onClick={reload}>Try again</Button>
          </div>
        )}
      </Drawer>
    );
  }

  const { lead, campaigns: enrolments, steps, messages, replies } = load.data;
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ");
  const value = (k: EditKey) => edits[k] ?? String(lead[k] ?? "");
  const dirty = (Object.keys(edits) as EditKey[]).some((k) => edits[k] !== String(lead[k] ?? ""));
  const inCampaign = new Set(enrolments.map((e) => e.campaign?.id).filter(Boolean));
  const available = campaigns.filter((c) => !inCampaign.has(c.id));
  const save = () => write(() => updateLead(lead.id, edits), () => setEdits({}));

  const activity: { at: string; key: string; sent?: Sent; reply?: Received }[] = [
    ...messages.map((m) => ({ at: m.sent_at, key: `m${m.id}`, sent: m })),
    ...replies.map((r) => ({ at: r.received_at, key: `r${r.id}`, reply: r })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));
  const campaignName = (id: string | null) => enrolments.find((e) => e.campaign?.id === id)?.campaign?.name;

  const addToCampaign = async () => {
    const c = campaigns.find((x) => x.id === target);
    if (!c) return;
    const restart = c.status === "completed" && await confirm({
      title: `${c.name} had finished. Restart it for this lead?`,
      body: "Restart it to start emailing now. Cancel still adds the lead, and the campaign waits, paused, until you resume it.",
      confirmLabel: "Restart it",
    });
    write(() => addLeadsToCampaign(c.id, { ids: [lead.id] }, { restart }), () => setTarget(""));
  };
  const block = async () => {
    if (!(await confirm({
      title: `Block ${lead.email}?`,
      body: "They're added to your block list and never emailed again by any campaign.",
      confirmLabel: "Block", tone: "danger",
    }))) return;
    write(() => addSuppression(lead.email));
  };
  const remove = async () => {
    if (!(await confirm({
      title: "Delete this lead?",
      body: "They're also removed from every campaign. Sent emails and replies stay in your inbox.",
      confirmLabel: "Delete lead", tone: "danger",
    }))) return;
    run(async () => {
      const r = await deleteLeads({ ids: [lead.id] });
      if (r.ok) onClose();
      return r;
    });
  };

  return (
    <>
      <Drawer open onClose={onClose} title={name || lead.email}
        footer={<>
          <Menu align="start" className="mr-auto"
            trigger={<Button variant="ghost" aria-label="More actions"><MoreHorizontal size={16} />More</Button>}
            items={[
              { label: "Check email again", icon: <ShieldCheck />, onSelect: () => write(() => requestEmailCheck({ ids: [lead.id] })) },
              { label: "Block", icon: <ShieldBan />, onSelect: () => void block(), hidden: lead.status === "blocked" || lead.status === "unsubscribed" },
              { label: "Delete lead", icon: <Trash2 />, tone: "danger", onSelect: () => void remove() },
            ]} />
          <ButtonLink href={`/inbox?compose=1&to=${encodeURIComponent(lead.email)}`}><Send size={15} />Send email</ButtonLink>
          {dirty && <Button variant="primary" onClick={save} disabled={pending}>{pending && <Spinner />}Save</Button>}
        </>}>
        <div className="grid gap-6">
          {/* Header */}
          <div className="grid gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-[13.5px] font-medium truncate">{lead.email}</span>
              <button type="button" className="text-muted hover:text-ink shrink-0" aria-label="Copy email"
                onClick={() => { navigator.clipboard.writeText(lead.email).then(() => toast.success("Email copied"), () => toast.error("Couldn't copy")); }}>
                <Copy size={14} />
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={verifyTone(lead.verify_status)} dot>{verifyLabel(lead.verify_status, checking)}</Badge>
              <StatusBadge status={lead.status} kind="lead" />
              <span className="text-[12px] text-faint">Added {fmtDate(lead.created_at, { year: true })}</span>
            </div>
          </div>

          {/* Details */}
          <section className="grid gap-3">
            <h3 className="text-[13px] font-semibold">Details</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {DETAILS.map(([k, label]) => (
                <Field key={k} label={label}>
                  <Input value={value(k)} onChange={(e) => setEdits((p) => ({ ...p, [k]: e.target.value }))} />
                </Field>
              ))}
              <Field label="Notes" hint="The AI reads these when it writes to this lead." className="sm:col-span-2">
                <Textarea rows={3} value={value("notes")} onChange={(e) => setEdits((p) => ({ ...p, notes: e.target.value }))} />
              </Field>
            </div>
            {dirty && (
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setEdits({})} disabled={pending}>Discard</Button>
                <Button size="sm" variant="primary" onClick={save} disabled={pending}>{pending && <Spinner />}Save</Button>
              </div>
            )}
          </section>

          {/* Lists */}
          <section className="grid gap-2.5">
            <h3 className="text-[13px] font-semibold">Lists</h3>
            {lead.tags.length ? (
              <div className="flex flex-wrap gap-1.5">
                {lead.tags.map((t) => (
                  <span key={t} className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-md bg-panel-2 text-[12px] font-medium">
                    <Link href={`/leads?tag=${encodeURIComponent(t)}`} className="hover:underline" onClick={onClose}>{t}</Link>
                    <button type="button" aria-label={`Remove from list ${t}`} disabled={pending}
                      className="grid place-items-center size-4 rounded text-muted hover:text-ink hover:bg-line"
                      onClick={() => write(() => removeLeadFromList(lead.id, t))}><X size={12} /></button>
                  </span>
                ))}
              </div>
            ) : <p className="text-[12.5px] text-muted">Not in any list.</p>}
            <form className="flex gap-2" onSubmit={(e) => {
              e.preventDefault();
              if (newList.trim()) write(() => addLeadsToList({ ids: [lead.id] }, newList), () => setNewList(""));
            }}>
              <Input value={newList} onChange={(e) => setNewList(e.target.value)} placeholder="Add to a list…" className="h-8 text-[13px]" aria-label="List name" />
              <Button size="sm" type="submit" disabled={pending || !newList.trim()}>Add</Button>
            </form>
          </section>

          {/* Campaigns */}
          <section className="grid gap-2.5">
            <h3 className="text-[13px] font-semibold">Campaigns</h3>
            {enrolments.length ? (
              <div className="rounded-lg border border-line divide-y divide-line">
                {enrolments.map((e) => {
                  const c = e.campaign;
                  const s = campaignLeadStatus(
                    { status: e.status, current_step: e.current_step, prep_status: e.prep_status, next_send_at: e.next_send_at, skip_reason: e.skip_reason, last_error: e.last_error },
                    { mode: c?.mode ?? "template", totalSteps: c ? steps[c.id] ?? 0 : 0, campaignStatus: c?.status ?? "active" },
                  );
                  return (
                    <div key={e.id} className="flex items-start gap-3 px-3 py-2.5">
                      <div className="min-w-0 flex-1 grid gap-1">
                        {c ? (
                          <Link href={`/campaigns/${c.id}${c.status === "draft" ? "?step=leads" : "?tab=leads"}`} className="text-[13px] font-medium truncate hover:underline" onClick={onClose}>
                            {c.name}
                          </Link>
                        ) : <span className="text-[13px] text-muted">Deleted campaign</span>}
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge tone={s.tone} dot>{s.label}</Badge>
                          {c && c.status !== "active" && <span className="text-[11.5px] text-faint">Campaign {CAMPAIGN_STATUS_LABEL[c.status]?.toLowerCase() ?? c.status}</span>}
                        </div>
                        {s.detail && <p className="text-[12px] text-muted line-clamp-2">{s.detail}</p>}
                      </div>
                      <Button size="sm" variant="ghost" disabled={pending} onClick={async () => {
                        if (await confirm({ title: `Remove from ${c?.name ?? "this campaign"}?`, body: "No more emails from this campaign go to this lead.", confirmLabel: "Remove", tone: "danger" })) {
                          write(() => removeLeadFromCampaign(e.id));
                        }
                      }}>Remove</Button>
                    </div>
                  );
                })}
              </div>
            ) : <p className="text-[12.5px] text-muted">Not in any campaign yet.</p>}
            {available.length > 0 && (
              <div className="flex gap-2">
                <Select value={target} onChange={(e) => setTarget(e.target.value)} className="h-8 text-[13px]" aria-label="Campaign to add this lead to">
                  <option value="">Add to campaign…</option>
                  {available.map((c) => <option key={c.id} value={c.id}>{c.name}{c.status === "draft" ? " (not launched)" : c.status === "completed" ? " (finished)" : ""}</option>)}
                </Select>
                <Button size="sm" disabled={pending || !target} onClick={() => void addToCampaign()}><MailPlus size={14} />Add</Button>
              </div>
            )}
          </section>

          {/* Activity */}
          <section className="grid gap-2.5">
            <h3 className="text-[13px] font-semibold">Activity</h3>
            {activity.length ? (
              <ol className="grid gap-0.5">
                {activity.map((a) => {
                  if (a.sent) {
                    const m = a.sent;
                    const what = m.kind === "manual" ? "Email you sent" : `Email ${m.step_number} sent`;
                    const camp = campaignName(m.campaign_id);
                    return (
                      <li key={a.key} className="flex items-start gap-2.5 rounded-lg px-2 py-2">
                        <Send size={14} className="text-faint mt-0.5 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
                            <span className="font-medium">{what}</span>
                            {camp && <span className="text-muted truncate">· {camp}</span>}
                            {m.status !== "sent" && <Badge tone="bad">{m.status === "bounced" ? "Bounced" : "Couldn't send"}</Badge>}
                          </div>
                          <div className="text-[12.5px] text-muted truncate">{m.subject}</div>
                        </div>
                        <span className="text-[11.5px] text-faint whitespace-nowrap">{fmtDateTime(m.sent_at)}</span>
                      </li>
                    );
                  }
                  const r = a.reply!;
                  const label = replyLabel(r.sentiment);
                  return (
                    <li key={a.key}>
                      <Link href={`/inbox?id=${r.id}`} onClick={onClose} className="flex items-start gap-2.5 rounded-lg px-2 py-2 hover:bg-panel-2">
                        <Reply size={14} className={cx("mt-0.5 shrink-0", r.kind === "reply" ? "text-accent" : "text-faint")} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
                            <span className="font-medium">{r.kind === "reply" ? "Replied" : REPLY_KIND_LABEL[r.kind] ?? "Reply"}</span>
                            {label && <Badge tone={label.tone}>{label.label}</Badge>}
                          </div>
                          <div className="text-[12.5px] text-muted truncate">{r.snippet || r.subject}</div>
                        </div>
                        <span className="text-[11.5px] text-faint whitespace-nowrap">{fmtDateTime(r.received_at)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ol>
            ) : <p className="text-[12.5px] text-muted">No emails sent or received yet.</p>}
          </section>
        </div>
      </Drawer>
      {/* Outside the drawer: a nested <dialog>'s close event would also close the drawer. */}
      {confirmElement}
    </>
  );
}
