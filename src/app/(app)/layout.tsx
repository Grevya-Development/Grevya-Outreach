import { Suspense, type ReactNode } from "react";
import { connection } from "next/server";
import Link from "next/link";
import { OnlyOnPaths } from "@/components/client";
import { Logo, LogoMark } from "@/components/logo";
import { Nav, NavList } from "@/components/nav";
import { SendingPill } from "@/components/sending-pill";
import { getEngineState } from "@/lib/app-state";
import { migrationStatus } from "@/lib/schema";
import { db, isMissingRpc } from "@/lib/supabase";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="min-h-screen md:grid md:grid-cols-[220px_1fr]">
      <aside className="sticky top-0 z-20 md:h-screen border-b md:border-b-0 md:border-r border-line bg-bg/90 backdrop-blur px-3 py-2 md:py-4 flex items-center md:flex-col md:items-stretch gap-2 md:gap-5">
        <Link href="/" className="flex flex-col items-start gap-0.5 md:px-1.5 shrink-0" aria-label="Grevya Outreach — Home">
          <LogoMark className="md:hidden" />
          <Logo className="hidden md:inline-block h-8" priority />
          <span className="hidden md:block text-[11px] font-medium uppercase tracking-[0.14em] text-faint pl-0.5">Outreach</span>
        </Link>
        <Suspense fallback={<SidebarShell nav={<NavList />} />}>
          <NavData />
        </Suspense>
      </aside>
      <main className="min-w-0 px-4 sm:px-6 lg:px-8 py-6 max-w-[1240px] w-full">
        <Suspense fallback={null}><DbUpdateBanner /></Suspense>
        {children}
      </main>
    </div>
  );
}

/** Nav plus the sending pill: a dot at the end of the top bar on phones, the sidebar footer on desktop. */
function SidebarShell({ nav, pill, compactPill }: { nav: ReactNode; pill?: ReactNode; compactPill?: ReactNode }) {
  return (
    <>
      <div className="flex-1 min-w-0 md:flex-none">{nav}</div>
      <div className="md:hidden shrink-0 size-9 grid place-items-center">{compactPill}</div>
      <div className="hidden md:block md:mt-auto min-h-10">{pill}</div>
    </>
  );
}

/** Replies waiting for an answer plus reminders that are due (the Inbox "To do" view). */
async function todoCount(): Promise<number> {
  const supa = db();
  const { data, error } = await supa.rpc("inbox_counts");
  if (!error) return Number((data as { todo?: number } | null)?.todo) || 0;
  if (!isMissingRpc(error)) throw new Error(error.message);
  // Before migration 0004: count it directly.
  const { count } = await supa.from("replies").select("id", { count: "exact", head: true })
    .eq("handled", false)
    .or(`follow_up_at.lte.${new Date().toISOString()},and(kind.eq.reply,follow_up_at.is.null)`);
  return count ?? 0;
}

async function NavData() {
  await connection();
  const [todo, problems, engine] = await Promise.allSettled([
    todoCount(),
    db().from("mailboxes").select("id", { count: "exact", head: true }).eq("status", "error").then((r) => r.count ?? 0),
    getEngineState(),
  ]);
  const nav = <Nav inboxCount={todo.status === "fulfilled" ? todo.value : 0} accountProblem={problems.status === "fulfilled" && problems.value > 0} />;
  // Not configured yet (or the database is unreachable): the page's own error screen explains it.
  if (engine.status === "rejected") return <SidebarShell nav={nav} />;
  return <SidebarShell nav={nav} pill={<SendingPill state={engine.value} />} compactPill={<SendingPill state={engine.value} compact />} />;
}

/** Required migrations: shown on every page. The optional one: a soft note on Home and Settings only. */
async function DbUpdateBanner() {
  await connection();
  let status: { required: string[]; optional: string[] };
  try {
    status = await migrationStatus();
  } catch {
    return null; // not configured yet — the page's own error screen explains that
  }
  if (status.required.length) {
    return (
      <div className="mb-5 rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-[13px]">
        <b>One-time database update needed.</b> Open the Supabase SQL editor, paste the contents of{" "}
        {status.required.map((f, i) => <span key={f}>{i ? " then " : ""}<code className="font-mono">supabase/migrations/{f}</code></span>)}, and click Run.
        Sending is paused until then so nothing goes wrong.
      </div>
    );
  }
  if (!status.optional.length) return null;
  return (
    <OnlyOnPaths paths={["/", "/settings"]}>
      <div className="mb-5 rounded-xl border border-info/25 bg-info-soft px-4 py-3 text-[13px]">
        <b>Optional database update:</b> run{" "}
        {status.optional.map((f, i) => <span key={f}>{i ? ", " : ""}<code className="font-mono">supabase/migrations/{f}</code></span>)}{" "}
        to turn on reply labels, per-step analytics and faster counts.
      </div>
    </OnlyOnPaths>
  );
}
