"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { useFormStatus } from "react-dom";
import { createCampaign } from "@/app/actions/campaigns";
import { Dialog, Spinner } from "@/components/client";
import { Button, Field, Input, Select } from "@/components/ui";

export function NewCampaignButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}><Plus size={15} />New campaign</Button>
      {open && (
        <Dialog open onClose={() => setOpen(false)} title="New campaign" description="Starts with a ready-made sequence you can edit.">
          <form action={createCampaign} className="grid gap-4">
            <Field label="Name"><Input name="name" autoFocus required placeholder="e.g. Manufacturing COOs – Tamil Nadu" /></Field>
            <Field label="Writing mode">
              <Select name="mode" defaultValue="ai">
                <option value="ai">AI-researched — reads each prospect&apos;s website and writes every email</option>
                <option value="template">Template — your text with {"{{variables}}"}</option>
              </Select>
            </Field>
            <div className="flex justify-end"><Submit /></div>
          </form>
        </Dialog>
      )}
    </>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return <Button variant="primary" disabled={pending}>{pending && <Spinner />}Create</Button>;
}
