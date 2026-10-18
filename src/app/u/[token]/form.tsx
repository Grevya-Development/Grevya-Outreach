"use client";

import { use, useActionState } from "react";
import { unsubscribe } from "./actions";

export function UnsubscribeForm({ token }: { token: Promise<string> }) {
  const t = use(token);
  const [state, action, pending] = useActionState(unsubscribe, undefined);

  if (state?.done) {
    return (
      <>
        <h1 className="text-[17px] font-semibold">You&apos;re unsubscribed</h1>
        <p className="text-[13.5px] text-muted mt-2">You won&apos;t get any more emails from us. Sorry for the interruption.</p>
      </>
    );
  }
  return (
    <form action={action}>
      <input type="hidden" name="token" value={t} />
      <h1 className="text-[17px] font-semibold">Unsubscribe?</h1>
      <p className="text-[13.5px] text-muted mt-2">You&apos;ll stop receiving emails from us.</p>
      {state?.error && <p className="text-[13px] text-bad mt-3">{state.error}</p>}
      <button disabled={pending} className="mt-5 w-full h-10 rounded-lg bg-ink text-bg font-medium disabled:opacity-60">
        {pending ? "Unsubscribing…" : "Yes, unsubscribe me"}
      </button>
    </form>
  );
}
