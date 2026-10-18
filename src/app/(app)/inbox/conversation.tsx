"use client";

import { AlarmClock, ArrowLeft, CalendarDays, Check, ChevronDown, CornerUpLeft, RotateCcw, Send, Sparkles, StickyNote, Sun, User, X } from "lucide-react";
import Link from "next/link";
import { startTransition, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { replyTo, saveNote, setFollowUp, setHandled, setReplyLabel, undoBlock } from "@/app/actions/inbox";
import { Dialog, Menu, Spinner, useAction, useHotkeys, type ActionResult } from "@/components/client";
import { Badge, Button, Card, Field, Input, Kbd, Textarea, buttonClass, cx, type Tone } from "@/components/ui";
import { APP_TZ, fmtDateTime, fmtDay } from "@/lib/format";
import type { InboxRow, ThreadItem } from "@/lib/inbox-data";
import { REPLY_KIND_LABEL, REPLY_LABELS } from "@/lib/labels";
import type { Reply, ReplyLabel } from "@/lib/types";

/** Applies a local change to the conversation. `leaves` = it no longer belongs in To do (Done, Send, a future reminder). Returns an undo. */
export type ChangeRow = (patch: Partial<Reply>, leaves?: boolean) => () => void;

// Unsent replies survive switching between conversations (until the page is left).
const drafts = new Map<string, string>();

const LABEL_ACTIVE: Record<Tone, string> = {
  neutral: "bg-panel-2 text-ink border-line",
  accent: "bg-accent-soft text-accent border-accent/30",
  good: "bg-good-soft text-good border-good/30",
  warn: "bg-warn-soft text-warn border-warn/30",
  bad: "bg-bad-soft text-bad border-bad/30",
  info: "bg-info-soft text-info border-info/30",
};

/** Runs an inbox write in the background. The change is already on screen; a failure undoes it and says why. */
function save(call: () => Promise<ActionResult>, revert?: () => void, quiet = false) {
  startTransition(async () => {
    try {
      const res = await call();
      if (!res.ok) {
        revert?.();
        toast.error(res.error);
      } else if (res.message && !quiet) toast.success(res.message);
    } catch (err) {
      revert?.();
      toast.error((err as Error).message || "Couldn't save that");
    }
  });
}

// ───────────── reminder times: 9:00 in the app's timezone ─────────────

function zoneParts(t: number): { y: number; m: number; d: number; h: number; min: number } {
  let f: Intl.DateTimeFormat;
  const opts: Intl.DateTimeFormatOptions = { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" };
  try {
    f = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: APP_TZ });
  } catch {
    f = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "Asia/Kolkata" });
  }
  const p: Record<string, number> = {};
  for (const { type, value } of f.formatToParts(t)) if (type !== "literal") p[type] = Number(value);
  return { y: p.year, m: p.month, d: p.day, h: p.hour % 24, min: p.minute };
}

/** The instant it is `h`:00 on that calendar day in APP_TZ (day may overflow; Date.UTC normalises it). */
function wallTime(y: number, m: number, d: number, h = 9): string {
  const guess = Date.UTC(y, m - 1, d, h, 0);
  const p = zoneParts(guess);
  const offset = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - guess;
  return new Date(guess - offset).toISOString();
}

function daysFromToday(days: number): string {
  const p = zoneParts(Date.now());
  return wallTime(p.y, p.m, p.d + days);
}

