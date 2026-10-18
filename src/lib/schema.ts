import { db } from "./supabase";

// Each migration adds columns the code relies on. Probing one column per migration tells us
// whether the database is up to date, so the engine never runs against an old schema.
// Optional migrations unlock extras (faster counts, reply labels…); the app works without them.
const PROBES: { file: string; table: string; column: string; optional?: boolean }[] = [
  { file: "0001_init.sql", table: "mailboxes", column: "id" },
  { file: "0002_research_and_safety.sql", table: "campaigns", column: "mode" },
  { file: "0003_followups.sql", table: "replies", column: "handled" },
  { file: "0004_flow.sql", table: "campaigns", column: "sequence_confirmed_at", optional: true },
];

const OPTIONAL_TTL_MS = 10 * 60_000;
const REQUIRED_RETRY_MS = 15_000; // while something is missing, notice the fix quickly

type Entry = { at: number; missing: string[] };
type Memo = { required?: Entry; optional?: Entry; inflight?: Partial<Record<"required" | "optional", Promise<string[]>>> };
const g = globalThis as { __schemaMemo?: Memo }; // shared across route bundles and hot reloads
const memo = (g.__schemaMemo ??= {});

async function probe(list: typeof PROBES): Promise<string[]> {
  const supa = db();
  const results = await Promise.all(list.map(async (p) => {
    const { error } = await supa.from(p.table).select(p.column).limit(1);
    return error ? p.file : null;
  }));
  return results.filter((f): f is string => f !== null);
}

/** Probes one group, re-using a result that is still fresh and sharing a probe already in flight. */
function check(group: "required" | "optional", maxAge: number): Promise<string[]> {
  const prev = memo[group];
  // Once a migration is in, it stays in: an empty result is remembered for the life of the process.
  if (prev && (!prev.missing.length || Date.now() - prev.at < maxAge)) return Promise.resolve(prev.missing);
  const inflight = (memo.inflight ??= {});
  inflight[group] ??= probe(PROBES.filter((p) => !!p.optional === (group === "optional")))
    .then((missing) => { memo[group] = { at: Date.now(), missing }; return missing; })
    .finally(() => { delete inflight[group]; });
  return inflight[group]!;
}

/** Required migration files that still need to be run (empty when the database is current). */
export async function missingMigrations(): Promise<string[]> {
  return check("required", REQUIRED_RETRY_MS);
}

/** Required and optional migrations that still need to be run. */
export async function migrationStatus(): Promise<{ required: string[]; optional: string[] }> {
  const [required, optional] = await Promise.all([check("required", REQUIRED_RETRY_MS), check("optional", OPTIONAL_TTL_MS)]);
  return { required, optional };
}
