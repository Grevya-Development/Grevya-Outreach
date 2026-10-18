import { Suspense } from "react";
import { Logo } from "@/components/logo";
import { LoginForm } from "./form";

export const metadata = { title: "Sign in" };

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <main className="min-h-screen grid place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-1 mb-7">
          <Logo className="h-12" priority />
          <div className="text-[12px] font-medium uppercase tracking-[0.18em] text-faint">Outreach</div>
        </div>
        <Suspense>
          <LoginForm next={searchParams.then((p) => (typeof p.next === "string" ? p.next : "/"))} />
        </Suspense>
      </div>
    </main>
  );
}
