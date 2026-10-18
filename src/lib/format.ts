// Date and number formatting that gives the same string on the server and in the browser (so no
// hydration mismatches): a fixed locale and timezone, and month/day names from our own tables
// instead of the runtime's locale data (which differs between Node and browsers, e.g. "Sep"/"Sept").

/** Timezone every date in the UI is shown in. */
export const APP_TZ = process.env.NEXT_PUBLIC_APP_TIMEZONE || "Asia/Kolkata";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type DateInput = string | number | Date | null | undefined;
type Parts = { y: number; m: number; d: number; wd: number; h: number; min: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    const opts: Intl.DateTimeFormatOptions = { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" };
    try {
      f = new Intl.DateTimeFormat("en-IN", { ...opts, timeZone });
    } catch {
      f = new Intl.DateTimeFormat("en-IN", { ...opts, timeZone: "Asia/Kolkata" }); // bad NEXT_PUBLIC_APP_TIMEZONE
    }
    formatters.set(timeZone, f);
  }
  return f;
}

/** Calendar parts of a date in APP_TZ. 'YYYY-MM-DD' strings are calendar dates and never shift. */
function parts(input: DateInput): Parts | null {
  if (input == null || input === "") return null;
  const dateOnly = typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input);
  const date = dateOnly ? new Date(`${input}T00:00:00Z`) : input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  const p: Record<string, number> = {};
  for (const { type, value } of formatter(dateOnly ? "UTC" : APP_TZ).formatToParts(date)) {
    if (type !== "literal") p[type] = Number(value);
  }
  const wd = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return { y: p.year, m: p.month, d: p.day, wd, h: (p.hour ?? 0) % 24, min: p.minute ?? 0 };
}

function clock(p: Parts): string {
  const h12 = p.h % 12 || 12;
  return `${h12}:${String(p.min).padStart(2, "0")} ${p.h < 12 ? "am" : "pm"}`;
}

/** '25 Nov' (or '25 Nov 2026' with `year`, 'Tue 25 Nov' with `weekday`). */
export function fmtDate(input: DateInput, opts?: { year?: boolean | "numeric"; weekday?: boolean | "short" }): string {
  const p = parts(input);
  if (!p) return "—";
  return `${opts?.weekday ? `${DAYS[p.wd]} ` : ""}${p.d} ${MONTHS[p.m - 1]}${opts?.year ? ` ${p.y}` : ""}`;
}

/** 'Mon 5 Oct' */
export function fmtDay(input: DateInput): string {
  return fmtDate(input, { weekday: true });
}

/** '5 Oct, 3:42 pm' */
export function fmtDateTime(input: DateInput): string {
  const p = parts(input);
  return p ? `${p.d} ${MONTHS[p.m - 1]}, ${clock(p)}` : "—";
}

/** '3:42 pm' */
export function fmtTime(input: DateInput): string {
  const p = parts(input);
  return p ? clock(p) : "—";
}

const numberFormat = new Intl.NumberFormat("en-IN");

/** Indian digit grouping: 1,23,456. */
export function fmtNum(n: number | null | undefined): string {
  return n == null || Number.isNaN(n) ? "—" : numberFormat.format(n);
}

/** '5m ago' / 'in 2h'. Depends on the current time: render it through <RelativeTime>. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const fut = s < 0;
  const a = Math.abs(s);
  const v = a < 60 ? `${a}s` : a < 3600 ? `${Math.round(a / 60)}m` : a < 86400 ? `${Math.round(a / 3600)}h` : `${Math.round(a / 86400)}d`;
  return fut ? `in ${v}` : `${v} ago`;
}
