// Server-safe UI primitives (no hooks). Client-only pieces live in ./client.tsx.
import clsx from "clsx";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

export { clsx as cx };

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

export function buttonClass(variant: Variant = "secondary", size: Size = "md", extra?: string) {
  return clsx(
    "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap select-none",
    "transition-[background,color,box-shadow,opacity] duration-100 active:scale-[0.98]",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
    "disabled:opacity-50 disabled:pointer-events-none",
    size === "sm" ? "h-8 px-2.5 text-[13px]" : "h-9 px-3.5 text-[13.5px]",
    variant === "primary" && "bg-accent text-accent-ink hover:opacity-90 shadow-sm",
    variant === "secondary" && "bg-panel text-ink border border-line hover:bg-panel-2 shadow-[0_1px_0_rgb(0_0_0/0.03)]",
    variant === "ghost" && "text-muted hover:text-ink hover:bg-panel-2",
    variant === "danger" && "bg-bad-soft text-bad hover:opacity-85",
    extra,
  );
}

export function Button({ variant, size, className, ...props }: ComponentProps<"button"> & { variant?: Variant; size?: Size }) {
  return <button {...props} className={buttonClass(variant, size, className)} />;
}

export function ButtonLink({ variant, size, className, ...props }: ComponentProps<typeof Link> & { variant?: Variant; size?: Size }) {
  return <Link {...props} className={buttonClass(variant, size, className)} />;
}

export const inputClass =
  "w-full h-9 rounded-lg border border-line bg-panel px-3 text-[13.5px] text-ink placeholder:text-faint " +
  "outline-none transition-shadow focus:border-accent focus:ring-3 focus:ring-accent/15";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input {...props} className={clsx(inputClass, className)} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea {...props} className={clsx(inputClass, "h-auto py-2 leading-relaxed resize-y", className)} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select {...props} className={clsx(inputClass, "pr-8 appearance-none bg-[length:16px] bg-[right_8px_center] bg-no-repeat", className)}
    style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%239a9aa0' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")" }} />;
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={clsx("grid gap-1.5", className)}>
      <span className="text-[12.5px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="text-[12px] text-muted leading-snug">{hint}</span>}
    </label>
  );
}

export function Card({ className, children, ...props }: ComponentProps<"div">) {
  return <div {...props} className={clsx("rounded-xl border border-line bg-panel", className)}>{children}</div>;
}

export function CardHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-3">
      <div className="min-w-0">
        <h2 className="text-[14px] font-semibold">{title}</h2>
        {description && <p className="text-[12.5px] text-muted mt-0.5">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

type Tone = "neutral" | "accent" | "good" | "warn" | "bad" | "info";
const toneClass: Record<Tone, string> = {
  neutral: "bg-panel-2 text-muted",
  accent: "bg-accent-soft text-accent",
  good: "bg-good-soft text-good",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  info: "bg-info-soft text-info",
};

export function Badge({ tone = "neutral", children, dot, className }: { tone?: Tone; children: ReactNode; dot?: boolean; className?: string }) {
  return (
    <span className={clsx("inline-flex items-center gap-1 h-5 px-1.5 rounded-md text-[11.5px] font-medium whitespace-nowrap", toneClass[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

const statusTone: Record<string, Tone> = {
  active: "good", draft: "neutral", paused: "warn", completed: "info", error: "bad",
  queued: "neutral", in_progress: "accent", replied: "good", bounced: "bad", unsubscribed: "warn", failed: "bad", skipped: "neutral",
  valid: "good", invalid: "bad", risky: "warn", unknown: "neutral",
  interested: "good", not_interested: "bad", neutral: "neutral", reply: "accent", auto_reply: "neutral", bounce: "bad",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={statusTone[status] ?? "neutral"} dot>{status.replace(/_/g, " ")}</Badge>;
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
      <div className="min-w-0">
        <h1 className="text-[20px] font-semibold tracking-[-0.01em]">{title}</h1>
        {description && <p className="text-[13px] text-muted mt-0.5">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "good" | "bad" | "warn" }) {
  return (
    <Card className="px-4 py-3.5">
      <div className="text-[12px] text-muted">{label}</div>
      <div className={clsx("text-[22px] font-semibold tabular-nums tracking-tight mt-0.5",
        tone === "good" && "text-good", tone === "bad" && "text-bad", tone === "warn" && "text-warn")}>{value}</div>
      {sub && <div className="text-[12px] text-faint mt-0.5">{sub}</div>}
    </Card>
  );
}

export function Progress({ value, max, className }: { value: number; max: number; className?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className={clsx("h-1.5 rounded-full bg-panel-2 overflow-hidden", className)}>
      <div className={clsx("h-full rounded-full transition-[width] duration-500", pct >= 100 ? "bg-warn" : "bg-accent")} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("skeleton", className)} />;
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-14">
      {icon && <div className="mb-3 text-faint">{icon}</div>}
      <div className="font-medium">{title}</div>
      {children && <div className="text-[13px] text-muted mt-1 max-w-sm">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Th({ className, ...props }: ComponentProps<"th">) {
  return <th {...props} className={clsx("text-left text-[12px] font-medium text-muted px-3 h-9 border-b border-line whitespace-nowrap", className)} />;
}

export function Td({ className, ...props }: ComponentProps<"td">) {
  return <td {...props} className={clsx("px-3 py-2.5 border-b border-line align-middle", className)} />;
}

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <Card className="p-4 grid gap-3">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-7" />)}
    </Card>
  );
}

export function pct(n: number, d: number): string {
  if (!d) return "—";
  const v = (n / d) * 100;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const fut = s < 0;
  const a = Math.abs(s);
  const v = a < 60 ? `${a}s` : a < 3600 ? `${Math.round(a / 60)}m` : a < 86400 ? `${Math.round(a / 3600)}h` : `${Math.round(a / 86400)}d`;
  return fut ? `in ${v}` : `${v} ago`;
}
