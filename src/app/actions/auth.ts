"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { checkPassword, createSession, isValidSession, SESSION_COOKIE } from "@/lib/auth";
import { db } from "@/lib/supabase";

export async function login(_prev: { error?: string } | undefined, form: FormData): Promise<{ error?: string }> {
  if (!process.env.APP_PASSWORD || !process.env.APP_SECRET) {
    return { error: "Set APP_PASSWORD and APP_SECRET in .env.local first." };
  }
  // Global throttle (the app is public for tracking links): 10 wrong passwords → 15 min lock.
  const supa = db();
  const { data } = await supa.from("app_state").select("value").eq("key", "login_guard").maybeSingle();
  const guard = (data?.value as { fails?: number; since?: number; lockedUntil?: number } | undefined) ?? {};
  if ((guard.lockedUntil ?? 0) > Date.now()) {
    return { error: `Too many wrong passwords. Try again in ${Math.ceil(((guard.lockedUntil ?? 0) - Date.now()) / 60_000)} min.` };
  }
  if (!checkPassword(String(form.get("password") ?? ""))) {
    const windowStart = guard.since && Date.now() - guard.since < 15 * 60_000 ? guard.since : Date.now();
    const fails = (windowStart === guard.since ? guard.fails ?? 0 : 0) + 1;
    await supa.from("app_state").upsert({
      key: "login_guard",
      value: { fails, since: windowStart, lockedUntil: fails >= 10 ? Date.now() + 15 * 60_000 : 0 },
      updated_at: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 600)); // slow down guessing
    return { error: fails >= 10 ? "Too many wrong passwords. Locked for 15 minutes." : "Wrong password" };
  }
  if (guard.fails) await supa.from("app_state").upsert({ key: "login_guard", value: {}, updated_at: new Date().toISOString() });
  const s = createSession();
  (await cookies()).set(SESSION_COOKIE, s.value, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: s.maxAge, path: "/",
  });
  // Same-origin paths only (blocks "//evil.com" and "/\\evil.com").
  const next = String(form.get("next") ?? "/");
  redirect(/^\/(?![\/\\])[^\s]*$/.test(next) ? next : "/");
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}

/** Server actions are public POST endpoints — every mutating action calls this first. */
export async function requireAuth() {
  if (!isValidSession((await cookies()).get(SESSION_COOKIE)?.value)) throw new Error("Not signed in");
}
