"use client";

import { AlarmClock, Bot, Check, CornerUpLeft, Inbox, Mail, Mails, Search, SlidersHorizontal, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useOptimistic, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";
import { RelativeTime, ShortcutHelp, Spinner, useHotkeys, usePoll } from "@/components/client";
import { publishTodoCount } from "@/components/nav";
import { Badge, Button, ButtonLink, Card, Empty, Select, cx, inputClass, type Tone } from "@/components/ui";
import { fmtDate, fmtDay, fmtNum } from "@/lib/format";
import type { FilterOptions, InboxCounts, InboxRow, InboxView as View } from "@/lib/inbox-data";
import { replyLabel, REPLY_KIND_LABEL, REPLY_LABELS } from "@/lib/labels";
import type { Reply } from "@/lib/types";
import { Conversation, type ChangeRow } from "./conversation";

export type InboxFilter = { f: View; label: string; campaign: string; account: string; q: string };

const PAGE = 50;
const POLL_MS = 30_000;
/** A server payload older than this came from the router cache: fetch the list again once. */
const STALE_MS = 5_000;
const WIDE = "(min-width: 768px)";

const VIEWS: { key: View; label: string; icon: typeof Inbox }[] = [
  { key: "todo", label: "To do", icon: Inbox },
  { key: "reminders", label: "Reminder set", icon: AlarmClock },
  { key: "done", label: "Done", icon: Check },
  { key: "auto", label: "Auto-replies & bounces", icon: Bot },
  { key: "all", label: "All", icon: Mails },
];

const EMPTY: Record<View, { title: string; body: string }> = {
  todo: { title: "Inbox zero", body: "New replies show up here within a few minutes." },
  reminders: { title: "No reminders set", body: "Use Remind me on a conversation and it comes back to To do on that day." },
  done: { title: "Nothing done yet", body: "Conversations you answer or mark done move here." },
  auto: { title: "No auto-replies or bounces", body: "Out-of-office replies and bounced emails land here, away from your To do." },
  all: { title: "No replies yet", body: "Replies to your emails show up here within a few minutes." },
};

const SHORTCUTS: [string, string][] = [
  ["j", "Next conversation"],
  ["k", "Previous conversation"],
  ["enter", "Open the selected conversation"],
  ["r", "Write a reply"],
  ["mod+enter", "Send reply"],
  ["e", "Done"],
  ["h", "Remind me"],
  ["1-6", REPLY_LABELS.map((l) => l.label).join(" · ")],
  ["/", "Search"],
  ["?", "Show shortcuts"],
];

function filterParams(f: InboxFilter, extra?: Record<string, string>): URLSearchParams {
  const sp = new URLSearchParams();
  if (f.f !== "todo") sp.set("f", f.f);
  if (f.label) sp.set("label", f.label);
  if (f.campaign) sp.set("campaign", f.campaign);
  if (f.account) sp.set("account", f.account);
  if (f.q) sp.set("q", f.q);
  for (const [k, v] of Object.entries(extra ?? {})) sp.set(k, v);
  return sp;
}

function inboxHref(f: InboxFilter): string {
  const qs = filterParams(f).toString();
  return qs ? `/inbox?${qs}` : "/inbox";
}

async function fetchList(f: InboxFilter, extra: Record<string, string>, signal?: AbortSignal): Promise<{ rows: InboxRow[]; counts: InboxCounts | null }> {
  const res = await fetch(`/api/inbox/list?${filterParams(f, extra)}`, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error || "Couldn't load conversations");
  return res.json();
}

/** Adds rows that aren't in the list yet (polls and pages can overlap). */
function merge(list: InboxRow[], add: InboxRow[], where: "start" | "end"): InboxRow[] {
  const have = new Set(list.map((r) => r.id));
  const fresh = add.filter((r) => !have.has(r.id));
  return where === "start" ? [...fresh, ...list] : [...list, ...fresh];
}

function subscribeWide(cb: () => void) {
  const mq = window.matchMedia(WIDE);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

/** Reminder chip text: Today / Overdue / '25 Oct'. */
function reminderChip(iso: string, now: number): { text: string; tone: Tone } {
  if (fmtDate(iso, { year: true }) === fmtDate(now, { year: true })) return { text: "Today", tone: "warn" };
  if (Date.parse(iso) < now) return { text: "Overdue", tone: "bad" };
  return { text: fmtDate(iso), tone: "neutral" };
}

export function InboxView({ rows: serverRows, hasMore: serverHasMore, cursor: serverCursor, counts: serverCounts, options, filter, initialId, renderedAt }: {
  rows: InboxRow[];
  hasMore: boolean;
  cursor: { newest: string | null; oldest: string | null };
  counts: InboxCounts;
  options: FilterOptions;
  filter: InboxFilter;
  initialId?: string;
  renderedAt: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [shown, setShown] = useOptimistic(filter);

  // A deep link (?id=) counts as opening the conversation, so it starts out read.
  const [deepLinkUnread] = useState(() => serverRows.find((r) => r.id === initialId && !r.is_read)?.id ?? null);
  const [rows, setRows] = useState(() => serverRows.map((r) => (r.id === deepLinkUnread ? { ...r, is_read: true } : r)));
  const [counts, setCounts] = useState(serverCounts);
  // Keep the sidebar's To do pill in step (inbox writes don't refresh the layout).
  useEffect(() => { publishTodoCount(counts.todo); }, [counts.todo]);
  const [hasMore, setHasMore] = useState(serverHasMore);
  const [cursor, setCursor] = useState(serverCursor);
  /** undefined = nothing chosen (desktop shows the first row), null = closed. */
  const [picked, setPicked] = useState<string | null | undefined>(initialId);
  const [now, setNow] = useState(renderedAt);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [search, setSearch] = useState(filter.q);
  const searchBox = useRef<HTMLInputElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const liveFilter = useRef(filter);

  // A new server payload (another view or filter): start over from it.
  const [payload, setPayload] = useState(serverRows);
  if (payload !== serverRows) {
    setPayload(serverRows);
    setRows(serverRows);
    setCounts(serverCounts);
    setHasMore(serverHasMore);
    setCursor(serverCursor);
    setPicked(initialId);
    setNow(renderedAt);
  }

  // Auto-selection is for desktop only; on phones the list shows until you tap a conversation.
  const wide = useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches, () => false);
  const selected = (picked ? rows.find((r) => r.id === picked) : undefined) ?? (picked === undefined && wide ? rows[0] : undefined);

  useEffect(() => { liveFilter.current = filter; });

  const postRead = (id: string) => {
    void fetch("/api/inbox/read", { method: "POST", body: JSON.stringify({ id }), keepalive: true, headers: { "content-type": "application/json" } }).catch(() => {});
  };

  useEffect(() => {
    if (deepLinkUnread) postRead(deepLinkUnread);
  }, [deepLinkUnread]);

  // Served from the router cache (e.g. Back to the inbox): bring the list up to date once.
  useEffect(() => {
    if (Date.now() - renderedAt <= STALE_MS) return;
    const ac = new AbortController();
    fetchList(filter, { full: "1" }, ac.signal).then((d) => {
      setRows((cur) => {
        const keep = cur.find((r) => r.id === picked && !d.rows.some((x) => x.id === r.id));
        return keep ? [keep, ...d.rows] : d.rows;
      });
      if (d.counts) setCounts(d.counts);
      setHasMore(d.rows.length >= PAGE);
      setCursor({ newest: d.rows[0]?.received_at ?? null, oldest: d.rows.at(-1)?.received_at ?? null });
      setNow(Date.now());
    }).catch(() => {});
    return () => ac.abort();
    // Only when a new payload arrives; `picked` is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderedAt, filter]);

  // New replies: only add what's new, never reload the list.
  usePoll(async () => {
    if (pending) return;
    const at = filter;
    const d = await fetchList(at, cursor.newest ? { since: cursor.newest } : { full: "1" });
    if (liveFilter.current !== at) return; // the view changed meanwhile
    if (d.rows.length) {
      setRows((cur) => merge(cur, d.rows, "start"));
      setCursor((c) => ({ newest: d.rows[0].received_at, oldest: c.oldest ?? d.rows.at(-1)?.received_at ?? null }));
    }
    if (d.counts) setCounts(d.counts);
    setNow(Date.now());
  }, POLL_MS);

  /**
   * Opens a conversation the user chose (null closes it): keeps ?id= in the address bar without a
   * server round-trip, and marks it read. Desktop auto-selection doesn't go through here, so it never marks anything read.
   */
  const open = (id: string | null) => {
    setPicked(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("id", id);
    else url.searchParams.delete("id");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
    if (!id) return;
    document.getElementById(`reply-${id}`)?.scrollIntoView({ block: "nearest" });
    if (rows.some((r) => r.id === id && !r.is_read)) {
      setRows((cur) => cur.map((r) => (r.id === id ? { ...r, is_read: true } : r)));
      postRead(id);
    }
  };

  const go = (patch: Partial<InboxFilter>) => {
    const next = { ...shown, ...patch };
    start(() => {
      setShown(next);
      router.replace(inboxHref(next), { scroll: false });
    });
  };

  useEffect(() => () => clearTimeout(searchTimer.current), []); // a search typed just before leaving the page

  const onSearch = (v: string) => {
    setSearch(v);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => go({ q: v.trim() }), 300);
  };

  const loadMore = async () => {
    if (!cursor.oldest) return;
    setLoadingMore(true);
    try {
      const d = await fetchList(filter, { before: cursor.oldest });
      setRows((cur) => merge(cur, d.rows, "end"));
      setHasMore(d.rows.length >= PAGE);
      setCursor((c) => ({ ...c, oldest: d.rows.at(-1)?.received_at ?? c.oldest }));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  /** Local change to a conversation. Leaving To do (Done, Send, a future reminder) opens the next one. */
  const change = (id: string): ChangeRow => (patch, leaves = false) => {
    const index = rows.findIndex((r) => r.id === id);
    const before = rows[index];
    if (!before) return () => {};
    if (leaves && filter.f === "todo") {
      const rest = rows.filter((r) => r.id !== id);
      const next = rest[index] ?? rest[index - 1];
      setRows(rest);
      setCounts((c) => ({ ...c, todo: Math.max(0, c.todo - 1) }));
      open(next?.id ?? null);
      return () => {
        setRows((cur) => (cur.some((r) => r.id === id) ? cur : [...cur.slice(0, index), before, ...cur.slice(index)]));
        setCounts((c) => ({ ...c, todo: c.todo + 1 }));
      };
    }
    const old = Object.fromEntries(Object.keys(patch).map((k) => [k, before[k as keyof Reply]])) as Partial<Reply>;
    setRows((cur) => cur.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    return () => setRows((cur) => cur.map((r) => (r.id === id ? { ...r, ...old } : r)));
  };

  const step = (d: 1 | -1) => {
    if (!rows.length) return;
    const i = selected ? rows.findIndex((r) => r.id === selected.id) : -1;
    const next = rows[Math.min(rows.length - 1, Math.max(0, i + d))];
    if (next) open(next.id);
  };

  useHotkeys({
    j: () => step(1),
    k: () => step(-1),
    "/": () => searchBox.current?.focus(),
  });

  // Enter opens the selected conversation, but only when nothing else has focus (a focused button keeps its own Enter).
  const enter = useRef<() => void>(() => {});
  useEffect(() => { enter.current = () => { if (selected) open(selected.id); }; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing) return;
      if (e.target !== document.body || document.querySelector("dialog[open]")) return;
      e.preventDefault();
      enter.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const filtersOn = [shown.label, shown.campaign, shown.account].filter(Boolean).length;
  const searching = !!filter.q || filtersOn > 0;
  const noDetection = options.mailboxes.filter((m) => !m.imap_host || m.status === "error");
  const viewCount = (k: View) => counts[k];

  return (
    <div className="grid gap-4 items-start md:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[190px_320px_minmax(0,1fr)]">
      {/* Views and filters: a row of chips on smaller screens, a rail on wide ones */}
      <div className={cx("grid gap-3 min-w-0 md:col-span-2 xl:col-span-1 xl:sticky xl:top-6", selected && "max-md:hidden")}>
        <div className="flex items-center gap-2 min-w-0">
          <nav aria-label="Views" className="flex xl:flex-col gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden min-w-0 flex-1">
            {VIEWS.map(({ key, label, icon: Icon }) => {
              const active = shown.f === key;
              const n = viewCount(key);
              return (
                <button key={key} type="button" onClick={() => go({ f: key })} aria-current={active ? "page" : undefined}
                  className={cx("shrink-0 inline-flex items-center gap-2 h-8 px-2.5 rounded-lg text-[13px] whitespace-nowrap transition-colors",
                    "max-xl:rounded-full max-xl:border xl:w-full",
                    active ? "bg-ink text-bg max-xl:border-ink font-medium" : "max-xl:border-line text-muted hover:text-ink hover:bg-panel-2")}>
                  <Icon size={14} className="hidden xl:block shrink-0" />
                  <span className="xl:flex-1 xl:text-left">{label}</span>
                  {n ? (
                    <span className={cx("tabular-nums rounded-full px-1.5 text-[11px] leading-[18px]",
                      active ? "bg-bg/20" : key === "todo" ? "bg-accent text-accent-ink" : "bg-panel-2 text-muted")}>{fmtNum(n)}</span>
                  ) : null}
                </button>
              );
            })}
          </nav>
          {pending && <Spinner className="text-muted shrink-0 xl:hidden" />}
        </div>

        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-2">
            <button type="button" onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters}
              className="sm:pointer-events-none inline-flex items-center gap-1.5 text-[12px] font-medium text-muted uppercase tracking-[0.08em]">
              <SlidersHorizontal size={13} />Filters{filtersOn ? <Badge tone="accent">{filtersOn}</Badge> : null}
            </button>
            <span className="flex items-center gap-2">
              {pending && <Spinner className="text-muted hidden xl:inline-block" />}
              {filtersOn > 0 && <button type="button" onClick={() => go({ label: "", campaign: "", account: "" })} className="text-[12px] text-muted hover:text-ink underline">Clear</button>}
            </span>
          </div>
          <div className={cx("grid gap-2 sm:grid-cols-3 xl:grid-cols-1", !showFilters && "max-sm:hidden")}>
            <Select aria-label="Label" value={shown.label} onChange={(e) => go({ label: e.target.value })} className="h-8 text-[13px]">
              <option value="">Any label</option>
              {REPLY_LABELS.map((l) => {
                const n = counts.labels?.[l.key];
                return <option key={l.key} value={l.key}>{l.label}{n ? ` (${fmtNum(n)})` : ""}</option>;
              })}
            </Select>
            <Select aria-label="Campaign" value={shown.campaign} onChange={(e) => go({ campaign: e.target.value })} className="h-8 text-[13px]">
              <option value="">All campaigns</option>
              {options.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            <Select aria-label="Email account" value={shown.account} onChange={(e) => go({ account: e.target.value })} className="h-8 text-[13px]">
              <option value="">All email accounts</option>
              {options.mailboxes.map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}
            </Select>
          </div>
        </div>
      </div>

      {/* Conversation list */}
      <Card className={cx("overflow-hidden min-w-0 md:sticky md:top-6 md:max-h-[calc(100dvh-150px)] flex flex-col", selected && "max-md:hidden",
        !rows.length && "md:col-span-2")}>
        <div className="flex items-center gap-1.5 p-2 border-b border-line">
          <label className="relative flex-1 min-w-0">
            <span className="sr-only">Search conversations</span>
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
            <input ref={searchBox} type="search" value={search} onChange={(e) => onSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") { e.currentTarget.blur(); } }}
              placeholder="Search name, email or subject" className={cx(inputClass, "h-8 pl-8 text-[13px]")} />
          </label>
          <ShortcutHelp shortcuts={SHORTCUTS} showButton />
        </div>

        {noDetection.length > 0 && (
          <div className="px-3 py-2 border-b border-line bg-warn-soft text-[12.5px] grid gap-0.5">
            {noDetection.map((m) => (
              <div key={m.id} className="flex items-start gap-1.5">
                <TriangleAlert size={13} className="text-warn mt-0.5 shrink-0" />
                <span className="min-w-0 break-words">Replies can&apos;t be read for {m.email}. <Link href="/mailboxes" className="underline font-medium">Fix connection</Link></span>
              </div>
            ))}
          </div>
        )}

        <div className={cx("overflow-y-auto min-h-0 transition-opacity", pending && "opacity-60 pointer-events-none")} aria-busy={pending || undefined}>
          {rows.length === 0 ? (
            options.mailboxes.length === 0 ? (
              <Empty icon={<Mail size={28} />} title="No email account yet" action={<ButtonLink variant="secondary" href="/mailboxes?connect=1">Connect an email account</ButtonLink>}>
                Connect an email account to receive replies.
              </Empty>
            ) : searching ? (
              <Empty icon={<Search size={28} />} title="No conversations match"
                action={<Button onClick={() => { setSearch(""); go({ q: "", label: "", campaign: "", account: "" }); }}>Clear search and filters</Button>}>
                Try another search, or look in All.
              </Empty>
            ) : (
              <Empty icon={<Inbox size={28} />} title={EMPTY[filter.f].title}
                secondary={filter.f === "todo" && counts.next_reminder ? <>Next reminder: {fmtDay(counts.next_reminder)}</> : undefined}>
                {EMPTY[filter.f].body}
              </Empty>
            )
          ) : (
            <>
              {rows.map((r) => <Row key={r.id} row={r} active={selected?.id === r.id} now={now} onOpen={() => open(r.id)} />)}
              {hasMore && (
                <div className="p-2">
                  <Button size="sm" variant="ghost" className="w-full" disabled={loadingMore} onClick={loadMore}>
                    {loadingMore && <Spinner />}Load more
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </Card>

      {/* Conversation (full width on phones, with Back) */}
      {rows.length > 0 && (
        <div className={cx("min-w-0", !selected && "max-md:hidden")}>
          {selected
            ? <Conversation key={selected.id} row={selected} onChange={change(selected.id)} onBack={() => open(null)} />
            : <Card className="hidden md:block"><Empty icon={<CornerUpLeft size={28} />} title="Pick a conversation">Press J and K to move through the list.</Empty></Card>}
        </div>
      )}
    </div>
  );
}

function Row({ row: r, active, now, onOpen }: { row: InboxRow; active: boolean; now: number; onOpen: () => void }) {
  const lbl = replyLabel(r.sentiment);
  const who = r.leads?.company || r.from_email.split("@")[1] || "";
  const chip = r.follow_up_at && !r.handled ? reminderChip(r.follow_up_at, now) : null;
  return (
    <button id={`reply-${r.id}`} type="button" onClick={onOpen} aria-current={active || undefined}
      className={cx("w-full text-left px-3.5 py-3 border-b border-line last:border-0 transition-colors outline-none focus-visible:bg-panel-2",
        active ? "bg-accent-soft/60" : "hover:bg-panel-2/60")}>
      <div className="flex items-center gap-2">
        {!r.is_read && <span className="size-1.5 rounded-full bg-accent shrink-0" aria-label="Unread" />}
        <span className={cx("truncate flex-1", !r.is_read && "font-semibold")}>{r.from_name || r.from_email}</span>
        <RelativeTime iso={r.received_at} className="text-[11.5px] text-faint tabular-nums shrink-0" />
      </div>
      {who && <div className="text-[12px] text-faint truncate">{who}</div>}
      <div className={cx("text-[12.5px] truncate mt-0.5", r.is_read ? "text-muted" : "text-ink")}>{r.snippet || r.subject}</div>
      {(lbl || r.kind !== "reply" || chip || r.answered_at || r.campaigns?.name) && (
        <div className="flex flex-wrap items-center gap-1 mt-1.5">
          {r.kind !== "reply" && <Badge tone={r.kind === "bounce" ? "bad" : "neutral"}>{REPLY_KIND_LABEL[r.kind]}</Badge>}
          {lbl && <Badge tone={lbl.tone}>{lbl.label}</Badge>}
          {chip && <Badge tone={chip.tone}><AlarmClock size={11} />Reminder · {chip.text}</Badge>}
          {r.answered_at && <span title="You replied" className="text-good inline-flex"><CornerUpLeft size={12} /></span>}
          {r.campaigns?.name && <span className="text-[11.5px] text-faint truncate max-w-full">{r.campaigns.name}</span>}
        </div>
      )}
    </button>
  );
}
