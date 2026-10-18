"use client";

// The sticky footer of the draft builder (Back · Save & continue) and of the live edit tabs
// (Save changes), plus the unsaved-changes guard they share.
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useEffect, type ReactNode } from "react";
import { Spinner } from "@/components/client";
import { Button, buttonClass } from "@/components/ui";

/** Asks before leaving the page (reload, close, typed URL) while there are unsaved changes. */
export function useUnsavedGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);
}

const bar = "sticky bottom-0 z-20 -mx-4 sm:-mx-6 lg:-mx-8 mt-2 px-4 sm:px-6 lg:px-8 py-3 border-t border-line bg-bg/90 backdrop-blur flex flex-wrap items-center gap-2";

/** Draft builder: Back on the left, the step's primary on the right. */
export function BuilderFooter({ backHref, onSaveAndContinue, saving, nextLabel = "Save & continue", disabled, note }: {
  backHref?: string;
  onSaveAndContinue: () => void;
  saving: boolean;
  nextLabel?: ReactNode;
  disabled?: boolean;
  /** Shown next to the primary, e.g. why it's disabled. */
  note?: ReactNode;
}) {
  return (
    <div className={bar}>
      {backHref ? <Link href={backHref} scroll={false} className={buttonClass("ghost")}><ArrowLeft size={15} />Back</Link> : <span />}
      <div className="ml-auto flex items-center gap-3">
        {note && <span className="text-[12.5px] text-muted">{note}</span>}
        <Button variant="primary" onClick={onSaveAndContinue} disabled={saving || disabled}>{saving && <Spinner />}{nextLabel}</Button>
      </div>
    </div>
  );
}

/** Live campaign edit tabs: Save changes, enabled only when something changed. */
export function SaveChangesFooter({ dirty, saving, onSave, onDiscard }: { dirty: boolean; saving: boolean; onSave: () => void; onDiscard?: () => void }) {
  return (
    <div className={bar}>
      <span className="text-[12.5px] text-muted">{dirty ? <span className="text-warn">Unsaved changes</span> : "All changes saved"}</span>
      <div className="ml-auto flex items-center gap-2">
        {dirty && onDiscard && <Button variant="ghost" onClick={onDiscard} disabled={saving}>Discard</Button>}
        <Button variant="primary" onClick={onSave} disabled={!dirty || saving}>{saving && <Spinner />}Save changes</Button>
      </div>
    </div>
  );
}

/** Builder footer for a draft, Save changes for a live campaign. */
export function EditFooter({ builder, backHref, nextLabel, dirty, saving, onSave, onDiscard, disabled }: {
  builder: boolean;
  backHref?: string;
  nextLabel?: ReactNode;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard?: () => void;
  disabled?: boolean;
}) {
  return builder
    ? <BuilderFooter backHref={backHref} nextLabel={nextLabel} saving={saving} onSaveAndContinue={onSave} disabled={disabled} />
    : <SaveChangesFooter dirty={dirty} saving={saving} onSave={onSave} onDiscard={onDiscard} />;
}
