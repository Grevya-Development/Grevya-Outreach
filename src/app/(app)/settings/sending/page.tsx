import { connection } from "next/server";
import { Suspense } from "react";
import { setSendingPaused } from "@/app/actions/engine";
import { runEngineNow } from "@/app/actions/misc";
import { ActionButton, RelativeTime } from "@/components/client";
import { Card, CardHeader, cx, Skeleton } from "@/components/ui";
import { getEngineState, getSendingSchedule } from "@/lib/app-state";
import { env } from "@/lib/env";
import { fmtDay, fmtTime } from "@/lib/format";
import { isPublicUrl } from "@/lib/schedule";
import { db } from "@/lib/supabase";
import { ScheduleForm } from "./sending-client";

export const metadata = { title: "Sending" };

const PAUSE_CONFIRM = {
  title: "Pause all sending?",
  body: "No campaign emails go out until you resume. Replies are still collected and AI keeps writing.",
  confirmLabel: "Pause all sending",
};

export default function SendingSettingsPage() {
  return (
    <div className="grid gap-4">
      <Suspense fallback={<Skeleton className="h-[76px] rounded-xl" />}>
        <SendingStatus />
      </Suspense>
      <Suspense fallback={<Skeleton className="h-[300px] rounded-xl" />}>
        <Schedule />
      </Suspense>
      <Card>
        <CardHeader
          title="Send due emails now"
          description="Sending happens on its own every minute. Use this when troubleshooting: it sends what's due right now (at most one email per account) and checks for replies."
          actions={<ActionButton action={runEngineNow}>Send due emails now</ActionButton>}
        />
      </Card>
      <Suspense fallback={<Skeleton className="h-12 rounded-xl" />}>
        <Advanced />
      </Suspense>
    </div>
  );
}

async function SendingStatus() {
  await connection();
  const [engine, synced] = await Promise.all([
    getEngineState(),
    db().from("mailboxes").select("imap_synced_at").not("imap_synced_at", "is", null).order("imap_synced_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const inboxAt = (synced.data?.imap_synced_at as string | null | undefined) ?? null;
  const mode = engine.paused ? "paused" : engine.alive ? "on" : "stopped";
  return (
    <Card className={cx("flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5",
      mode === "paused" && "border-warn/30 bg-warn-soft", mode === "stopped" && "border-bad/30 bg-bad-soft")}>
      <span className={cx("size-2.5 shrink-0 rounded-full", mode === "on" ? "bg-good" : mode === "paused" ? "bg-warn" : "bg-bad")} />
      <div className="flex-1 min-w-[220px] text-[13.5px]">
        {mode === "on" && (
          <>
            <b className="font-semibold">Sending on</b>
            <span className="text-muted"> · last run <RelativeTime iso={engine.lastTick} /> · {inboxAt ? <>inbox checked <RelativeTime iso={inboxAt} /></> : "inbox not checked yet"}</span>
          </>
        )}
        {mode === "paused" && (
          <>
            <b className="font-semibold text-warn">Paused by you{engine.pausedAt ? ` since ${fmtTime(engine.pausedAt)}` : ""}</b>
            <span className="block text-[12.5px] text-muted mt-0.5">No campaign emails go out until you resume. Replies are still collected and AI keeps writing.</span>
          </>
        )}
        {mode === "stopped" && (
          <>
            <b className="font-semibold text-bad">Sending stopped: last run {engine.lastTick ? <RelativeTime iso={engine.lastTick} /> : "never"}</b>
            <span className="block text-[12.5px] text-muted mt-0.5">
              Sending runs inside the app and starts with it. Restart the app, or see Advanced below if it runs somewhere else.
              {engine.lastTick ? ` Last seen ${fmtDay(engine.lastTick)}, ${fmtTime(engine.lastTick)}.` : ""}
            </span>
          </>
        )}
      </div>
      {mode === "paused"
        ? <ActionButton variant="primary" action={setSendingPaused.bind(null, false)}>Resume sending</ActionButton>
        : <ActionButton variant="primary" action={setSendingPaused.bind(null, true)} confirm={PAUSE_CONFIRM}>Pause all sending</ActionButton>}
    </Card>
  );
}

async function Schedule() {
  await connection();
  const [schedule, mailboxes] = await Promise.all([
    getSendingSchedule(),
    db().from("mailboxes").select("timezone, window_start, window_end, send_days"),
  ]);
  // Accounts whose own hours differ from the shared schedule (saving replaces them).
  const key = (s: { timezone: string; window_start: number; window_end: number; send_days: number[] }) =>
    `${s.timezone}|${s.window_start}|${s.window_end}|${[...(s.send_days ?? [])].sort().join(",")}`;
  const differing = (mailboxes.data ?? []).filter((m) => key(m) !== key(schedule)).length;
  return <ScheduleForm initial={schedule} differing={differing} />;
}

async function Advanced() {
  await connection(); // read env at request time, not build time
  const tickUrl = `${env.appUrl}/api/engine/tick`;
  return (
    <details className="group rounded-xl border border-line bg-panel">
      <summary className="cursor-pointer select-none list-none px-4 py-3 text-[13.5px] font-medium flex items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
        Advanced
        <span className="text-[12px] font-normal text-faint group-open:hidden">How sending runs, cron, APP_URL</span>
      </summary>
      <div className="px-4 pb-4 grid gap-4 text-[13px] border-t border-line pt-3">
        <div>
          <div className="font-medium">Runs with the app</div>
          <p className="text-muted mt-0.5">Sending, reply checks and AI writing start automatically when the app starts. Nothing else needs to run.</p>
        </div>
        <div>
          <div className="font-medium">On a separate machine</div>
          <p className="text-muted mt-0.5">
            Set <code className="font-mono text-[12.5px]">ENGINE_IN_APP=off</code> for this app, then run this on an always-on machine (a small VPS, Railway, Render):
          </p>
          <pre className="mt-2 rounded-lg bg-panel-2 px-3 py-2 font-mono text-[12.5px] overflow-x-auto">npm run worker</pre>
        </div>
        <div>
          <div className="font-medium">Serverless hosting (e.g. Vercel)</div>
          <p className="text-muted mt-0.5">Have a cron service (e.g. cron-job.org) call this every minute:</p>
          <pre className="mt-2 rounded-lg bg-panel-2 px-3 py-2 font-mono text-[12px] overflow-x-auto">{`GET ${tickUrl}
Authorization: Bearer <CRON_SECRET>`}{!env.cronSecret && "\n# CRON_SECRET is not set in your env yet"}</pre>
        </div>
        {!isPublicUrl(env.appUrl) && (
          <p className="rounded-lg bg-warn-soft text-warn px-3 py-2.5 text-[12.5px]">
            APP_URL is {env.appUrl}. If the app runs at another address (e.g. port 3001), set APP_URL so unsubscribe and tracking links work.
          </p>
        )}
      </div>
    </details>
  );
}
