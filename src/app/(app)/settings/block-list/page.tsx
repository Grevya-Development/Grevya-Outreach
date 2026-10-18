import { connection } from "next/server";
import { Suspense } from "react";
import { TableSkeleton } from "@/components/ui";
import { db, must } from "@/lib/supabase";
import { SuppressionList } from "../settings-client";

export const metadata = { title: "Block list" };

export default function BlockListPage() {
  return (
    <Suspense fallback={<TableSkeleton rows={6} />}>
      <Suppressions />
    </Suspense>
  );
}

async function Suppressions() {
  await connection(); // always fresh data, never prerendered
  const rows = must(await db().from("suppressions").select("email, reason, created_at").order("created_at", { ascending: false }).limit(500)) as { email: string; reason: string; created_at: string }[];
  return <SuppressionList rows={rows} />;
}