/** 'YYYY-MM-DD' for today (+days) in APP_TZ, for the date picker. */
function dateInput(days = 0): string {
  const p = zoneParts(Date.parse(daysFromToday(days)));
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

// ───────────── conversation ─────────────

export function Conversation({ row: r, onChange, onBack }: { row: InboxRow; onChange: ChangeRow; onBack: () => void }) {
  const [thread, setThread] = useState<ThreadItem[] | null>(null);
  const [threadVersion, setThreadVersion] = useState(0);
  const [draft, setDraftState] = useState(() => drafts.get(r.id) ?? "");
  const [note, setNote] = useState(r.note ?? "");
  const [suggesting, setSuggesting] = useState(false);
  const [sending, runSend] = useAction();
  const [picking, setPicking] = useState<{ min: string; value: string } | null>(null);
  const replyBox = useRef<HTMLTextAreaElement>(null);
  const remindButton = useRef<HTMLButtonElement>(null);
  const threadBox = useRef<HTMLDivElement>(null);
  const suggestCall = useRef<AbortController | null>(null);

  const setDraft = (v: string) => { setDraftState(v); if (v) drafts.set(r.id, v); else drafts.delete(r.id); };

  // The thread is a GET route (not a Server Action), cancelled when the conversation changes.
  useEffect(() => {
    const ac = new AbortController();
    fetch(`/api/inbox/thread?id=${encodeURIComponent(r.id)}`, { signal: ac.signal, cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<ThreadItem[]>) : []))
      .then((t) => setThread(t))
      .catch(() => { if (!ac.signal.aborted) setThread([]); });
    return () => ac.abort();
  }, [r.id, threadVersion]);

  // Show the message this conversation is about (usually the newest).
  useEffect(() => {
    const box = threadBox.current;
    const target = box?.querySelector<HTMLElement>("[data-current]");
    if (box && target && box.scrollHeight > box.clientHeight) box.scrollTop = target.offsetTop - box.offsetTop - 8;
  }, [thread]);

  // An AI suggestion still running is cancelled when you leave the conversation.
  useEffect(() => () => suggestCall.current?.abort(), []);

  const suggest = async () => {
    if (suggestCall.current) { // second click = Stop
      suggestCall.current.abort();
      suggestCall.current = null;
      setSuggesting(false);
      return;
    }
    const ac = new AbortController();
    suggestCall.current = ac;
    setSuggesting(true);
    try {
      const res = await fetch(`/api/inbox/suggest?id=${encodeURIComponent(r.id)}`, { signal: ac.signal, cache: "no-store" });
      const out = (await res.json()) as { ok: true; text: string } | { ok: false; error: string };
      if (out.ok) {
        setDraft(out.text);
        replyBox.current?.focus();
      } else toast.error(out.error);
    } catch {
      if (!ac.signal.aborted) toast.error("Couldn't write a reply. Try again.");
    } finally {
      if (suggestCall.current === ac) {
        suggestCall.current = null;
        setSuggesting(false);
      }
    }
  };

  const done = () => save(() => setHandled(r.id, true), onChange({ handled: true, follow_up_at: null, is_read: true }, true));
  const reopen = () => save(() => setHandled(r.id, false), onChange({ handled: false }));
  const remind = (iso: string | null) => {
    const leaves = iso !== null && Date.parse(iso) > Date.now();
    save(() => setFollowUp(r.id, iso), onChange({ follow_up_at: iso, handled: false }, leaves));
  };

  const label = (key: ReplyLabel) => {
    const next = r.sentiment === key ? null : key; // clicking the active label clears it
    const revert = onChange({ sentiment: next ?? "neutral" });
    startTransition(async () => {
      try {
        const res = await setReplyLabel(r.id, next);
        if (!res.ok) {
          revert();
          toast.error(res.error);
          return;
        }
        if (res.blocked) {
          const previous = (res.previous ?? null) as Reply["sentiment"];
          toast.success(`Blocked ${res.blocked}. They won't be emailed again.`, {
            action: { label: "Undo", onClick: () => save(() => undoBlock(r.id, previous), onChange({ sentiment: previous })) },
          });
        }
      } catch (err) {
        revert();
        toast.error((err as Error).message || "Couldn't save the label");
      }
    });
  };

  const canReply = r.kind === "reply" || r.kind === "auto_reply";
  const send = () => {
    if (!canReply || sending || !draft.trim()) return;
    runSend(() => replyTo(r.id, draft), () => {
      setDraft("");
      onChange({ handled: true, is_read: true, answered_at: new Date().toISOString(), follow_up_at: null }, true);
      setThreadVersion((v) => v + 1); // when it stays open (outside To do), show the sent reply
    });
  };

  useHotkeys({
    e: () => (r.handled ? undefined : done()),
    r: () => replyBox.current?.focus(),
    h: () => remindButton.current?.click(),
    ...Object.fromEntries(REPLY_LABELS.map((l) => [l.shortcut, () => { if (r.kind === "reply") label(l.key); }])),
  });

  const firstName = r.from_name?.split(" ")[0] || r.from_email;
  const remindItems = [
    { label: "Tomorrow 9:00", icon: <Sun />, onSelect: () => remind(daysFromToday(1)) },
    { label: "In 3 days", icon: <AlarmClock />, onSelect: () => remind(daysFromToday(3)) },
    { label: "Next week", icon: <AlarmClock />, onSelect: () => remind(daysFromToday(7)) },
    { label: "Pick date…", icon: <CalendarDays />, onSelect: () => setPicking({ min: dateInput(0), value: dateInput(1) }) },
    { label: "Clear reminder", icon: <X />, hidden: !r.follow_up_at, onSelect: () => remind(null) },
  ];

  return (
    <Card className="fade-in overflow-hidden flex flex-col md:sticky md:top-6 md:h-[calc(100dvh-150px)] md:min-h-[480px]">
      <div className="px-4 sm:px-5 pt-3.5 pb-3 border-b border-line grid gap-2.5">
        <button type="button" onClick={onBack} className={buttonClass("ghost", "sm", "md:hidden -ml-2 justify-self-start")}>
          <ArrowLeft size={15} />Back
        </button>
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold truncate">{r.from_name || r.from_email}</div>
            <div className="text-[12.5px] text-muted mt-0.5 break-words">
              {r.from_email}{r.mailboxes?.email && <> → {r.mailboxes.email}</>}{r.campaigns?.name && <> · {r.campaigns.name}</>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {r.lead_id && <Link href={`/leads?lead=${r.lead_id}`} className={buttonClass("ghost", "sm")}><User size={14} />Open lead</Link>}
            <Menu
              trigger={
                <Button size="sm" ref={remindButton} title="Remind me (H)">
                  <AlarmClock size={14} />{r.follow_up_at && !r.handled ? `Reminder · ${fmtDay(r.follow_up_at)}` : "Remind me"}<ChevronDown size={13} className="text-faint" />
                </Button>
              }
              items={remindItems}
            />
            {r.handled
              ? <Button size="sm" onClick={reopen}><RotateCcw size={14} />Reopen</Button>
              : <Button size="sm" onClick={done} title="Done (E)"><Check size={14} />Done<Kbd className="hidden md:inline-flex ml-0.5">e</Kbd></Button>}
          </div>
        </div>
      </div>

      {r.kind === "reply" ? (
        <div className="flex items-center gap-1.5 px-4 sm:px-5 py-2 border-b border-line bg-panel-2/40 text-[12.5px] overflow-x-auto [scrollbar-width:none]">
          <span className="text-muted mr-0.5 shrink-0">Label</span>
          {REPLY_LABELS.map((l) => {
            const active = r.sentiment === l.key;
            return (
              <button key={l.key} type="button" onClick={() => label(l.key)} aria-pressed={active}
                title={active ? `Remove “${l.label}” (${l.shortcut})` : `${l.label} (${l.shortcut})`}
                className={cx("shrink-0 inline-flex items-center gap-1.5 h-7 pl-2.5 pr-1.5 rounded-full border transition-colors",
                  active ? LABEL_ACTIVE[l.tone] : "border-line text-muted hover:text-ink hover:bg-panel")}>
                {l.label}
                <span className="hidden md:inline text-[10.5px] font-mono text-faint tabular-nums">{l.shortcut}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="px-4 sm:px-5 py-2 border-b border-line bg-panel-2/40 text-[12.5px] text-muted">
          {r.kind === "bounce"
            ? "This email bounced: the address can't receive email, so it won't be emailed again."
            : `${REPLY_KIND_LABEL[r.kind]}: sent automatically, usually by an out-of-office rule.`}
        </div>
      )}

      <div ref={threadBox} className="px-4 sm:px-5 py-4 grid content-start gap-3 md:flex-1 md:min-h-0 overflow-y-auto">
        {thread === null
          ? <div className="flex items-center gap-2 text-[13px] text-muted"><Spinner />Loading conversation…</div>
          : thread.length === 0
            ? <ThreadBubble current item={{ id: r.id, direction: "in", at: r.received_at, subject: r.subject, body: r.body || r.snippet, who: r.from_name || r.from_email, label: REPLY_KIND_LABEL[r.kind] ?? "Reply" }} />
            : thread.map((t) => <ThreadBubble key={t.id} item={t} current={t.id === r.id} />)}
      </div>

      {canReply && (
        <div className="border-t border-line px-4 sm:px-5 py-3 grid gap-2 bg-panel-2/30">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[13px] font-medium flex items-center gap-1.5 min-w-0"><CornerUpLeft size={14} className="shrink-0" /><span className="truncate">Reply to {firstName}</span></div>
            <Button size="sm" variant="ghost" onClick={suggest} title={suggesting ? "Stop" : "Let AI draft a reply you can edit"}>
              {suggesting ? <><Spinner />Stop</> : <><Sparkles size={14} />Write it for me</>}
            </Button>
          </div>
          <Textarea ref={replyBox} rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} className="max-h-[40vh]"
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); send(); } }}
            placeholder="Write your reply… It goes from the same email account, in the same email thread, with your signature added." />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[12px] text-faint">A copy is saved to your Sent folder.</span>
            <Button variant="primary" disabled={sending || !draft.trim()} onClick={send} title="Send reply (⌘/Ctrl+Enter)">
              {sending ? <Spinner /> : <Send size={14} />}Send reply
            </Button>
          </div>
        </div>
      )}

      <label className="border-t border-line px-4 sm:px-5 py-2.5 flex items-start gap-2 text-[13px]">
        <StickyNote size={14} className="text-muted mt-2 shrink-0" />
        <span className="sr-only">Private note</span>
        <Textarea rows={1} value={note} placeholder="Private note (only you see it), e.g. Wants pricing for 3 plants. Call after Diwali."
          className="min-h-9 resize-none border-transparent bg-transparent focus:bg-panel"
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => {
            if (note === (r.note ?? "")) return;
            save(() => saveNote(r.id, note), onChange({ note }), true);
          }} />
      </label>

      {picking && (
        <Dialog open onClose={() => setPicking(null)} title="Remind me on…" description="The conversation comes back to To do at 9:00 that day."
          footer={
            <>
              <Button onClick={() => setPicking(null)}>Cancel</Button>
              <Button variant="primary" disabled={!picking.value} onClick={() => {
                const [y, m, d] = picking.value.split("-").map(Number);
                setPicking(null);
                remind(wallTime(y, m, d));
              }}>Set reminder</Button>
            </>
          }>
          <Field label="Date">
            <Input type="date" min={picking.min} value={picking.value} data-autofocus=""
              onChange={(e) => setPicking((p) => (p ? { ...p, value: e.target.value } : p))} />
          </Field>
        </Dialog>
      )}
    </Card>
  );
}

function ThreadBubble({ item: t, current }: { item: ThreadItem; current?: boolean }) {
  const out = t.direction === "out";
  return (
    <div data-current={current || undefined}
      className={cx("rounded-xl border px-4 py-3 text-[13.5px] min-w-0", out ? "border-line bg-panel-2/50 ml-4 sm:ml-8" : "border-line bg-panel mr-4 sm:mr-8",
        current && "ring-2 ring-accent/20 border-accent/40")}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted mb-1.5">
        <span className="font-medium text-ink">{out ? "You" : t.who}</span>
        <Badge tone={out ? "neutral" : t.label === "Reply" ? "accent" : "neutral"}>{t.label}</Badge>
        <span className="ml-auto tabular-nums">{fmtDateTime(t.at)}</span>
      </div>
      {t.subject && <div className="font-medium text-[13px] mb-1 break-words">{t.subject}</div>}
      <pre className="whitespace-pre-wrap break-words font-sans leading-relaxed">{t.body}</pre>
    </div>
  );
}
