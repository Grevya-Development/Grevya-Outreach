"use client";

import { useState } from "react";
import { saveSendingSchedule } from "@/app/actions/misc";
import { Spinner, useAction } from "@/components/client";
import { Button, Card, CardHeader, cx, Field, Select } from "@/components/ui";
import type { SendingSchedule } from "@/lib/app-state";

const TIMEZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Los_Angeles", "Australia/Sydney", "UTC"];
// Monday first; values are JS weekdays (0 = Sunday), as stored in mailboxes.send_days.
const DAYS: [number, string][] = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]];
const FROM_HOURS = Array.from({ length: 24 }, (_, h) => h); // 0–23
const TO_HOURS = Array.from({ length: 24 }, (_, h) => h + 1); // 1–24 (24 = midnight, end of day)

function hourLabel(h: number): string {
  if (h === 0 || h === 24) return "12 am (midnight)";
  if (h === 12) return "12 pm (noon)";
  return h < 12 ? `${h} am` : `${h - 12} pm`;
}

const same = (a: SendingSchedule, b: SendingSchedule) =>
  a.timezone === b.timezone && a.window_start === b.window_start && a.window_end === b.window_end
  && [...a.send_days].sort().join() === [...b.send_days].sort().join();

/** Settings → Sending: the one schedule every email account sends inside. */
export function ScheduleForm({ initial, differing }: { initial: SendingSchedule; differing: number }) {
  const [s, setS] = useState(initial);
  const [base, setBase] = useState(initial);
  const [saving, run] = useAction();
  const dirty = !same(s, base);
  const invalid = s.window_end <= s.window_start ? "The end time must be after the start time." : !s.send_days.length ? "Pick at least one day." : null;
  const toggleDay = (d: number) => setS((x) => ({ ...x, send_days: x.send_days.includes(d) ? x.send_days.filter((y) => y !== d) : [...x.send_days, d] }));
  const zones = TIMEZONES.includes(s.timezone) ? TIMEZONES : [s.timezone, ...TIMEZONES];

  return (
    <Card>
      <CardHeader title="Sending schedule" description="Applies to all email accounts. Change one account under Email accounts → Edit → Advanced." />
      <div className="px-4 pb-4 grid gap-4">
        <Field label="Timezone" className="max-w-xs">
          <Select value={s.timezone} onChange={(e) => setS((x) => ({ ...x, timezone: e.target.value }))}>
            {zones.map((t) => <option key={t}>{t}</option>)}
          </Select>
        </Field>
        <div className="grid gap-1.5">
          <span className="text-[12.5px] font-medium">Days</span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Sending days">
            {DAYS.map(([d, label]) => {
              const on = s.send_days.includes(d);
              return (
                <button key={d} type="button" aria-pressed={on} onClick={() => toggleDay(d)}
                  className={cx("h-8 min-w-12 px-3 rounded-lg border text-[13px] font-medium transition-colors",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                    on ? "border-accent bg-accent-soft text-accent" : "border-line bg-panel text-muted hover:bg-panel-2")}>
                  {label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 max-w-md">
          <Field label="From">
            <Select value={s.window_start} onChange={(e) => setS((x) => ({ ...x, window_start: Number(e.target.value) }))}>
              {FROM_HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </Select>
          </Field>
          <Field label="To">
            <Select value={s.window_end} onChange={(e) => setS((x) => ({ ...x, window_end: Number(e.target.value) }))}>
              {TO_HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </Select>
          </Field>
        </div>
        {differing > 0 && (
          <p className="text-[12.5px] text-muted">
            {differing === 1 ? "1 email account has its" : `${differing} email accounts have their`} own hours right now. Saving replaces them with this schedule.
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-3">
          {invalid ? <span className="text-[12.5px] text-bad">{invalid}</span> : dirty && <span className="text-[12.5px] text-warn">Unsaved changes</span>}
          <Button disabled={saving || !!invalid || (!dirty && !differing)}
            onClick={() => run(() => saveSendingSchedule(s), () => setBase(s))}>
            {saving && <Spinner />}Save schedule
          </Button>
        </div>
      </div>
    </Card>
  );
}
