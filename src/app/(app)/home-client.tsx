"use client";

import { CheckCircle2, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePoll } from "@/components/client";
import { Card, CardHeader, cx } from "@/components/ui";
import { fmtNum } from "@/lib/format";

export type CampaignCount = { id: string; name: string; n: number };

/** What GET /api/home/live returns (and what the page passes in first). */
export type LiveCounts = {
  todo: number;
  reminders_due: number;
  review_by_campaign: CampaignCount[];
  failed_by_campaign: CampaignCount[];
  error_accounts: number;
  unchecked: number;
  engine: { alive: boolean; paused: boolean };
};

const plural = (n: number, one: string, many: string) => `${fmtNum(n)} ${n === 1 ? one : many}`;

type Row = { key: string; href: string; text: string; sub?: string; tone: "accent" | "warn" | "bad" | "neutral" };

function rows(c: LiveCounts): Row[] {
  const out: Row[] = [];
  const replies = Math.max(0, c.todo - c.reminders_due);
  if (replies) out.push({ key: "replies", href: "/inbox?f=todo", text: `${plural(replies, "reply needs", "replies need")} an answer`, tone: "accent" });
  if (c.reminders_due) out.push({ key: "reminders", href: "/inbox?f=todo", text: `${plural(c.reminders_due, "reminder", "reminders")} due`, tone: "warn" });
  for (const r of c.review_by_campaign) {
    out.push({ key: `review-${r.id}`, href: `/campaigns/${r.id}?tab=review`, text: `${plural(r.n, "AI email", "AI emails")} to review in ${r.name}`, tone: "warn" });
  }
  for (const f of c.failed_by_campaign) {
    out.push({ key: `failed-${f.id}`, href: `/campaigns/${f.id}?tab=leads&status=ai_failed`, text: `${plural(f.n, "email", "emails")} the AI couldn't write (${f.name})`, tone: "bad" });
  }
  if (c.error_accounts) out.push({ key: "accounts", href: "/mailboxes", text: `${plural(c.error_accounts, "email account has", "email accounts have")} a problem`, tone: "bad" });
  if (c.unchecked) {
    out.push({
      key: "unchecked", href: "/leads?check=unchecked", text: `${plural(c.unchecked, "lead", "leads")} waiting for an email check`, tone: "neutral",
      sub: c.engine.alive && !c.engine.paused ? "Checking in the background" : undefined,
    });
  }
  return out;
}

/** Home's "Needs you" list. Starts from the server's counts, then polls a GET route every minute (never a page refresh). */
export function NeedsYou({ initial }: { initial: LiveCounts }) {
  const [counts, setCounts] = useState(initial);
  // A server render (e.g. after Resume sending) brings fresher counts: take them.
  const [from, setFrom] = useState(initial);
  if (from !== initial) {
    setFrom(initial);
    setCounts(initial);
  }

  const inflight = useRef<AbortController | null>(null);
  useEffect(() => () => inflight.current?.abort(), []);
  usePoll(async () => {
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    const res = await fetch("/api/home/live", { signal: ctrl.signal, cache: "no-store" });
    if (res.ok) setCounts((await res.json()) as LiveCounts);
  }, 60_000);

  const list = rows(counts);
  return (
    <Card>
      <CardHeader title="Needs you" />
      {list.length === 0 ? (
        <p className="flex items-center gap-2 px-4 pb-4 text-[13px] text-muted"><CheckCircle2 size={15} className="text-good shrink-0" />Nothing needs you right now.</p>
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {list.map((r) => (
            <li key={r.key}>
              <Link href={r.href} className="flex items-center gap-3 px-4 py-2.5 text-[13.5px] hover:bg-panel-2/60 transition-colors">
                <span className={cx("size-1.5 rounded-full shrink-0",
                  r.tone === "accent" && "bg-accent", r.tone === "warn" && "bg-warn", r.tone === "bad" && "bg-bad", r.tone === "neutral" && "bg-faint")} />
                <span className="flex-1 min-w-0">
                  <span className="block truncate">{r.text}</span>
                  {r.sub && <span className="block text-[12px] text-faint">{r.sub}</span>}
                </span>
                <ChevronRight size={15} className="text-faint shrink-0" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
