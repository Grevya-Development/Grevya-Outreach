// Server-safe UI primitives (no hooks). Client-only pieces live in ./client.tsx.
import clsx, { type ClassValue } from "clsx";
import { Check } from "lucide-react";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { twMerge } from "tailwind-merge";
import { fmtNum } from "@/lib/format";
import { statusLabel, type StatusKind, type Tone } from "@/lib/labels";

export { timeAgo } from "@/lib/format";

/** Joins class names; later Tailwind classes win over earlier ones (a caller's `w-16` beats `w-full`). */
export function cx(...a: ClassValue[]): string {
  return twMerge(clsx(a));
}

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

export function buttonClass(variant: Variant = "secondary", size: Size = "md", extra?: string) {
  return cx(
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
  return <input {...props} className={cx(inputClass, className)} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea {...props} className={cx(inputClass, "h-auto py-2 leading-relaxed resize-y", className)} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select {...props} className={cx(inputClass, "pr-8 appearance-none bg-[length:16px] bg-[right_8px_center] bg-no-repeat", className)}
    style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%239a9aa0' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")" }} />;
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("grid grid-cols-1 gap-1.5", className)}>
      <span className="text-[12.5px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="text-[12px] text-muted leading-snug">{hint}</span>}
    </label>
  );
}

export function Card({ className, children, ...props }: ComponentProps<"div">) {
  return <div {...props} className={cx("rounded-xl border border-line bg-panel", className)}>{children}</div>;
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

export type { Tone };

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
    <span className={cx("inline-flex items-center gap-1 h-5 px-1.5 rounded-md text-[11.5px] font-medium whitespace-nowrap", toneClass[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

/** A status in plain words (labels.ts). Pass `kind` when a value means different things in different places. */
export function StatusBadge({ status, kind, className }: { status: string; kind?: StatusKind; className?: string }) {
  const { label, tone } = statusLabel(status, kind);
  return <Badge tone={tone} dot className={className}>{label}</Badge>;
}

export function PageHeader({ title, description, actions, tabs }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; tabs?: ReactNode }) {
  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold tracking-[-0.01em]">{title}</h1>
          {description && <p className="text-[13px] text-muted mt-0.5">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {tabs && <div className="mt-4">{tabs}</div>}
    </div>
  );
}

export type TabLinkItem = { href: string; label: ReactNode; count?: number | null; active: boolean; dot?: boolean };

/** Underlined tab bar of links (the tab is part of the URL, so back/forward and sharing work). */
export function TabLinks({ items, className }: { items: TabLinkItem[]; className?: string }) {
  return (
    <nav className={cx("flex gap-1 border-b border-line overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className)}>
      {items.map((t) => (
        <Link key={t.href} href={t.href} scroll={false} aria-current={t.active ? "page" : undefined}
          className={cx("relative shrink-0 inline-flex items-center h-9 px-3 text-[13.5px] whitespace-nowrap transition-colors",
            t.active ? "text-ink font-medium" : "text-muted hover:text-ink")}>
          {t.label}
          {t.count != null && <span className="ml-1.5 text-faint tabular-nums">{fmtNum(t.count)}</span>}
          {t.dot && <span className="ml-1.5 size-1.5 rounded-full bg-warn" />}
          {t.active && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />}
        </Link>
      ))}
    </nav>
  );
}

export type StepState = "done" | "current" | "todo";

/** Numbered steps (campaign builder). Done and current steps are links; later ones aren't yet. */
export function Stepper({ steps, className }: { steps: { label: string; href: string; state: StepState }[]; className?: string }) {
  return (
    <ol className={cx("flex items-center gap-1.5 sm:gap-2 min-w-0", className)}>
      {steps.map((s, i) => {
        const inner = (
          <>
            <span className={cx("grid place-items-center size-6 shrink-0 rounded-full text-[12px] font-semibold tabular-nums",
              s.state === "done" && "bg-accent text-accent-ink",
              s.state === "current" && "border-2 border-accent text-accent",
              s.state === "todo" && "border border-line text-faint")}>
              {s.state === "done" ? <Check size={13} strokeWidth={2.6} /> : i + 1}
            </span>
            <span className={cx("text-[13px] whitespace-nowrap", s.state === "current" ? "font-medium text-ink" : "hidden sm:inline",
              s.state === "done" && "text-muted", s.state === "todo" && "text-faint")}>{s.label}</span>
          </>
        );
        return (
          <li key={s.href} className="flex items-center gap-1.5 sm:gap-2 min-w-0">
            {i > 0 && <span className={cx("h-px w-4 sm:w-8 shrink-0", s.state === "todo" ? "bg-line" : "bg-accent/60")} />}
            {s.state === "todo"
              ? <span className="flex items-center gap-2" aria-disabled="true">{inner}</span>
              : <Link href={s.href} scroll={false} aria-current={s.state === "current" ? "step" : undefined}
                  className="flex items-center gap-2 rounded-lg hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">{inner}</Link>}
          </li>
        );
      })}
    </ol>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "good" | "bad" | "warn" }) {
  return (
    <Card className="px-4 py-3.5">
      <div className="text-[12px] text-muted">{label}</div>
      <div className={cx("text-[22px] font-semibold tabular-nums tracking-tight mt-0.5",
        tone === "good" && "text-good", tone === "bad" && "text-bad", tone === "warn" && "text-warn")}>{value}</div>
      {sub && <div className="text-[12px] text-faint mt-0.5">{sub}</div>}
    </Card>
  );
}

export function Progress({ value, max, className }: { value: number; max: number; className?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className={cx("h-1.5 rounded-full bg-panel-2 overflow-hidden", className)}>
      <div className={cx("h-full rounded-full transition-[width] duration-500", pct >= 100 ? "bg-warn" : "bg-accent")} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton", className)} />;
}

export function Empty({ icon, title, children, action, secondary }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode; secondary?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-14">
      {icon && <div className="mb-3 text-faint">{icon}</div>}
      <div className="font-medium">{title}</div>
      {children && <div className="text-[13px] text-muted mt-1 max-w-sm">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
      {secondary && <div className="mt-2.5 text-[13px] text-muted">{secondary}</div>}
    </div>
  );
}

export function Th({ className, ...props }: ComponentProps<"th">) {
  return <th {...props} className={cx("text-left text-[12px] font-medium text-muted px-3 h-9 border-b border-line whitespace-nowrap", className)} />;
}

export function Td({ className, ...props }: ComponentProps<"td">) {
  return <td {...props} className={cx("px-3 py-2.5 border-b border-line align-middle", className)} />;
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

/** A keyboard key hint, e.g. <Kbd>J</Kbd>. 'mod' reads as ⌘/Ctrl. */
export function Kbd({ children, className }: { children: string; className?: string }) {
  const text = children.split("+").map((k) => (k === "mod" ? "⌘/Ctrl" : k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1))).join(" ");
  return <kbd className={cx("inline-flex items-center h-5 min-w-5 justify-center px-1.5 rounded border border-line bg-panel-2 font-mono text-[11px] text-muted", className)}>{text}</kbd>;
}
