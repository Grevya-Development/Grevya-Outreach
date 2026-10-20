"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { checkRepliesNow } from "@/app/actions/inbox";
import { RelativeTime, Spinner } from "@/components/client";
import { Button } from "@/components/ui";

export function CheckRepliesClient({ lastChecked, hasAccounts }: { lastChecked: string | null; hasAccounts: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (!hasAccounts) return null;
  const check = () => start(async () => {
    const r = await checkRepliesNow();
    if (!r.ok) return void toast.error(r.error);
    toast.success(r.message ?? "Checked");
    router.refresh();
  });
  return (
    <span className="inline-flex items-center gap-2">
      <span className="hidden sm:inline text-[12px] text-faint">
        {pending ? "Checking your inbox…" : lastChecked ? <>Checked <RelativeTime iso={lastChecked} /></> : "Not checked yet"}
      </span>
      <Button onClick={check} disabled={pending} title="Look for new replies and bounces in your email accounts now">
        {pending ? <Spinner /> : <RefreshCw size={14} />}Check for replies
      </Button>
    </span>
  );
}
