"use client";

import { ExternalLink, Globe, RefreshCw, Search, Sparkles } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { researchLead } from "@/app/actions/leads";
import type { IndustryBrief } from "@/lib/industry";
import type { Analysis, Research } from "@/lib/research";
import { RelativeTime, Spinner } from "./client";
import { Badge, Button, cx } from "./ui";

export type ResearchRow = Pick<Research, "domain" | "status" | "url" | "title" | "analysis" | "error" | "fetched_at" | "analyzed_at">;

const PILLAR_TONE: Record<string, string> = {
  "Gen AI": "bg-accent-soft text-accent",
  "Agentic AI": "bg-good-soft text-good",
  "Technology": "bg-panel-2 text-ink",
  "Digital Transformation": "bg-warn-soft text-warn",
};

/** Pain points: the explicit list when the analysis has one, else the use-case problems and inferred needs. */
function painPoints(a: Analysis): string[] {
  if (a.pain_points?.length) return a.pain_points;
  return [...new Set([...a.use_cases.map((u) => u.problem), ...a.likely_needs].filter(Boolean))].slice(0, 5);
}

/**
 * What we know about the lead's company: the AI reads their website (found from the email
 * domain) and works out what they do, likely pain points and how we could help.
 */
export function CompanyResearch({ leadId, domain, research, industry, onDone }: {
  leadId: string;
  domain: string | null;
  research: ResearchRow | null;
  industry: IndustryBrief | null;
  onDone: () => void;
}) {
  const [running, start] = useTransition();
  // After a successful run, keep showing progress until the drawer has re-fetched the new research.
  const [waiting, setWaiting] = useState(false);
  const [seen, setSeen] = useState(research?.analyzed_at ?? null);
  if ((research?.analyzed_at ?? null) !== seen) {
    setSeen(research?.analyzed_at ?? null);
    setWaiting(false);
  }
  const pending = running || waiting;
  const run = (force: boolean) => start(async () => {
    const r = await researchLead(leadId, force);
    if (!r.ok) toast.error(r.error);
    else {
      toast.success(r.message ?? "Researched");
      setWaiting(true);
      setTimeout(() => setWaiting(false), 5000); // in case nothing changed (already up to date)
    }
    onDone();
  });

  const a = research?.status === "ok" ? research.analysis : null;
  const header = (
    <div className="flex items-center gap-2">
      <h3 className="text-[13px] font-semibold flex items-center gap-1.5"><Sparkles size={14} className="text-accent" />Company research</h3>
      {research?.analyzed_at && !pending && <span className="text-[11.5px] text-faint">· <RelativeTime iso={research.analyzed_at} /></span>}
      {a && (
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => run(true)} disabled={pending} title="Visit their website again and redo the research">
          {pending ? <Spinner /> : <RefreshCw size={13} />}Refresh
        </Button>
      )}
    </div>
  );

  if (pending && !a) {
    return (
      <section className="grid gap-2.5">
        {header}
        <div className="rounded-lg border border-line px-3 py-3 text-[12.5px] text-muted flex items-center gap-2">
          <Spinner />Visiting {domain} and researching the company… this takes about 20 seconds.
        </div>
      </section>
    );
  }

  if (!domain) {
    return (
      <section className="grid gap-2.5">
        {header}
        <p className="text-[12.5px] text-muted">This is a personal email address (Gmail, Yahoo…), so there&apos;s no company website to read. Add their company website in Details below, save, then research.</p>
      </section>
    );
  }

  if (!research || !a) {
    return (
      <section className="grid gap-2.5">
        {header}
        {research?.status === "failed" && <p className="text-[12.5px] text-bad">Couldn&apos;t read {domain}{research.error ? `: ${research.error}` : ""}.</p>}
        <div className="rounded-lg border border-dashed border-line px-3 py-3 grid gap-2">
          <p className="text-[12.5px] text-muted">
            We&apos;ll visit <span className="text-ink font-medium">{domain}</span>, read the site, and work out what they do, their likely pain points,
            and how Gen AI, Agentic AI, technology or digital transformation could help them.
          </p>
          <div><Button size="sm" variant="primary" onClick={() => run(research?.status === "failed")} disabled={pending}><Search size={13} />{research?.status === "failed" ? "Try again" : "Research this company"}</Button></div>
        </div>
      </section>
    );
  }

  const pains = painPoints(a);
  return (
    <section className="grid gap-3">
      {header}
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
          <a href={research.url ?? `https://${research.domain}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
            <Globe size={12} />{research.domain}<ExternalLink size={11} />
          </a>
          {a.industry && <Badge>{a.industry}</Badge>}
          <span title={a.fit_reason}><Badge tone={a.fit_score >= 7 ? "good" : a.fit_score >= 4 ? "warn" : "bad"}>Fit {a.fit_score}/10</Badge></span>
          {a.confidence === "low" && <span className="text-faint" title="Their website had little text, so more of this is industry knowledge">· thin website</span>}
        </div>
        {a.what_they_do && <p className="text-[13px]">{a.what_they_do}</p>}
        {(a.customers || a.business_model) && (
          <p className="text-[12px] text-muted">{[a.customers && `Customers: ${a.customers}`, a.business_model && `Model: ${a.business_model}`].filter(Boolean).join(" · ")}</p>
        )}
      </div>

      {a.facts.length > 0 && (
        <Block title="From their website">
          <ul className="list-disc pl-4 grid gap-0.5 text-[12.5px]">{a.facts.map((f) => <li key={f}>{f}</li>)}</ul>
        </Block>
      )}

      {pains.length > 0 && (
        <Block title="Likely pain points">
          <ul className="list-disc pl-4 grid gap-0.5 text-[12.5px]">{pains.map((p) => <li key={p}>{p}</li>)}</ul>
        </Block>
      )}

      {a.use_cases.length > 0 && (
        <Block title="How we could help">
          <div className="grid gap-2">
            {a.use_cases.map((u, i) => (
              <div key={u.title + i} className="rounded-lg border border-line px-3 py-2.5 grid gap-1 text-[12.5px]">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={cx("rounded px-1.5 py-0.5 text-[11px] font-medium", PILLAR_TONE[u.pillar] ?? "bg-panel-2")}>{u.pillar}</span>
                  <span className="font-medium text-[13px]">{u.title}</span>
                  <span className="ml-auto text-[11px] text-faint">{u.grounded_in === "fact" ? "from their website" : "industry knowledge"}</span>
                </div>
                <p><span className="text-faint">Problem:</span> {u.problem}</p>
                <p><span className="text-faint">Solution:</span> {u.solution}</p>
                {u.outcome && <p><span className="text-faint">Outcome:</span> {u.outcome}</p>}
                {u.first_step && <p className="text-muted"><span className="text-faint">First step:</span> {u.first_step}</p>}
              </div>
            ))}
          </div>
        </Block>
      )}

      {(a.best_service || a.angle) && (
        <div className="grid gap-0.5 text-[12.5px]">
          {a.best_service && <p><span className="text-faint">Best service:</span> {a.best_service}</p>}
          {a.angle && <p><span className="text-faint">Email angle:</span> {a.angle}</p>}
        </div>
      )}

      {(a.industry_context || industry) && (
        <details className="text-[12.5px] rounded-lg bg-panel-2/60 px-3 py-2">
          <summary className="cursor-pointer select-none font-medium">About their industry{industry ? ` · ${industry.industry}` : ""}</summary>
          <div className="mt-2 grid gap-1.5">
            {a.industry_context && <p>{a.industry_context}</p>}
            {industry?.challenges.length ? (
              <div><div className="text-faint">Common challenges</div><ul className="list-disc pl-4">{industry.challenges.map((c) => <li key={c}>{c}</li>)}</ul></div>
            ) : null}
            {industry?.kpis.length ? <p><span className="text-faint">Metrics they track:</span> {industry.kpis.join(", ")}</p> : null}
            {industry?.buyers.length ? <p><span className="text-faint">Who owns these problems:</span> {industry.buyers.join(", ")}</p> : null}
          </div>
        </details>
      )}
    </section>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <div className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-faint">{title}</div>
      {children}
    </div>
  );
}
