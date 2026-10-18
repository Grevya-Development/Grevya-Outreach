"use client";

import { use, useActionState } from "react";
import { login } from "@/app/actions/auth";
import { Spinner } from "@/components/client";
import { Button, Card, Field, Input } from "@/components/ui";

export function LoginForm({ next }: { next: Promise<string> }) {
  const nextPath = use(next);
  const [state, action, pending] = useActionState(login, undefined);
  return (
    <Card className="p-5">
      <form action={action} className="grid gap-4">
        <input type="hidden" name="next" value={nextPath} />
        <Field label="Password">
          <Input name="password" type="password" autoFocus required autoComplete="current-password" />
        </Field>
        {state?.error && <p className="text-[13px] text-bad">{state.error}</p>}
        <Button variant="primary" disabled={pending}>{pending && <Spinner />}Sign in</Button>
      </form>
    </Card>
  );
}
