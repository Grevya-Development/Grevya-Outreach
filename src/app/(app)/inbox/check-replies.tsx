import { connection } from "next/server";
import { db } from "@/lib/supabase";
import { CheckRepliesClient } from "./check-replies-client";

/** "Check for replies" with when the inboxes were last checked. */
export async function CheckRepliesButton() {
  await connection();
  const { data } = await db().from("mailboxes").select("imap_synced_at").not("imap_host", "is", null).neq("status", "error");
  const times = (data ?? []).map((m) => m.imap_synced_at as string | null);
  const oldest = times.length && times.every(Boolean) ? (times as string[]).sort()[0] : null;
  return <CheckRepliesClient lastChecked={oldest} hasAccounts={times.length > 0} />;
}
