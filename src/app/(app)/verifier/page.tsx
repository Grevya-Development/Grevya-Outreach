import { connection } from "next/server";
import { Suspense } from "react";
import { PageHeader, Skeleton } from "@/components/ui";
import { canProbeSmtp } from "@/lib/email-verify";
import { db, must } from "@/lib/supabase";
import { VerifierView } from "./verifier-client";

export const metadata = { title: "E-mail Verifier" };

export default function VerifierPage() {
  return (
    <>
      <PageHeader title="E-mail Verifier" description="Check whether addresses are real before you send — and find the right address for a person from their name and company." />
      <Suspense fallback={<div className="grid gap-4"><Skeleton className="h-16" /><Skeleton className="h-96" /></div>}>
        <VerifierData />
      </Suspense>
    </>
  );
}

async function VerifierData() {
  await connection();
  const [smtp, campaigns] = await Promise.all([
    canProbeSmtp(),
    db().from("campaigns").select("id, name").neq("status", "completed").order("created_at", { ascending: false }).then(must),
  ]);
  return <VerifierView capabilities={{ smtp }} campaigns={campaigns as { id: string; name: string }[]} />;
}
