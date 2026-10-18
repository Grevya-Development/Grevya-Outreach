import { db } from "./supabase";

// Each migration adds columns the code relies on. Probing one column per migration tells us
// whether the database is up to date, so the engine never runs against an old schema.
const PROBES: { file: string; table: string; column: string }[] = [
  { file: "0001_init.sql", table: "mailboxes", column: "id" },
  { file: "0002_research_and_safety.sql", table: "campaigns", column: "mode" },
  { file: "0003_followups.sql", table: "replies", column: "handled" },
];

let cached: { at: number; missing: string[] } | null = null;

/** Migration files that still need to be run (empty when the database is current). */
export async function missingMigrations(): Promise<string[]> {
  if (cached && Date.now() - cached.at < 60_000 && !cached.missing.length) return cached.missing;
  const supa = db();
  const missing: string[] = [];
  for (const p of PROBES) {
    const { error } = await supa.from(p.table).select(p.column).limit(1);
    if (error) missing.push(p.file);
  }
  cached = { at: Date.now(), missing };
  return missing;
}
