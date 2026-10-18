"use client";

import { AlarmClock, Check, CornerUpLeft, Inbox, PenLine, RotateCcw, Send, Sparkles, StickyNote } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useOptimistic, useState, useTransition } from "react";
import { toast } from "sonner";
import { markReply } from "@/app/actions/misc";
import { getThread, replyTo, saveNote, sendOneOff, setFollowUp, setHandled, suggestReply, type ThreadItem } from "@/app/actions/inbox";
import { Dialog, Spinner, useAction } from "@/components/client";
import { Badge, Button, Card, Empty, Field, Input, Select, StatusBadge, Textarea, cx, timeAgo } from "@/components/ui";
import type { Mailbox, Reply } from "@/lib/types";

export type InboxRow = { campaigns: { name: string } | null; mailboxes: { email: string } | null };
type Row = Reply & InboxRow;

const FILTERS = [
  { key: "todo", label: "Needs reply" },
  { key: "due", label: "Follow-ups due" },
  { key: "later", label: "Snoozed" },
  { key: "interested", label: "Interested" },
  { key: "done", label: "Done" },
  { key: "auto", label: "Auto-replies & bounces" },
  { key: "all", label: "All" },
];

const EMPTY: Record<string, { title: string; body: string }> = {
  todo: { title: "You're all caught up", body: "New replies land here within a few minutes. Answer them, set a reminder, or mark them done." },
  due: { title: "No follow-ups due", body: "Use “Remind me” on a conversation and it comes back here on that day." },
  later: { title: "Nothing snoozed", body: "" },
};

