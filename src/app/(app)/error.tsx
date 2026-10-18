"use client";

import { AlertTriangle, RotateCw } from "lucide-react";
import { Button, ButtonLink, Card } from "@/components/ui";

const DEV = process.env.NODE_ENV === "development";

export default function AppError({ error, retry }: { error: unknown; retry: () => void }) {
  const msg = error instanceof Error ? error.message : "";
  const digest = error instanceof Error && "digest" in error && typeof error.digest === "string" ? error.digest : null;
  // Setup problems (missing env, tables not created) only make sense to the developer running the app.
  const setup = DEV && /environment variable|SUPABASE|fetch failed|relation .* does not exist|Could not find the function/i.test(msg);
  return (
    <Card className="p-6 max-w-xl fade-in">
      <div className="flex items-center gap-2 text-bad font-medium"><AlertTriangle size={17} />{setup ? "The app isn't connected yet" : "Couldn't load this page"}</div>
      <p className="text-[13px] text-muted mt-2">
        Check your internet connection and try again. If it keeps happening, the reference below helps find the cause.
      </p>
      {digest && <p className="text-[12px] text-faint mt-2 font-mono">Ref: {digest}</p>}
      {DEV && msg && <p className="text-[12px] text-muted mt-2 font-mono break-words">{msg}</p>}
      {setup && (
        <ol className="text-[13px] mt-3 grid gap-1 list-decimal pl-5">
          <li>Fill in <code>SUPABASE_URL</code> and <code>SUPABASE_SERVICE_ROLE_KEY</code> in <code>.env.local</code></li>
          <li>Create the tables: <code>npm run db:setup</code> (or paste <code>supabase/migrations/0001_init.sql</code> into the Supabase SQL editor)</li>
          <li>Restart <code>npm run dev</code></li>
        </ol>
      )}
      <div className="flex flex-wrap gap-2 mt-4">
        <Button variant="primary" onClick={() => retry()}><RotateCw size={14} />Try again</Button>
        <ButtonLink href="/">Go to Home</ButtonLink>
      </div>
    </Card>
  );
}
