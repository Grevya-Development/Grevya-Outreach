"use client";

import { Keyboard, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  cloneElement, Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition,
  type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactElement, type ReactNode,
} from "react";
import { toast, Toaster } from "sonner";
import { fmtDateTime, timeAgo } from "@/lib/format";
import { buttonClass, cx, inputClass, Kbd } from "./ui";

type ToastAction = { label: string; href: string };
export type ActionResult =
  | { ok: true; message?: string; action?: ToastAction }
  | { ok: false; error: string; action?: ToastAction };

/** Runs a server action with pending state + toast. A result's `action` becomes a toast button that navigates. */
export function useAction() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ActionResult | void>, onOk?: () => void) =>
    start(async () => {
      try {
        const res = await fn();
        const extra = res?.action ? { action: { label: res.action.label, onClick: () => router.push(res.action!.href) } } : undefined;
        if (res && !res.ok) toast.error(res.error, extra);
        else {
          if (res?.message) toast.success(res.message, extra);
          else if (extra) toast.success("Done", extra);
          onOk?.();
        }
      } catch (err) {
        toast.error((err as Error).message || "Something went wrong");
      }
    });
  return [pending, run] as const;
}

export type ConfirmOptions = {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  tone?: "danger" | "primary";
  /** The confirm button stays disabled until the user types exactly this. */
  requireText?: string;
};

export function ActionButton({
  action, children, variant = "secondary", size = "md", confirm, className, disabled, title,
}: {
  action: () => Promise<ActionResult | void>;
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  /** Ask first: a question, or full ConfirmDialog options. */
  confirm?: string | Omit<ConfirmOptions, "requireText">;
  className?: string;
  disabled?: boolean;
  title?: string;
}) {
  const [pending, run] = useAction();
  const { confirm: ask, element } = useConfirm();
  return (
    <>
      <button
        type="button"
        title={title}
        disabled={pending || disabled}
        className={buttonClass(variant, size, className)}
        onClick={async () => {
          if (confirm) {
            const opts = typeof confirm === "string" ? { title: confirm } : confirm;
            if (!(await ask({ tone: variant === "danger" ? "danger" : "primary", ...opts }))) return;
          }
          run(action);
        }}
      >
        {pending ? <Spinner /> : null}
        {children}
      </button>
      {element}
    </>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cx("size-3.5 rounded-full border-2 border-current border-r-transparent animate-spin", className)} />;
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors duration-150 disabled:opacity-50",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        checked ? "bg-accent" : "bg-line",
      )}
    >
      <span className={cx("absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform duration-150", checked && "translate-x-4")} />
    </button>
  );
}

/**
 * Puts the cursor where the user will type first. React strips the `autoFocus` attribute from the
 * DOM, so callers mark the field with `data-autofocus` (next to `autoFocus`). Otherwise: the first
 * text field (not a select, which would open a picker on mobile), then any select.
 */
function focusFirstField(root: HTMLElement) {
  (root.querySelector<HTMLElement>("[autofocus],[data-autofocus]")
    ?? root.querySelector<HTMLElement>("input:not([type=hidden]):not([disabled]), textarea:not([disabled])")
    ?? root.querySelector<HTMLElement>("select:not([disabled])"))?.focus();
}

/** Opens/closes a native <dialog> to match `open`. */
function useModal(open: boolean, onOpen?: (d: HTMLDialogElement) => void) {
  const ref = useRef<HTMLDialogElement>(null);
  const onOpenRef = useRef(onOpen);
  useEffect(() => { onOpenRef.current = onOpen; });
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      onOpenRef.current?.(d);
    }
    if (!open && d.open) d.close();
  }, [open]);
  return ref;
}

