"use client";

import { AlertTriangle, RotateCw } from "lucide-react";
import { Button, Card } from "@/components/ui";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const msg = error.message || "";
  const setup = /environment variable|SUPABASE|fetch failed|relation .* does not exist|Could not find the function/i.test(msg);
  return (
    <Card className="p-6 max-w-xl fade-in">
      <div className="flex items-center gap-2 text-bad font-medium"><AlertTriangle size={17} />{setup ? "The app isn't connected yet" : "Something went wrong"}</div>
      <p className="text-[13px] text-muted mt-2 break-words">{msg || "Unexpected error"}</p>
      {setup && (
        <ol className="text-[13px] mt-3 grid gap-1 list-decimal pl-5">
          <li>Fill in <code>SUPABASE_URL</code> and <code>SUPABASE_SERVICE_ROLE_KEY</code> in <code>.env.local</code></li>
          <li>Create the tables: <code>npm run db:setup</code> (or paste <code>supabase/migrations/0001_init.sql</code> into the Supabase SQL editor)</li>
          <li>Restart <code>npm run dev</code></li>
        </ol>
      )}
      <Button className="mt-4" onClick={reset}><RotateCw size={14} />Try again</Button>
    </Card>
  );
}
