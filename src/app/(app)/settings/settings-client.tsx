"use client";

import { ArrowRight, Globe, Plus, Search, ShieldCheck, Sparkles, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { useMemo, useState } from "react";
import { rewriteLeads } from "@/app/actions/campaigns";
import { addSuppression, importProfile, removeSuppression, saveProfile, testGroq, type AffectedCampaign } from "@/app/actions/misc";
import { ActionButton, Dialog, RelativeTime, Spinner, useAction } from "@/components/client";
import { Badge, Button, Card, CardHeader, cx, Empty, Input, TabLinks, Td, Textarea, Th } from "@/components/ui";
import { fmtNum } from "@/lib/format";
import { blockReasonLabel } from "@/lib/labels";
import type { CompanyProfile } from "@/lib/research";

// ───────────────────────── sub-nav ─────────────────────────

const TABS = [
  { href: "/settings", label: "Company profile" },
  { href: "/settings/sending", label: "Sending" },
  { href: "/settings/block-list", label: "Block list" },
  { href: "/settings/ai", label: "AI usage" },
];

export function SettingsTabs() {
  const path = usePathname();
  return (
    <TabLinks className="flex-1 min-w-0 border-b-0"
      items={TABS.map((t) => ({ ...t, active: t.href === "/settings" ? path === "/settings" : path === t.href || path.startsWith(`${t.href}/`) }))} />
  );
}

// ───────────────────────── AI usage ─────────────────────────

export function AiTest() {
  return <ActionButton size="sm" className="justify-self-start" action={testGroq}>Test AI connection</ActionButton>;
}

// ───────────────────────── block list ─────────────────────────

export function SuppressionList({ rows }: { rows: { email: string; reason: string; created_at: string }[] }) {
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [pending, run] = useAction();
  const needle = q.trim().toLowerCase();
  const shown = needle ? rows.filter((r) => r.email.includes(needle) || blockReasonLabel(r.reason).toLowerCase().includes(needle)) : rows;
  return (
    <Card>
      <CardHeader title="Block list" description="These addresses are never emailed again, by any campaign." />
      <div className="px-4 pb-4 grid gap-3">
        <div className="flex flex-col sm:flex-row gap-2 sm:items-start">
          <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste emails to block, separated by commas or new lines" className="flex-1" />
          <Button disabled={pending || !text.trim()} onClick={() => run(() => addSuppression(text), () => setText(""))}>{pending ? <Spinner /> : <Plus size={15} />}Block</Button>
        </div>
        {rows.length > 0 && (
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search blocked emails" className="pl-9" aria-label="Search blocked emails" />
          </div>
        )}
      </div>
      {rows.length === 0 ? (
        <Empty icon={<ShieldCheck size={24} />} title="No one is blocked">
          People who unsubscribe or say they&apos;re not interested are added automatically.
        </Empty>
      ) : shown.length === 0 ? (
        <p className="px-4 pb-4 text-[13px] text-muted">No blocked emails match “{q.trim()}”.</p>
      ) : (
        <div className="relative overflow-x-auto max-h-[480px] overflow-y-auto border-t border-line">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 bg-panel z-[1]">
              <tr><Th>Email</Th><Th>Reason</Th><Th>Added</Th><Th className="w-10"><span className="sr-only">Remove</span></Th></tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.email}>
                  <Td className="max-w-[280px] truncate">{r.email}</Td>
                  <Td className="text-muted whitespace-nowrap">{blockReasonLabel(r.reason)}</Td>
                  <Td className="text-faint whitespace-nowrap tabular-nums"><RelativeTime iso={r.created_at} /></Td>
                  <Td className="text-right">
                    <ActionButton size="sm" variant="ghost" className="w-7 px-0" title="Remove from block list"
                      confirm={{ title: `Allow emailing ${r.email} again?`, body: "They come off the block list. Campaigns only email them if you add them again.", confirmLabel: "Remove from block list" }}
                      action={() => removeSuppression(r.email)}><X size={14} /></ActionButton>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > 0 && <p className="px-4 py-2.5 text-[12px] text-faint border-t border-line">{fmtNum(rows.length)} blocked{rows.length >= 500 ? " (newest 500 shown)" : ""}</p>}
    </Card>
  );
}

// ───────────────────────── company profile ─────────────────────────

type ProfileField = { key: keyof CompanyProfile; label: string; hint?: string; rows?: number; placeholder: string; wide?: boolean };

const GROUPS: { title: string; description: string; fields: ProfileField[] }[] = [
  {
    title: "What we sell",
    description: "The AI only offers what's listed here, and only quotes results you list.",
    fields: [
      { key: "name", label: "Company name", placeholder: "e.g. Grevya" },
      { key: "website", label: "Website", placeholder: "e.g. https://grevya.com" },
      { key: "one_liner", label: "What you do (one sentence)", rows: 2, wide: true, placeholder: "e.g. We build AI apps for enterprises, from first pilot to production in weeks." },
      { key: "services", label: "Services (one per line)", rows: 6, wide: true, hint: "The AI picks the one that fits each lead best.", placeholder: "e.g.\n- AI assistants for support teams\n- Document processing automation" },
      { key: "proof", label: "Proof and results (only real ones)", rows: 4, wide: true, hint: "The AI may only quote numbers listed here. Leave it empty rather than guess.", placeholder: "e.g.\n- Pilot shipped in 3 weeks" },
    ],
  },
  {
    title: "Who we sell to",
    description: "Used to judge how well each company fits, and what to ask for.",
    fields: [
      { key: "ideal_customer", label: "Ideal customer", rows: 2, wide: true, placeholder: "e.g. Mid-size manufacturers with manual, document-heavy work" },
      { key: "cta", label: "Your ask", wide: true, placeholder: "e.g. Worth a 15-minute call next week?" },
    ],
  },
  {
    title: "How we sound",
    description: "The voice of every email.",
    fields: [{ key: "tone", label: "Tone", wide: true, placeholder: "e.g. Direct, warm, plain English. No hype." }],
  },
  {
    title: "Sender",
    description: "Who the emails come from.",
    fields: [
      { key: "sender_name", label: "Sender name", placeholder: "e.g. Your first name" },
      { key: "sender_title", label: "Sender title", placeholder: "e.g. Founder" },
      { key: "address", label: "Company address (added under emails)", wide: true, hint: "Anti-spam laws (e.g. US CAN-SPAM) require a postal address in commercial email.", placeholder: "e.g. Company name, street, city, PIN, country" },
    ],
  },
];
const ALL_FIELDS = GROUPS.flatMap((g) => g.fields);

type Change = { key: keyof CompanyProfile; label: string; from: string; to: string; checked: boolean };

function hostOf(url: string): string {
  try {
    return new URL(/^https?:\/\//.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function ProfileForm({ initial }: { initial: CompanyProfile }) {
  const [p, setP] = useState(initial);
  const [base, setBase] = useState(initial); // last saved values
  const [saving, runSave] = useAction();
  const [rewriting, runRewrite] = useAction();
  const [importing, setImporting] = useState(false);
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [affected, setAffected] = useState<AffectedCampaign[]>([]);
  const dirty = useMemo(() => ALL_FIELDS.some((f) => (p[f.key] ?? "") !== (base[f.key] ?? "")), [p, base]);
  const set = (k: keyof CompanyProfile, v: string) => setP((x) => ({ ...x, [k]: v }));
  const site = p.website.trim() || "https://grevya.com";
  const servicesEmpty = !p.services.trim();

  const doImport = async () => {
    setImporting(true);
    try {
      const r = await importProfile(site);
      if (!r.ok) return void toast.error(r.error);
      const diff: Change[] = [];
      for (const f of ALL_FIELDS) {
        const to = String(r.profile[f.key] ?? "").trim();
        const from = (p[f.key] ?? "").trim();
        if (to && to !== from) diff.push({ key: f.key, label: f.label, from, to, checked: !from });
      }
      if (!diff.length) return void toast.success("Your profile already matches the website");
      setChanges(diff);
    } finally {
      setImporting(false);
    }
  };

  const apply = () => {
    const picked = (changes ?? []).filter((c) => c.checked);
    setP((x) => ({ ...x, ...Object.fromEntries(picked.map((c) => [c.key, c.to])) }));
    setChanges(null);
    toast.success(`Updated ${picked.length} field${picked.length === 1 ? "" : "s"}: review and save`);
  };

  const save = () => runSave(async () => {
    const r = await saveProfile(p);
    if (r.ok) {
      setBase(p);
      setAffected(r.affected);
    }
    return r;
  });

  const unsent = affected.reduce((s, a) => s + a.count, 0);
  const rewrite = () => runRewrite(async () => {
    const results = await Promise.all(affected.map((a) => rewriteLeads(a.campaignId)));
    const failed = results.find((x) => !x.ok);
    if (failed) return failed;
    return { ok: true, message: `${fmtNum(unsent)} AI email${unsent === 1 ? "" : "s"} will be rewritten with the new profile` };
  }, () => setAffected([]));

  return (
    <div className="grid gap-4">
      {servicesEmpty ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-accent/25 bg-accent-soft/50 px-4 py-3 text-[13.5px]">
          <Sparkles size={16} className="text-accent shrink-0" />
          <span className="flex-1 min-w-[200px]">The AI writes every email from this. Fill it from {hostOf(site)} in one click.</span>
          <Button variant="primary" onClick={doImport} disabled={importing}>{importing ? <Spinner /> : <Globe size={15} />}Fill from website</Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 text-[13px] text-muted">
          <span>What the AI knows about your company. Every email is written from this.</span>
          <Button size="sm" onClick={doImport} disabled={importing}>{importing ? <Spinner /> : <Globe size={14} />}Refresh from website</Button>
        </div>
      )}

      {GROUPS.map((g) => (
        <Card key={g.title}>
          <CardHeader title={g.title} description={g.description} />
          <div className="grid md:grid-cols-2 gap-3 px-4 pb-4">
            {g.fields.map((f) => {
              const empty = !(p[f.key] ?? "").trim();
              return (
                <label key={f.key} className={cx("grid gap-1.5 content-start", f.wide && "md:col-span-2")}>
                  <span className="flex items-center gap-2 text-[12.5px] font-medium text-ink">
                    {f.label}
                    {empty && <Badge>Not filled</Badge>}
                  </span>
                  {f.rows ? (
                    <Textarea rows={f.rows} value={p[f.key]} placeholder={f.placeholder} onChange={(e) => set(f.key, e.target.value)} />
                  ) : (
                    <Input value={p[f.key]} placeholder={f.placeholder} onChange={(e) => set(f.key, e.target.value)} />
                  )}
                  {f.hint && <span className="text-[12px] text-muted leading-snug">{f.hint}</span>}
                </label>
              );
            })}
          </div>
        </Card>
      ))}

      <div className="sticky bottom-0 z-10 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 py-3 border-t border-line bg-bg/90 backdrop-blur grid gap-3">
        {affected.length > 0 && (
          <Card className="flex flex-wrap items-center gap-3 px-4 py-3 border-warn/30 bg-warn-soft text-[13px]">
            <span className="flex-1 min-w-[220px]">
              {fmtNum(unsent)} AI email{unsent === 1 ? "" : "s"} not yet sent {unsent === 1 ? "was" : "were"} written with the old profile
              <span className="text-muted"> ({affected.map((a) => a.name).join(", ")})</span>.
            </span>
            <Button size="sm" onClick={rewrite} disabled={rewriting}>{rewriting && <Spinner />}Rewrite them</Button>
            <Button size="sm" variant="ghost" onClick={() => setAffected([])} disabled={rewriting}>Keep</Button>
          </Card>
        )}
        <div className="flex items-center justify-end gap-3">
          {dirty && <span className="text-[12.5px] text-warn">Unsaved changes</span>}
          <Button variant="primary" disabled={!dirty || saving} onClick={save}>{saving && <Spinner />}Save profile</Button>
        </div>
      </div>

      <Dialog
        open={!!changes}
        onClose={() => setChanges(null)}
        wide
        title={`${changes?.length ?? 0} field${changes?.length === 1 ? "" : "s"} would change`}
        description={`From ${hostOf(site)}. Empty fields are ticked; fields you already filled are not.`}
        footer={
          <>
            <Button onClick={() => setChanges(null)}>Cancel</Button>
            <Button variant="primary" disabled={!changes?.some((c) => c.checked)} onClick={apply} data-autofocus="">Apply selected</Button>
          </>
        }
      >
        <ul className="grid gap-2">
          {(changes ?? []).map((c, i) => (
            <li key={c.key}>
              <label className={cx("flex items-start gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors",
                c.checked ? "border-accent/40 bg-accent-soft/30" : "border-line hover:bg-panel-2/60")}>
                <input type="checkbox" className="mt-1 accent-accent size-4 shrink-0" checked={c.checked}
                  onChange={(e) => setChanges((xs) => xs && xs.map((x, j) => (j === i ? { ...x, checked: e.target.checked } : x)))} />
                <span className="grid gap-1 min-w-0 flex-1 text-[13px]">
                  <span className="font-medium">{c.label}</span>
                  <span className="flex flex-col sm:flex-row sm:items-start gap-1.5 sm:gap-2 min-w-0">
                    <span className={cx("flex-1 min-w-0 whitespace-pre-line break-words line-clamp-4", c.from ? "text-muted line-through decoration-faint" : "text-faint italic")}>{c.from || "Empty"}</span>
                    <ArrowRight size={14} className="hidden sm:block mt-0.5 shrink-0 text-faint" />
                    <span className="flex-1 min-w-0 whitespace-pre-line break-words line-clamp-6">{c.to}</span>
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </Dialog>
    </div>
  );
}