export function Dialog({
  open, onClose, title, description, children, footer, wide, toaster = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Render a toaster inside the dialog (off for dialogs stacked on another dialog). */
  toaster?: boolean;
}) {
  // showModal focuses the close button; put the cursor in the right field instead.
  const ref = useModal(open, focusFirstField);
  return (
    <dialog
      ref={ref}
      // React bubbles a nested <dialog>'s close event (e.g. a ConfirmDialog inside this one) up to
      // every ancestor's onClose; only react to this dialog's own close.
      onClose={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className={cx(
        "m-auto p-0 rounded-2xl border border-line bg-panel text-ink shadow-2xl w-[calc(100vw-32px)] max-h-[calc(100vh-48px)]",
        wide ? "max-w-3xl" : "max-w-lg",
      )}
    >
      {open && (
        <div className="flex flex-col max-h-[calc(100vh-48px)]">
          <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3 border-b border-line">
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold">{title}</h2>
              {description && <p className="text-[12.5px] text-muted mt-0.5">{description}</p>}
            </div>
            <button type="button" onClick={onClose} className={buttonClass("ghost", "sm", "w-8 px-0 -mr-2")} aria-label="Close"><X size={16} /></button>
          </div>
          <div className="px-5 py-4 overflow-y-auto overflow-x-hidden min-w-0">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 px-5 py-3 border-t border-line bg-panel-2/50 rounded-b-2xl">{footer}</div>}
        </div>
      )}
      {/* A modal <dialog> sits above the page, so the page-level toaster would be hidden behind it. */}
      {open && toaster && <Toaster position="top-center" richColors closeButton />}
    </dialog>
  );
}

/** Right-side sheet (full screen on phones), e.g. lead details. Closes like Dialog. */
export function Drawer({
  open, onClose, title, children, footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useModal(open, (d) => d.querySelector<HTMLElement>("[autofocus],[data-autofocus]")?.focus());
  return (
    <dialog
      ref={ref}
      // React bubbles a nested <dialog>'s close event (e.g. a ConfirmDialog inside this one) up to
      // every ancestor's onClose; only react to this dialog's own close.
      onClose={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className="ml-auto mr-0 my-0 p-0 h-dvh max-h-dvh w-full max-w-full sm:max-w-[560px] border-0 sm:border-l border-line bg-panel text-ink shadow-2xl"
    >
      {open && (
        <div className="flex flex-col h-full">
          <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3 border-b border-line">
            <h2 className="text-[15px] font-semibold min-w-0 break-words">{title}</h2>
            <button type="button" onClick={onClose} className={buttonClass("ghost", "sm", "w-8 px-0 -mr-2 shrink-0")} aria-label="Close"><X size={16} /></button>
          </div>
          <div className="flex-1 px-5 py-4 overflow-y-auto overflow-x-hidden min-w-0">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 px-5 py-3 border-t border-line bg-panel-2/50">{footer}</div>}
        </div>
      )}
      {open && <Toaster position="top-center" richColors closeButton />}
    </dialog>
  );
}

/** Styled replacement for the browser confirm box. Usually used through useConfirm(). */
export function ConfirmDialog({
  open, title, body, confirmLabel = "Confirm", tone = "primary", requireText, onConfirm, onCancel,
}: ConfirmOptions & { open: boolean; onConfirm: () => void; onCancel: () => void }) {
  const [typed, setTyped] = useState("");
  const blocked = !!requireText && typed.trim() !== requireText;
  const close = () => { setTyped(""); onCancel(); };
  return (
    <Dialog open={open} onClose={close} title={title} toaster={false}
      footer={
        <>
          <button type="button" className={buttonClass("secondary")} onClick={close} data-autofocus={tone === "danger" && !requireText ? "" : undefined}>Cancel</button>
          <button type="button" className={buttonClass(tone === "danger" ? "danger" : "primary")} disabled={blocked}
            data-autofocus={tone !== "danger" && !requireText ? "" : undefined}
            onClick={() => { setTyped(""); onConfirm(); }}>{confirmLabel}</button>
        </>
      }>
      {body && <div className="text-[13.5px] text-muted leading-relaxed">{body}</div>}
      {requireText && (
        <label className={cx("grid gap-1.5", body && "mt-3")}>
          <span className="text-[12.5px] font-medium">Type <b className="font-mono">{requireText}</b> to confirm</span>
          <input className={inputClass} value={typed} onChange={(e) => setTyped(e.target.value)} data-autofocus=""
            onKeyDown={(e) => { if (e.key === "Enter" && !blocked) { setTyped(""); onConfirm(); } }} />
        </label>
      )}
      {!body && !requireText && <p className="text-[13.5px] text-muted">Are you sure?</p>}
    </Dialog>
  );
}

/**
 * `const { confirm, element } = useConfirm()`; render `element` once, then
 * `if (await confirm({ title, body, confirmLabel, tone })) …`.
 */
export function useConfirm() {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const confirm = useCallback((o: ConfirmOptions) => {
    resolver.current?.(false); // a new question cancels one still open
    setOpts(o);
    return new Promise<boolean>((resolve) => { resolver.current = resolve; });
  }, []);
  const settle = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpts(null);
  }, []);
  const element = (
    <ConfirmDialog open={!!opts} title={opts?.title ?? ""} body={opts?.body} confirmLabel={opts?.confirmLabel} tone={opts?.tone}
      requireText={opts?.requireText} onConfirm={() => settle(true)} onCancel={() => settle(false)} />
  );
  return { confirm, element };
}

export type MenuItem = {
  label: ReactNode;
  icon?: ReactNode;
  onSelect?: () => void;
  href?: string;
  tone?: "danger";
  disabled?: boolean;
  hidden?: boolean;
};

/**
 * Click-to-open popover menu. Escape, a click outside or choosing an item closes it (focus goes back
 * to the trigger); ArrowUp/ArrowDown move between items.
 */
export function Menu({ trigger, items, align = "end", className }: {
  trigger: ReactElement<{ onClick?: (e: ReactMouseEvent<HTMLElement>) => void }>;
  items: MenuItem[];
  align?: "start" | "end";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const visible = items.filter((i) => !i.hidden);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) (wrap.current?.firstElementChild as HTMLElement | null)?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, close]);

  // Open upwards when there's no room below, then focus the first item.
  useLayoutEffect(() => {
    if (!open || !list.current || !wrap.current) return;
    const below = window.innerHeight - wrap.current.getBoundingClientRect().bottom;
    setUp(below < list.current.offsetHeight + 12 && wrap.current.getBoundingClientRect().top > list.current.offsetHeight + 12);
    list.current.querySelector<HTMLElement>("[role=menuitem]:not([aria-disabled=true])")?.focus();
  }, [open]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // don't also close a dialog the menu sits in
      close(true);
      return;
    }
    if (e.key === "Tab") return close(false);
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const els = [...(list.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([aria-disabled=true])") ?? [])];
    if (!els.length) return;
    const i = els.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? els.length - 1
      : e.key === "ArrowDown" ? (i + 1) % els.length : (i - 1 + els.length) % els.length;
    els[next].focus();
  };

  const itemClass = (i: MenuItem) => cx(
    "flex w-full items-center gap-2 h-8 px-2.5 rounded-md text-left text-[13px] whitespace-nowrap outline-none",
    i.disabled ? "opacity-50 pointer-events-none" : i.tone === "danger" ? "text-bad hover:bg-bad-soft focus:bg-bad-soft" : "text-ink hover:bg-panel-2 focus:bg-panel-2",
  );

  return (
    <div ref={wrap} className={cx("relative inline-flex", className)} onKeyDown={open ? onKeyDown : undefined}>
      {cloneElement(trigger, {
        "aria-haspopup": "menu",
        "aria-expanded": open,
        onClick: (e: ReactMouseEvent<HTMLElement>) => {
          trigger.props.onClick?.(e);
          setOpen((o) => !o);
        },
      } as Record<string, unknown>)}
      {open && (
        <div ref={list} role="menu"
          className={cx("absolute z-40 min-w-[190px] p-1 rounded-xl border border-line bg-panel shadow-xl fade-in",
            up ? "bottom-full mb-1" : "top-full mt-1", align === "end" ? "right-0" : "left-0")}>
          {visible.map((i, n) => {
            const content = <>{i.icon && <span className="shrink-0 text-muted [&>svg]:size-[15px]">{i.icon}</span>}{i.label}</>;
            return i.href && !i.disabled ? (
              <Link key={n} href={i.href} role="menuitem" tabIndex={-1} className={itemClass(i)}
                onClick={() => { close(false); i.onSelect?.(); }}>{content}</Link>
            ) : (
              <button key={n} type="button" role="menuitem" tabIndex={-1} aria-disabled={i.disabled || undefined} className={itemClass(i)}
                onClick={() => { if (i.disabled) return; close(true); i.onSelect?.(); }}>{content}</button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** "5m ago" that stays current, with the exact time on hover. Server and browser may disagree by a minute, so hydration warnings are suppressed. */
export function RelativeTime({ iso, className }: { iso: string | null | undefined; className?: string }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!iso) return;
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, [iso]);
  if (!iso) return <span className={className}>—</span>;
  return <time dateTime={iso} title={fmtDateTime(iso)} className={className} suppressHydrationWarning>{timeAgo(iso)}</time>;
}

/** Calls `fn` every `ms` while the tab is visible, and once when it becomes visible again. */
export function usePoll(fn: () => void | Promise<void>, ms: number, enabled = true) {
  const ref = useRef(fn);
  useEffect(() => { ref.current = fn; });
  useEffect(() => {
    if (!enabled) return;
    let busy = false;
    const run = async () => {
      if (busy) return; // a slow request never stacks up behind itself
      busy = true;
      try { await ref.current(); } catch { /* polling is best-effort; the next run tries again */ } finally { busy = false; }
    };
    const id = setInterval(() => { if (document.visibilityState !== "hidden") void run(); }, ms);
    const onVisible = () => { if (document.visibilityState === "visible") void run(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ms, enabled]);
}

/**
 * Keyboard shortcuts: keys like 'j', '1', '?', '/', 'escape', 'mod+enter' (mod = ⌘ or Ctrl).
 * Ignored while typing in a field (except 'escape' and 'mod+enter'), with undeclared modifier
 * keys held, or while a dialog is open.
 */
export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>, enabled = true) {
  const ref = useRef(map);
  useEffect(() => { ref.current = map; });
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.altKey) return;
      const mod = e.metaKey || e.ctrlKey;
      const name = `${mod ? "mod+" : ""}${e.key.toLowerCase()}`;
      const entry = Object.entries(ref.current).find(([k]) => k.toLowerCase() === name);
      if (!entry) return;
      const always = name === "escape" || name === "mod+enter";
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (!always && (typing || document.querySelector("dialog[open]"))) return;
      e.preventDefault();
      entry[1](e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

/** The '?' overlay listing a page's shortcuts. `showButton` adds a small keyboard button that opens it. */
export function ShortcutHelp({ shortcuts, showButton }: { shortcuts: [key: string, label: string][]; showButton?: boolean }) {
  const [open, setOpen] = useState(false);
  useHotkeys({ "?": () => setOpen(true) });
  return (
    <>
      {showButton && (
        <button type="button" onClick={() => setOpen(true)} className={buttonClass("ghost", "sm", "w-8 px-0")} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
          <Keyboard size={15} />
        </button>
      )}
      <Dialog open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts" description="They don't work while you're typing in a field.">
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-[13px]">
          {shortcuts.map(([k, label]) => (
            <Fragment key={k}>
              <dt><Kbd>{k}</Kbd></dt>
              <dd className="text-muted">{label}</dd>
            </Fragment>
          ))}
        </dl>
      </Dialog>
    </>
  );
}

/** Re-fetches server data on an interval while the tab is visible. */
export function AutoRefresh({ seconds = 60 }: { seconds?: number }) {
  const router = useRouter();
  usePoll(() => router.refresh(), seconds * 1000);
  return null;
}

/** Renders children only on the given routes ('/' matches exactly, others also match sub-pages). */
export function OnlyOnPaths({ paths, children }: { paths: string[]; children: ReactNode }) {
  const path = usePathname();
  const show = paths.some((p) => (p === "/" ? path === "/" : path === p || path.startsWith(`${p}/`)));
  return show ? children : null;
}
