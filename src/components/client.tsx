"use client";

import clsx from "clsx";
import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useTransition, type ReactNode } from "react";
import { toast, Toaster } from "sonner";
import { buttonClass } from "./ui";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

/** Runs a server action with pending state + toast. */
export function useAction() {
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ActionResult | void>, onOk?: () => void) =>
    start(async () => {
      try {
        const res = await fn();
        if (res && !res.ok) toast.error(res.error);
        else {
          if (res?.message) toast.success(res.message);
          onOk?.();
        }
      } catch (err) {
        toast.error((err as Error).message || "Something went wrong");
      }
    });
  return [pending, run] as const;
}

export function ActionButton({
  action, children, variant = "secondary", size = "md", confirm, className, disabled, title,
}: {
  action: () => Promise<ActionResult | void>;
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  confirm?: string;
  className?: string;
  disabled?: boolean;
  title?: string;
}) {
  const [pending, run] = useAction();
  return (
    <button
      type="button"
      title={title}
      disabled={pending || disabled}
      className={buttonClass(variant, size, className)}
      onClick={() => {
        if (confirm && !window.confirm(confirm)) return;
        run(action);
      }}
    >
      {pending ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={clsx("size-3.5 rounded-full border-2 border-current border-r-transparent animate-spin", className)} />;
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
      className={clsx(
        "relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors duration-150 disabled:opacity-50",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        checked ? "bg-accent" : "bg-line",
      )}
    >
      <span className={clsx("absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform duration-150", checked && "translate-x-4")} />
    </button>
  );
}

export function Dialog({
  open, onClose, title, description, children, footer, wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // showModal focuses the close button; put the cursor in the first field instead.
      d.querySelector<HTMLElement>("input:not([type=hidden]):not([disabled]), textarea, select")?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className={clsx(
        "m-auto p-0 rounded-2xl border border-line bg-panel text-ink shadow-2xl w-[calc(100vw-32px)] max-h-[calc(100vh-48px)]",
        wide ? "max-w-3xl" : "max-w-lg",
      )}
    >
      {open && (
        <div className="flex flex-col max-h-[calc(100vh-48px)]">
          <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3 border-b border-line">
            <div>
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
      {open && <Toaster position="top-center" richColors closeButton />}
    </dialog>
  );
}

/** Re-fetches server data on an interval while the tab is visible. */
export function AutoRefresh({ seconds = 15 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}
