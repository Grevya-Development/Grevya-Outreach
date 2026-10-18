"use client";

import Link from "next/link";
import { useOptimistic } from "react";
import { setSendingPaused } from "@/app/actions/engine";
import { fmtTime } from "@/lib/format";
import { Spinner, Switch, useAction, useConfirm } from "./client";
import { buttonClass, cx } from "./ui";

export type SendingState = { alive: boolean; paused: boolean; pausedAt: string | null; lastTick: string | null };

const PAUSE_CONFIRM = {
  title: "Pause all sending?",
  body: "No campaign emails go out until you resume. Replies are still collected and AI keeps writing.",
  confirmLabel: "Pause all sending",
};

/** Sidebar footer: Sending on (switch to pause) / Paused (Resume) / Sending stopped (link to settings). */
export function SendingPill({ state, compact }: { state: SendingState; compact?: boolean }) {
  const [pending, run] = useAction();
  const { confirm, element } = useConfirm();
  // Flip the pill straight away; the action's refresh() brings the real state back.
  const [view, setView] = useOptimistic({ paused: state.paused, pausedAt: state.pausedAt });

  const pause = async () => {
    if (!(await confirm(PAUSE_CONFIRM))) return;
    run(async () => {
      setView({ paused: true, pausedAt: new Date().toISOString() });
      return setSendingPaused(true);
    });
  };
  const resume = () => run(async () => {
    setView({ paused: false, pausedAt: null });
    return setSendingPaused(false);
  });

  const mode = view.paused ? "paused" : state.alive ? "on" : "stopped";
  const text = mode === "paused" ? `Paused${view.pausedAt ? ` · since ${fmtTime(view.pausedAt)}` : ""}` : mode === "on" ? "Sending on" : "Sending stopped";
  const dot = <span className={cx("size-2 shrink-0 rounded-full", mode === "on" ? "bg-good" : mode === "paused" ? "bg-warn" : "bg-bad")} />;

  if (compact) {
    const cls = "relative grid place-items-center size-9 shrink-0 rounded-lg hover:bg-panel-2 disabled:opacity-50";
    return (
      <>
        {mode === "stopped"
          ? <Link href="/settings/sending" className={cls} aria-label={`${text}. Open sending settings`} title={text}>{dot}</Link>
          : <button type="button" className={cls} disabled={pending} onClick={mode === "on" ? pause : resume}
              aria-label={mode === "on" ? "Sending on. Pause all sending" : `${text}. Resume sending`} title={text}>{pending ? <Spinner className="size-3" /> : dot}</button>}
        {element}
      </>
    );
  }

  return (
    <div className={cx("flex items-center gap-2 min-h-10 rounded-lg border px-2.5 py-1.5 text-[12.5px]",
      mode === "on" ? "border-line bg-panel" : mode === "paused" ? "border-warn/30 bg-warn-soft" : "border-bad/30 bg-bad-soft")}>
      {dot}
      {mode === "stopped" ? (
        <Link href="/settings/sending" className="flex-1 min-w-0 font-medium text-bad hover:underline">{text}</Link>
      ) : (
        <span className={cx("flex-1 min-w-0 truncate font-medium", mode === "paused" && "text-warn")}>{text}</span>
      )}
      {mode === "on" && <Switch checked onChange={() => void pause()} disabled={pending} label="Pause all sending" />}
      {mode === "paused" && (
        <button type="button" className={buttonClass("secondary", "sm", "h-7 px-2 text-[12px]")} disabled={pending} onClick={resume}>
          {pending && <Spinner className="size-3" />}Resume
        </button>
      )}
      {element}
    </div>
  );
}
