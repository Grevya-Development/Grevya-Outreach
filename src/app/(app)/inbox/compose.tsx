"use client";

import { Mail, PenLine, Send } from "lucide-react";
import { useState } from "react";
import { sendOneOff } from "@/app/actions/inbox";
import { Dialog, Spinner, useAction } from "@/components/client";
import { Button, ButtonLink, Field, Input, Select, Textarea } from "@/components/ui";
import type { Mailbox } from "@/lib/types";

type Account = Pick<Mailbox, "id" | "email" | "status">;

/** Drops ?compose and ?to from the address bar once the composer has been used, so a reload doesn't reopen it. */
function clearComposeParams() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("compose") && !url.searchParams.has("to")) return;
  url.searchParams.delete("compose");
  url.searchParams.delete("to");
  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
}

/** The Inbox's primary button. Always shown; with no usable email account it explains how to connect one. */
export function NewEmailButton({ mailboxes, defaultOpen = false, defaultTo = "" }: { mailboxes: Account[]; defaultOpen?: boolean; defaultTo?: string }) {
  const usable = mailboxes.filter((m) => m.status !== "error");
  const [open, setOpen] = useState(defaultOpen);
  const [f, setF] = useState({ mailboxId: usable[0]?.id ?? "", to: defaultTo, subject: "", body: "" });
  const [pending, run] = useAction();
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));
  const close = () => { setOpen(false); clearComposeParams(); };

  const button = <Button variant="primary" onClick={() => setOpen(true)}><PenLine size={15} />New email</Button>;

  if (!usable.length) {
    return (
      <>
        {button}
        <Dialog open={open} onClose={close} title="Connect an email account first"
          footer={<><Button onClick={close}>Cancel</Button><ButtonLink variant="primary" href="/mailboxes?connect=1"><Mail size={14} />Connect an email account</ButtonLink></>}>
          <p className="text-[13.5px] text-muted leading-relaxed">
            {mailboxes.length
              ? "Your email accounts need attention before they can send. Fix the connection on the Email accounts page, then come back to write your email."
              : "Emails go out from your own email account, so connect one first. It takes about a minute."}
          </p>
        </Dialog>
      </>
    );
  }

  return (
    <>
      {button}
      <Dialog open={open} wide onClose={close} title="New email" description="A one-off email from one of your email accounts, not part of a campaign."
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" disabled={pending || !f.to.trim() || !f.subject.trim() || !f.body.trim()}
              onClick={() => run(() => sendOneOff(f), () => { close(); setF((p) => ({ ...p, to: "", subject: "", body: "" })); })}>
              {pending ? <Spinner /> : <Send size={14} />}Send
            </Button>
          </>
        }>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="From">
            <Select value={f.mailboxId} onChange={(e) => set("mailboxId", e.target.value)}>
              {usable.map((m) => <option key={m.id} value={m.id}>{m.email}</option>)}
            </Select>
          </Field>
          <Field label="To">
            <Input type="email" value={f.to} placeholder="priya@acme.com" onChange={(e) => set("to", e.target.value)}
              autoFocus={!defaultTo} data-autofocus={defaultTo ? undefined : ""} />
          </Field>
          <Field label="Subject" className="sm:col-span-2">
            <Input value={f.subject} onChange={(e) => set("subject", e.target.value)} autoFocus={!!defaultTo} data-autofocus={defaultTo ? "" : undefined} />
          </Field>
          <Field label="Message" className="sm:col-span-2"
            hint="Plain text. Your signature is added automatically. They're saved to Leads so their reply shows up here.">
            <Textarea rows={9} value={f.body} onChange={(e) => set("body", e.target.value)} />
          </Field>
        </div>
      </Dialog>
    </>
  );
}
