import { Plus, Search, Send, X } from "lucide-react";
import Form from "next/form";
import Link from "next/link";
import { Suspense } from "react";
import { Badge, Button, ButtonLink, Card, Empty, Input, PageHeader, Progress, Skeleton, StatusBadge, TableSkeleton, Td, Th, cx, pct } from "@/components/ui";
import { APP_TZ, fmtNum } from "@/lib/format";
import { db, isMissingRpc, must } from "@/lib/supabase";
import type { Campaign, CampaignStats } from "@/lib/types";
import { FilterChip } from "./[id]/campaign-client";
import { CampaignRowActions } from "./campaign-row";
import { NewCampaignButton } from "./new-campaign";

export const metadata = { title: "Campaigns" };

type SP = PageProps<"/campaigns">["searchParams"];
const STATUSES = [["all", "All"], ["active", "Active"], ["paused", "Paused"], ["draft", "Draft"], ["completed", "Completed"]] as const;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function parse(sp: Awaited<SP>) {
  const q = (first(sp.q) ?? "").trim().slice(0, 100);
  const s = first(sp.status) ?? "all";
  return { q, status: STATUSES.some(([k]) => k === s) ? s : "all" };
}

function listHref(q: string, status: string) {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  if (status !== "all") p.set("status", status);
  const qs = p.toString();
  return qs ? `/campaigns?${qs}` : "/campaigns";
}

export default function CampaignsPage({ searchParams }: PageProps<"/campaigns">) {
  return (
    <>
      <PageHeader title="Campaigns" description="Short sequences of emails to a list of leads. They stop when someone replies."
        actions={<Suspense fallback={<Button variant="primary" disabled><Plus size={15} />New campaign</Button>}><NewCampaignData searchParams={searchParams} /></Suspense>} />
      <Suspense fallback={<div className="grid gap-3"><Skeleton className="h-9 max-w-xl" /><TableSkeleton rows={5} /></div>}>
        <CampaignList searchParams={searchParams} />
      </Suspense>
    </>
  );
}

