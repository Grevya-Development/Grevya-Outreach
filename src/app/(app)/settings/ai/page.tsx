import { connection } from "next/server";
import { Suspense } from "react";
import { Card, CardHeader, Skeleton } from "@/components/ui";
import { env } from "@/lib/env";
import { fmtNum, fmtTime } from "@/lib/format";
import { modelPool, type ModelLimits } from "@/lib/groq";
import { db } from "@/lib/supabase";
import { AiTest } from "../settings-client";

export const metadata = { title: "AI usage" };

export default function AiUsagePage() {
  return (
    <Card>
      <CardHeader title="AI usage" description="The AI researches each company, writes the emails and reads replies." />
      <div className="px-4 pb-4 grid gap-4 text-[13px]">
        <Suspense fallback={<Skeleton className="h-40" />}>
          <Usage />
        </Suspense>
      </div>
    </Card>
  );
}

async function Usage() {
  await connection();
  // The sending loop saves the latest per-model limits with its heartbeat.
  const { data } = await db().from("app_state").select("value").eq("key", "engine").maybeSingle();
  const limits = ((data?.value as { groq?: Record<string, ModelLimits> } | undefined)?.groq) ?? {};
  const models = modelPool("write");
  return (
    <>
      <div className="flex justify-between gap-3">
        <span className="text-muted">AI key</span>
        <span>{env.groqKey ? "Set" : <span className="text-bad">Missing: set GROQ_API_KEY in .env.local</span>}</span>
      </div>
      <div className="rounded-lg border border-line divide-y divide-line">
        {models.map((model, i) => {
          const l = limits[model];
          const used = l?.limitRequests != null && l.remainingRequests != null ? l.limitRequests - l.remainingRequests : null;
          const resting = !!l && isFuture(l.blockedUntil);
          return (
            <div key={model} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-3 py-2.5">
              <div className="min-w-0">
                <div className="font-medium">{i === 0 ? "Main model" : `Backup model ${i}`}</div>
                <code className="font-mono text-[11.5px] text-faint break-all">{model}</code>
              </div>
              <div className="text-right text-muted">
                {used != null ? (
                  <span className="block">{fmtNum(used)} of {fmtNum(l!.limitRequests)} requests used today</span>
                ) : (
                  <span className="block text-faint">Not used yet today</span>
                )}
                {!!l?.tokensToday && <span className="block text-[12px] text-faint">About {fmtNum(Math.round(l.tokensToday / 1000))}K tokens used today</span>}
                {resting && <span className="block text-[12px] text-warn">At its limit, used again from {fmtTime(l.blockedUntil)}</span>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="rounded-lg bg-warn-soft px-3 py-2.5 text-[12.5px] grid gap-1">
        <b className="text-ink">How many AI-written emails per day?</b>
        <span className="text-ink/80">
          The free plan gives each model about 1,000 requests and 200,000 tokens a day. One researched lead uses about 5,500 tokens,
          so one model covers 35–70 leads a day. Work is spread over {models.length} models (research is reused per company).
        </span>
        <span className="text-ink/80">
          <b>800 a day needs pay-as-you-go.</b> Add a payment method at console.groq.com → Settings → Billing (&quot;Developer&quot; plan).
          That&apos;s roughly $1 a day at 800 leads, and the higher limits are picked up automatically.
        </span>
      </div>
      <AiTest />
    </>
  );
}

function isFuture(ms: number): boolean {
  return ms > Date.now();
}
