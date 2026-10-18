// Applies every SQL file in supabase/migrations to DATABASE_URL (Supabase → Project Settings → Database → Connection string).
import { config } from "dotenv";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

config({ path: [".env.local", ".env"], quiet: true });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set in .env.local / .env");
  process.exit(1);
}

const sql = postgres(url, { ssl: "require", max: 1, onnotice: () => {} });
const dir = join(process.cwd(), "supabase/migrations");

for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  process.stdout.write(`Applying ${file} … `);
  await sql.unsafe(readFileSync(join(dir, file), "utf8"));
  console.log("done");
}
await sql.end();