/** `?new=1` opens the dialog straight away; `&list=` adds that list's leads to the new campaign. */
async function NewCampaignData({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const list = (first(sp.list) ?? "").trim().slice(0, 80) || undefined;
  const open = first(sp.new) === "1";
  return <NewCampaignButton key={`${open}:${list ?? ""}`} defaultOpen={open} list={list} />;
}

type Extras = { campaign_id: string; sent_today: number; interested: number; meetings: number };

async function CampaignList({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const { q, status } = parse(sp);
  const supa = db();
  const [campaigns, stats, extrasRes] = await Promise.all([
    supa.from("campaigns").select("id, name, status, mode, created_at").order("created_at", { ascending: false }).then(must) as Promise<Pick<Campaign, "id" | "name" | "status" | "mode" | "created_at">[]>,
    supa.rpc("campaign_stats").then(must) as Promise<CampaignStats[]>,
    supa.rpc("campaign_list_extras", { p_tz: APP_TZ }),
  ]);
  // Before migration 0004 there's no Sent today / Interested: those columns are left out.
  if (extrasRes.error && !isMissingRpc(extrasRes.error)) throw new Error(extrasRes.error.message);
  const extras = extrasRes.error ? null : new Map((extrasRes.data as Extras[]).map((e) => [e.campaign_id, e]));
  const byId = new Map(stats.map((s) => [s.campaign_id, s]));

  if (!campaigns.length) {
    return (
      <Card>
        <Empty icon={<Send size={28} />} title="No campaigns yet" action={<NewCampaignButton />}
          secondary={<Link href="/leads?add=csv" className="text-accent hover:underline">Import leads first</Link>}>
          A campaign sends a short sequence of emails to a list of leads and stops when they reply.
        </Empty>
      </Card>
    );
  }

  const counts: Record<string, number> = { all: campaigns.length };
  for (const c of campaigns) counts[c.status] = (counts[c.status] ?? 0) + 1;
  const needle = q.toLowerCase();
  const shown = campaigns.filter((c) => (status === "all" || c.status === status) && (!needle || c.name.toLowerCase().includes(needle)));

  return (
    <div className="grid gap-3 min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <Form action="/campaigns" key={q} className="relative flex-1 min-w-[200px] max-w-sm">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <Input name="q" defaultValue={q} placeholder="Search campaigns" aria-label="Search campaigns" className="pl-9" />
          {status !== "all" && <input type="hidden" name="status" value={status} />}
        </Form>
        <div className="flex flex-wrap gap-1.5">
          {STATUSES.map(([k, label]) => (
            <FilterChip key={k} href={listHref(q, k)} active={status === k}>{label} <span className="opacity-70">{fmtNum(counts[k] ?? 0)}</span></FilterChip>
          ))}
        </div>
      </div>

      {!shown.length ? (
        <Card>
          <Empty icon={<Search size={26} />} title="No campaigns match" action={<ButtonLink href="/campaigns"><X size={14} />Clear filters</ButtonLink>} />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="bg-panel-2/50">
                <tr>
                  <Th>Campaign</Th><Th>Status</Th><Th className="text-right">Leads</Th>
                  {extras && <Th className="text-right">Sent today</Th>}
                  <Th className="text-right">Sent</Th><Th className="text-right">Replies</Th>
                  {extras && <Th className="text-right">Interested</Th>}
                  <Th className="text-right">Bounced</Th><Th className="min-w-[150px]">Progress</Th><Th className="w-20"><span className="sr-only">Actions</span></Th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => {
                  const s = byId.get(c.id);
                  const x = extras?.get(c.id);
                  const leads = Number(s?.leads ?? 0);
                  const sent = Number(s?.sent ?? 0);
                  const replied = Number(s?.replied ?? 0);
                  const bounced = Number(s?.bounced ?? 0);
                  const remaining = Number(s?.remaining ?? 0);
                  const finished = Math.max(0, leads - remaining);
                  const href = c.status === "draft" ? `/campaigns/${c.id}?step=leads` : `/campaigns/${c.id}`;
                  // Every cell is a link with the header's padding, so the whole row is clickable and lines up.
                  const cell = (content: React.ReactNode, className?: string) => (
                    <Td className={cx("p-0", className)}><Link href={href} className="block px-3 py-2.5" tabIndex={-1}>{content}</Link></Td>
                  );
                  return (
                    <tr key={c.id} className="hover:bg-panel-2/60 transition-colors">
                      <Td className="p-0 max-w-[320px]">
                        <Link href={href} className="flex items-center gap-2 px-3 py-2.5 min-w-0 font-medium">
                          <span className="truncate">{c.name}</span>
                          <Badge tone={c.mode === "ai" ? "accent" : "neutral"} className="shrink-0">{c.mode === "ai" ? "AI-written" : "Template"}</Badge>
                        </Link>
                      </Td>
                      {cell(<StatusBadge status={c.status} kind="campaign" />)}
                      {cell(fmtNum(leads), "text-right tabular-nums")}
                      {extras && cell(fmtNum(Number(x?.sent_today ?? 0)), "text-right tabular-nums")}
                      {cell(fmtNum(sent), "text-right tabular-nums")}
                      {cell(<>{fmtNum(replied)}{sent > 0 && <span className="text-faint"> · {pct(replied, Math.min(leads, sent) || sent)}</span>}</>, "text-right tabular-nums whitespace-nowrap")}
                      {extras && cell(fmtNum(Number(x?.interested ?? 0)), "text-right tabular-nums")}
                      {cell(sent > 0 ? pct(bounced, sent) : <span className="text-faint">—</span>, cx("text-right tabular-nums", sent > 20 && bounced / sent > 0.03 && "text-bad"))}
                      {cell(
                        <span className="grid gap-1">
                          <Progress value={finished} max={leads} />
                          <span className="text-[11.5px] text-muted tabular-nums">{fmtNum(finished)} of {fmtNum(leads)} finished</span>
                        </span>,
                      )}
                      <Td className="py-1.5"><CampaignRowActions id={c.id} name={c.name} status={c.status} unsentLeads={remaining} /></Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
