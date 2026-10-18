import { Suspense } from "react";
import { connection } from "next/server";
import Link from "next/link";
import { Logo, LogoMark } from "@/components/logo";
import { Nav, NavList } from "@/components/nav";
import { missingMigrations } from "@/lib/schema";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="min-h-screen md:grid md:grid-cols-[220px_1fr]">
      <aside className="sticky top-0 z-20 md:h-screen border-b md:border-b-0 md:border-r border-line bg-bg/90 backdrop-blur px-3 py-3 md:py-4 flex md:flex-col gap-3 md:gap-5">
        <Link href="/" className="flex flex-col gap-0.5 px-1.5 shrink-0" aria-label="Grevya Outreach — dashboard">
          <LogoMark className="h-7 md:hidden" />
          <Logo className="hidden md:inline-block h-8" priority />
          <span className="hidden md:block text-[11px] font-medium uppercase tracking-[0.14em] text-faint pl-0.5">Outreach</span>
        </Link>
        <Suspense fallback={<NavList />}>
          <Nav />
        </Suspense>
      </aside>
      <main className="min-w-0 px-4 sm:px-6 lg:px-8 py-6 max-w-[1240px] w-full">
        <Suspense fallback={null}><DbUpdateBanner /></Suspense>
        {children}
      </main>
    </div>
  );
}

/** Shown on every page while the database is behind the code. */
async function DbUpdateBanner() {
  await connection();
  let missing: string[] = [];
  try {
    missing = await missingMigrations();
  } catch {
    return null; // not configured yet — the page's own error screen explains that
  }
  if (!missing.length) return null;
  return (
    <div className="mb-5 rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-[13px]">
      <b>One-time database update needed.</b> Open the Supabase SQL editor, paste the contents of{" "}
      {missing.map((f, i) => <span key={f}>{i ? " then " : ""}<code className="font-mono">supabase/migrations/{f}</code></span>)}, and click Run.
      Sending is paused until then so nothing goes wrong.
    </div>
  );
}
