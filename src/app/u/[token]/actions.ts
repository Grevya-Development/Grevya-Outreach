"use server";

import { unsubscribeByToken } from "@/lib/unsubscribe";

// Public on purpose: the signed token is the authorisation.
export async function unsubscribe(_prev: unknown, form: FormData): Promise<{ done?: boolean; error?: string }> {
  const email = await unsubscribeByToken(String(form.get("token") ?? ""));
  return email ? { done: true } : { error: "This link is invalid or expired. Reply “unsubscribe” to the email instead." };
}
