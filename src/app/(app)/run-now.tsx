"use client";

import { Zap } from "lucide-react";
import { runEngineNow } from "@/app/actions/misc";
import { ActionButton } from "@/components/client";

export function RunNowButton() {
  return (
    <ActionButton action={runEngineNow} title="Runs one engine cycle now: sends at most one email per mailbox that's due, then checks inboxes">
      <Zap size={15} />Run engine now
    </ActionButton>
  );
}
