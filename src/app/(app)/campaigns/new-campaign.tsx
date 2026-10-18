"use client";

import { FileText, Plus, Sparkles } from "lucide-react";
import { useState } from "react";
import { useFormStatus } from "react-dom";
import { createCampaign } from "@/app/actions/campaigns";
import { Dialog, Spinner } from "@/components/client";
import { Button, Field, Input, cx } from "@/components/ui";

/** Drops `?new=` / `?list=` from the URL once the dialog they opened is closed (so a refresh doesn't reopen it). */
function clearNewParams() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("new") && !url.searchParams.has("list")) return;
    url.searchParams.delete("new");
    url.searchParams.delete("list");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  } catch { /* cosmetic only */ }
}

const MODES = [
  { value: "ai", title: "AI writes each email", text: "Researches each company's website, scores the fit, writes every email. Recommended.", icon: Sparkles },
  { value: "template", title: "I write a template", text: "Your text with personal fields and variations.", icon: FileText },
] as const;

export function NewCampaignButton({ defaultOpen, list }: { defaultOpen?: boolean; list?: string }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const close = () => { setOpen(false); clearNewParams(); };
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}><Plus size={15} />New campaign</Button>
      {open && (
        <Dialog open onClose={close} title="New campaign"
          description={list ? <>Leads from list <b className="text-ink">{list}</b> will be added.</> : "Starts with a ready-made sequence you can edit."}>
          <form action={createCampaign} className="grid gap-4">
            <Field label="Name"><Input name="name" autoFocus data-autofocus="" required maxLength={120} placeholder="e.g. Manufacturing COOs, Tamil Nadu" /></Field>
            <fieldset className="grid gap-2">
              <legend className="text-[12.5px] font-medium mb-1.5">How are the emails written?</legend>
              <div className="grid sm:grid-cols-2 gap-2.5">
                {MODES.map((m, i) => (
                  <label key={m.value}
                    className={cx("relative flex flex-col gap-1 rounded-xl border p-3.5 cursor-pointer transition-colors border-line hover:bg-panel-2",
                      "has-[:checked]:border-accent has-[:checked]:bg-accent-soft/50 has-[:checked]:ring-2 has-[:checked]:ring-accent/20",
                      "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent")}>
                    <input type="radio" name="mode" value={m.value} defaultChecked={i === 0} className="sr-only" />
                    <span className="flex items-center gap-1.5 font-medium text-[13.5px]"><m.icon size={15} className="text-accent" />{m.title}</span>
                    <span className="text-[12.5px] text-muted">{m.text}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            {list && <input type="hidden" name="list" value={list} />}
            <div className="flex justify-end gap-2">
              <Button type="button" onClick={close}>Cancel</Button>
              <Submit />
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return <Button variant="primary" type="submit" disabled={pending}>{pending && <Spinner />}Create campaign</Button>;
}
