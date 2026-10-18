import { Suspense } from "react";
import { Logo } from "@/components/logo";
import { UnsubscribeForm } from "./form";

export const metadata = { title: "Unsubscribe", robots: { index: false } };

// Confirmation step on purpose: link scanners open every URL in an email, and we
// don't want them unsubscribing people. The one-click header uses /api/unsubscribe.
export default function UnsubscribePage({ params }: PageProps<"/u/[token]">) {
  return (
    <main className="min-h-screen grid place-items-center px-4">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-panel p-6 text-center">
        <Logo className="h-8 mb-5" />
        <Suspense>
          <UnsubscribeForm token={params.then((p) => p.token)} />
        </Suspense>
      </div>
    </main>
  );
}
