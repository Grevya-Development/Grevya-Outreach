import { applyLeadFilter, parseLeadFilter } from "@/app/(app)/leads/tabs";
import { apiAuth } from "@/lib/api-auth";
import { LEAD_STATUS_LABEL, verifyLabel } from "@/lib/labels";
import { db } from "@/lib/supabase";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK = 1000;
const COLUMNS = "email, first_name, last_name, company, title, website, tags, verify_status, status, created_at";
const HEADER = ["email", "first_name", "last_name", "company", "title", "website", "lists", "email_check", "status", "added"];

type Row = {
  email: string; first_name: string | null; last_name: string | null; company: string | null; title: string | null; website: string | null;
  tags: string[] | null; verify_status: string | null; status: string; created_at: string;
};

/** Quotes a CSV cell; cells starting with = + - @ are prefixed so spreadsheets don't run them as formulas. */
function cell(v: string | null | undefined): string {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function line(r: Row): string {
  return [
    r.email, r.first_name, r.last_name, r.company, r.title, r.website, (r.tags ?? []).join("; "),
    verifyLabel(r.verify_status, false), LEAD_STATUS_LABEL[r.status] ?? r.status, r.created_at?.slice(0, 10),
  ].map(cell).join(",") + "\r\n";
}

/**
 * GET /api/leads/export?ids=a,b,c  or  ?q=&tag=&status=&check= (the same filters as the Leads page).
 * Streams the CSV 1,000 rows at a time, so big lists never sit in memory.
 */
export async function GET(req: Request) {
  const deny = await apiAuth();
  if (deny) return deny;
  const sp = new URL(req.url).searchParams;
  const ids = (sp.get("ids") ?? "").split(",").map((s) => s.trim()).filter((s) => UUID.test(s));
  const filter = parseLeadFilter((k) => sp.get(k) ?? undefined);
  const byIds = sp.has("ids");
  const supa = db();
  const enc = new TextEncoder();

  async function page(n: number): Promise<Row[]> {
    if (byIds) {
      const part = ids.slice(n * 300, n * 300 + 300);
      if (!part.length) return [];
      const { data, error } = await supa.from("leads").select(COLUMNS).in("id", part).order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as Row[];
    }
    const { data, error } = await applyLeadFilter(supa.from("leads").select(COLUMNS), filter)
      .order("created_at", { ascending: false }).order("id").range(n * CHUNK, n * CHUNK + CHUNK - 1);
    if (error) throw new Error(error.message);
    return (data ?? []) as Row[];
  }

  let n = 0;
  let done = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode("﻿" + HEADER.join(",") + "\r\n")); // BOM: Excel reads it as UTF-8
    },
    async pull(controller) {
      if (done) return controller.close();
      try {
        const rows = await page(n++);
        if (rows.length) controller.enqueue(enc.encode(rows.map(line).join("")));
        if (byIds ? n * 300 >= ids.length : rows.length < CHUNK) {
          done = true;
          controller.close();
        }
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=leads.csv",
      "Cache-Control": "no-store",
    },
  });
}
