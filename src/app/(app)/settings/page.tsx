import { connection } from "next/server";
import { Suspense } from "react";
import { Card, CardHeader, PageHeader, Skeleton } from "@/components/ui";
import { env } from "@/lib/env";
import { modelPool, type ModelLimits } from "@/lib/groq";
import { getProfile } from "@/lib/profile";
import { isPublicUrl } from "@/lib/schedule";
import { db, must } from "@/lib/supabase";
import { GroqTest, ProfileForm, SuppressionList } from "./settings-client";

export const metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid lg:grid-cols-2 gap-4 items-start">
        <Card className="lg:col-span-2">
          <CardHeader title="Company profile" description="What the AI knows about Grevya. Every researched email is written from this — be specific and only list results you can stand behind." />
          <Suspense fallback={<div className="px-4 pb-4"><Skeleton className="h-64" /></div>}>
            <Profile />
          </Suspense>
        </Card>

        <Card>
          <CardHeader title="Sending engine" description="Something has to run the engine continuously. Pick one." />
          <div className="px-4 pb-4 grid gap-4 text-[13px]">
            <div>
              <div className="font-medium">Option A: worker process (recommended)</div>
              <p className="text-muted mt-0.5">Sends on schedule, checks inboxes, and researches + writes AI emails ahead of time. Run it on an always-on machine (a small VPS, Railway, Render, or your laptop while it&apos;s awake).</p>
              <pre className="mt-2 rounded-lg bg-panel-2 px-3 py-2 font-mono text-[12.5px] overflow-x-auto">npm run worker</pre>
            </div>
            <div>
              <div className="font-medium">Option B: external cron</div>
              <p className="text-muted mt-0.5">Deploy this app, then have a cron service (e.g. cron-job.org) call this every minute:</p>
              <Suspense fallback={<Skeleton className="h-16 mt-2" />}>
                <CronSnippet />
              </Suspense>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="AI (Groq)" description="Researches companies, writes emails, and reads replies." />
          <div className="px-4 pb-4 grid gap-3 text-[13px]">
            <Suspense fallback={<Skeleton className="h-24" />}>
              <GroqInfo />
            </Suspense>
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Block list" description="Never emailed again. Unsubscribes, bounces, “remove me” and “not interested” replies are added automatically." />
          <Suspense fallback={<div className="px-4 pb-4"><Skeleton className="h-40" /></div>}>
            <Suppressions />
          </Suspense>
        </Card>
      </div>
    </>
  );
}

async function Profile() {
  await connection();
  return <ProfileForm initial={await getProfile()} />;
}

async function CronSnippet() {
  await connection(); // read env at request time, not build time
  const url = `${env.appUrl}/api/engine/tick`;
  return (
    <>
      <pre className="mt-2 rounded-lg bg-panel-2 px-3 py-2 font-mono text-[12px] overflow-x-auto">{`GET ${url}
Authorization: Bearer <CRON_SECRET>`}{!env.cronSecret && "\n# CRON_SECRET is not set in your env yet"}</pre>
      {!isPublicUrl(env.appUrl) && (
        <p className="mt-2 text-[12.5px] text-warn">APP_URL is {env.appUrl}. Emails still work, but the one-click Unsubscribe button (and open/click tracking) need a public URL. Set APP_URL once deployed.</p>
      )}
    </>
  );
}

async function GroqInfo() {
  await connection();
  const { data } = await db().from("app_state").select("value").eq("key", "engine").maybeSingle();
  const groq = ((data?.value as { groq?: Record<string, ModelLimits> } | undefined)?.groq) ?? {};
  const resting = new Set(Object.entries(groq).filter(([, l]) => isFuture(l.blockedUntil)).map(([m]) => m));
  const row = (label: string, model: string) => {
    const l = groq[model];
    return (
      <div className="flex justify-between gap-3">
        <span className="text-muted">{label}</span>
        <span className="text-right">
          <code className="font-mono text-[12.5px]">{model}</code>
          {l?.remainingRequests != null && (
            <span className="block text-[12px] text-faint">
              {l.remainingRequests} of {l.limitRequests} requests left today{l.tokensToday ? ` · ~${Math.round(l.tokensToday / 1000)}K tokens used` : ""}
              {resting.has(model) ? <span className="text-warn"> · resting until {new Date(l.blockedUntil).toLocaleTimeString()}</span> : null}
            </span>
          )}
        </span>
      </div>
    );
  };
  return (
    <>
      <div className="flex justify-between"><span className="text-muted">API key</span><span>{env.groqKey ? "configured" : <span className="text-bad">missing — set GROQ_API_KEY</span>}</span></div>
      {modelPool("write").map((m, i) => row(i === 0 ? "Models (writing order)" : "", m))}
      <div className="rounded-lg bg-warn-soft px-3 py-2.5 text-[12.5px] grid gap-1">
        <b className="text-ink">How many AI-researched emails per day?</b>
        <span className="text-ink/80">
          Groq&apos;s free plan gives each model about 1,000 requests and 200,000 tokens a day. One researched lead uses ~5,500 tokens,
          so one model covers ~35–70 leads a day. The engine spreads work over 3 models (~150–250 leads/day free; research is cached per company).
        </span>
        <span className="text-ink/80">
          <b>For 800 a day</b>, add a payment method in Groq (console.groq.com → Settings → Billing, “Developer” pay-as-you-go). At ~5,500 tokens per lead
          that&apos;s roughly $1 a day. Nothing else changes — the engine picks up the higher limits automatically.
        </span>
      </div>
      <GroqTest />
    </>
  );
}

function isFuture(ms: number): boolean {
  return ms > Date.now();
}

async function Suppressions() {
  await connection(); // always fresh data, never prerendered
  const rows = must(await db().from("suppressions").select("*").order("created_at", { ascending: false }).limit(500)) as { email: string; reason: string; created_at: string }[];
  return <SuppressionList rows={rows} />;
}