export function InboxView({ replies, filter, counts, initialId }: { replies: Row[]; filter: string; counts: Record<string, number>; initialId?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [, start] = useTransition();
  const [selectedId, setSelectedId] = useState(initialId ?? replies[0]?.id);
  const [rows, patch] = useOptimistic(replies, (state, p: { id: string } & Partial<Reply>) => state.map((r) => (r.id === p.id ? { ...r, ...p } : r)));
  const selected = rows.find((r) => r.id === selectedId) ?? rows[0];

  useEffect(() => {
    if (selected && !selected.is_read) {
      start(async () => { patch({ id: selected.id, is_read: true }); await markReply(selected.id, { is_read: true }); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button key={f.key} onClick={() => start(() => router.replace(`${pathname}?f=${f.key}`, { scroll: false }))}
            className={cx("h-7 px-2.5 rounded-full text-[12.5px] border transition-colors inline-flex items-center gap-1.5",
              filter === f.key ? "bg-ink text-bg border-ink" : "border-line text-muted hover:text-ink hover:bg-panel")}>
            {f.label}
            {counts[f.key] ? <span className={cx("tabular-nums rounded-full px-1.5 text-[11px]", filter === f.key ? "bg-bg/20" : f.key === "due" ? "bg-warn-soft text-warn" : "bg-panel-2")}>{counts[f.key]}</span> : null}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <Card><Empty icon={<Inbox size={28} />} title={EMPTY[filter]?.title ?? "Nothing here"}>{EMPTY[filter]?.body ?? ""}</Empty></Card>
      ) : (
        <div className="grid md:grid-cols-[340px_minmax(0,1fr)] gap-4 items-start">
          <Card className="overflow-hidden md:max-h-[calc(100vh-210px)] md:overflow-y-auto">
            {rows.map((r) => (
              <button key={r.id} onClick={() => setSelectedId(r.id)}
                className={cx("w-full text-left px-3.5 py-3 border-b border-line last:border-0 transition-colors",
                  selected?.id === r.id ? "bg-accent-soft/60" : "hover:bg-panel-2/60")}>
                <div className="flex items-center gap-2">
                  {!r.is_read && <span className="size-1.5 rounded-full bg-accent shrink-0" />}
                  <span className={cx("truncate flex-1", !r.is_read && "font-semibold")}>{r.from_name || r.from_email}</span>
                  <span className="text-[11.5px] text-faint tabular-nums shrink-0">{timeAgo(r.received_at)}</span>
                </div>
                <div className="text-[12.5px] text-muted truncate mt-0.5">{r.snippet || r.subject}</div>
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {r.kind !== "reply" && <StatusBadge status={r.kind} />}
                  {r.sentiment && r.sentiment !== "neutral" && <StatusBadge status={r.sentiment} />}
                  {r.answered_at && <Badge tone="good">replied</Badge>}
                  {r.follow_up_at && !r.handled && (
                    <Badge tone={new Date(r.follow_up_at) <= new Date() ? "warn" : "neutral"}><AlarmClock size={11} />{followUpLabel(r.follow_up_at)}</Badge>
                  )}
                  {r.campaigns?.name && <span className="text-[11.5px] text-faint truncate">{r.campaigns.name}</span>}
                </div>
              </button>
            ))}
          </Card>
          {selected && <Conversation key={selected.id} reply={selected} onPatch={(p) => patch({ id: selected.id, ...p })} />}
        </div>
      )}
    </div>
  );
}

function followUpLabel(iso: string): string {
  const d = new Date(iso);
  const days = Math.round((new Date(d.toDateString()).getTime() - new Date(new Date().toDateString()).getTime()) / 86_400_000);
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function inDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

function Conversation({ reply: r, onPatch }: { reply: Row; onPatch: (p: Partial<Reply>) => void }) {
  const [thread, setThread] = useState<ThreadItem[] | null>(null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState(r.note ?? "");
  const [suggesting, startSuggest] = useTransition();
  const [sending, runSend] = useAction();
  const [, startQuiet] = useTransition();
  const [, runAction] = useAction();
  const [pickDate, setPickDate] = useState(false);

  useEffect(() => {
    let alive = true;
    getThread(r.id).then((t) => alive && setThread(t)).catch(() => alive && setThread([]));
    return () => { alive = false; };
  }, [r.id]);

  const suggest = () => startSuggest(async () => {
    const res = await suggestReply(r.id);
    if (!res.ok) return void toast.error(res.error);
    setDraft(res.text);
  });

  const remind = (iso: string | null) => runAction(async () => {
    onPatch({ follow_up_at: iso, handled: false });
    return setFollowUp(r.id, iso);
  });

  const canReply = r.kind === "reply" || r.kind === "auto_reply";
  return (
    <Card className="fade-in overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-line">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold">{r.from_name || r.from_email}</div>
          <div className="text-[12.5px] text-muted mt-0.5 truncate">
            {r.from_email}{r.mailboxes?.email && <> → {r.mailboxes.email}</>}{r.campaigns?.name && <> · {r.campaigns.name}</>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {r.handled
            ? <Button size="sm" onClick={() => runAction(async () => { onPatch({ handled: false }); return setHandled(r.id, false); })}><RotateCcw size={14} />Reopen</Button>
            : <Button size="sm" onClick={() => runAction(async () => { onPatch({ handled: true, follow_up_at: null }); return setHandled(r.id, true); })}><Check size={14} />Done</Button>}
        </div>
      </div>

      {r.kind === "reply" && (
        <div className="flex flex-wrap items-center gap-1.5 px-5 py-2.5 border-b border-line bg-panel-2/40 text-[12.5px]">
          <span className="text-muted mr-1">Lead is</span>
          {(["interested", "neutral", "not_interested"] as const).map((s) => (
            <button key={s} onClick={() => startQuiet(async () => { onPatch({ sentiment: s }); await markReply(r.id, { sentiment: s }); })}
              className={cx("h-7 px-2.5 rounded-full border capitalize transition-colors",
                r.sentiment === s
                  ? s === "interested" ? "bg-good-soft text-good border-good/30" : s === "not_interested" ? "bg-bad-soft text-bad border-bad/30" : "bg-panel text-ink border-line"
                  : "border-line text-muted hover:text-ink")}>
              {s.replace("_", " ")}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-line" />
          <AlarmClock size={14} className="text-muted" />
          <span className="text-muted">Remind me</span>
          {[["Tomorrow", 1], ["In 3 days", 3], ["Next week", 7]].map(([l, d]) => (
            <button key={l} onClick={() => remind(inDays(d as number))} className="h-7 px-2.5 rounded-full border border-line text-muted hover:text-ink">{l}</button>
          ))}
          {pickDate
            ? <input type="date" autoFocus className="h-7 rounded-md border border-line bg-panel px-2 text-[12.5px]"
                onChange={(e) => { if (e.target.value) { remind(new Date(`${e.target.value}T09:00:00`).toISOString()); setPickDate(false); } }} />
            : <button onClick={() => setPickDate(true)} className="h-7 px-2.5 rounded-full border border-line text-muted hover:text-ink">Pick date</button>}
          {r.follow_up_at && <button onClick={() => remind(null)} className="text-faint hover:text-ink underline">clear ({followUpLabel(r.follow_up_at)})</button>}
        </div>
      )}

      <div className="px-5 py-4 grid gap-3 max-h-[46vh] overflow-y-auto">
        {thread === null ? <div className="flex items-center gap-2 text-[13px] text-muted"><Spinner />Loading conversation…</div>
          : thread.length === 0 ? <ThreadBubble item={{ id: r.id, direction: "in", at: r.received_at, subject: r.subject, body: r.body || r.snippet, who: r.from_name || r.from_email, label: "Reply" }} />
          : thread.map((t) => <ThreadBubble key={t.id} item={t} highlight={t.id === r.id} />)}
      </div>

      {canReply && (
        <div className="border-t border-line px-5 py-4 grid gap-2.5 bg-panel-2/30">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[13px] font-medium flex items-center gap-1.5"><CornerUpLeft size={14} />Reply to {r.from_name?.split(" ")[0] || r.from_email}</div>
            <Button size="sm" onClick={suggest} disabled={suggesting}>{suggesting ? <Spinner /> : <Sparkles size={14} />}{draft ? "Suggest again" : "Suggest a reply"}</Button>
          </div>
          <Textarea rows={6} value={draft} onChange={(e) => setDraft(e.target.value)}
            placeholder="Write your reply… It goes from the same mailbox, in the same email thread, with your signature added." />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[12px] text-faint">A copy is saved to the mailbox&apos;s Sent folder, so you&apos;ll see it in your email app too.</span>
            <Button variant="primary" disabled={sending || !draft.trim()}
              onClick={() => runSend(() => replyTo(r.id, draft), () => { setDraft(""); onPatch({ handled: true, answered_at: new Date().toISOString(), follow_up_at: null }); getThread(r.id).then(setThread); })}>
              {sending ? <Spinner /> : <Send size={14} />}Send reply
            </Button>
          </div>
        </div>
      )}

      <details className="border-t border-line px-5 py-3 text-[13px]" open={Boolean(r.note)}>
        <summary className="cursor-pointer select-none text-muted inline-flex items-center gap-1.5"><StickyNote size={14} />Private note</summary>
        <Textarea rows={2} className="mt-2" value={note} placeholder="e.g. Wants pricing for 3 plants. Call after Diwali."
          onChange={(e) => setNote(e.target.value)} onBlur={() => note !== (r.note ?? "") && startQuiet(async () => { await saveNote(r.id, note); onPatch({ note }); })} />
      </details>
    </Card>
  );
}

function ThreadBubble({ item: t, highlight }: { item: ThreadItem; highlight?: boolean }) {
  const out = t.direction === "out";
  return (
    <div className={cx("rounded-xl border px-4 py-3 text-[13.5px]", out ? "border-line bg-panel-2/50 ml-6" : "border-line bg-panel mr-6", highlight && "ring-2 ring-accent/20 border-accent/40")}>
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted mb-1.5">
        <span className="font-medium text-ink">{out ? "You" : t.who}</span>
        <Badge tone={out ? "neutral" : t.label === "Reply" ? "accent" : "neutral"}>{t.label}</Badge>
        <span className="ml-auto tabular-nums">{new Date(t.at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</span>
      </div>
      {t.subject && <div className="font-medium text-[13px] mb-1">{t.subject}</div>}
      <pre className="whitespace-pre-wrap break-words font-sans leading-relaxed">{t.body}</pre>
    </div>
  );
}

export function NewEmailButton({ mailboxes }: { mailboxes: Pick<Mailbox, "id" | "email" | "status">[] }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ mailboxId: mailboxes[0]?.id ?? "", to: "", firstName: "", company: "", subject: "", body: "" });
  const [pending, run] = useAction();
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));
  if (!mailboxes.length) return null;
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}><PenLine size={15} />New email</Button>
      {open && (
        <Dialog open wide onClose={() => setOpen(false)} title="Write an email" description="A one-off email from one of your mailboxes. The person is saved to Leads so their reply shows up here."
          footer={<Button variant="primary" disabled={pending || !f.to || !f.subject || !f.body}
            onClick={() => run(() => sendOneOff(f), () => { setOpen(false); setF((p) => ({ ...p, to: "", firstName: "", company: "", subject: "", body: "" })); })}>
            {pending ? <Spinner /> : <Send size={14} />}Send</Button>}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="From">
              <Select value={f.mailboxId} onChange={(e) => set("mailboxId", e.target.value)}>
                {mailboxes.map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}
              </Select>
            </Field>
            <Field label="To"><Input type="email" value={f.to} autoFocus placeholder="priya@acme.com" onChange={(e) => set("to", e.target.value)} /></Field>
            <Field label="Their first name (optional)"><Input value={f.firstName} onChange={(e) => set("firstName", e.target.value)} /></Field>
            <Field label="Company (optional)"><Input value={f.company} onChange={(e) => set("company", e.target.value)} /></Field>
            <Field label="Subject" className="sm:col-span-2"><Input value={f.subject} onChange={(e) => set("subject", e.target.value)} /></Field>
            <Field label="Message" hint="Plain text. Your mailbox signature is added automatically." className="sm:col-span-2">
              <Textarea rows={9} value={f.body} onChange={(e) => set("body", e.target.value)} />
            </Field>
          </div>
        </Dialog>
      )}
    </>
  );
}

