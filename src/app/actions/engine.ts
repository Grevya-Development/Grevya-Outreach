"use server";

import { refresh } from "next/cache";
import type { ActionResult } from "@/components/client";
import { SENDING_PAUSED_KEY } from "@/lib/app-state";
import { db, must } from "@/lib/supabase";
import { requireAuth } from "./auth";

/** The sidebar's "Pause all sending" switch. The engine checks it before every send. */
export async function setSendingPaused(paused: boolean): Promise<ActionResult> {
  await requireAuth();
  const at = new Date().toISOString();
  must(await db().from("app_state").upsert({ key: SENDING_PAUSED_KEY, value: { paused, at }, updated_at: at }));
  refresh();
  return { ok: true, message: paused ? "All sending paused" : "Sending resumed" };
}
