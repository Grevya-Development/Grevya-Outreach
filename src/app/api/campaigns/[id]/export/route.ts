import { apiAuth } from "@/lib/api-auth";
import { fmtDateTime } from "@/lib/format";
import { campaignLeadStatus } from "@/lib/labels";
import { db } from "@/lib/supabase";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK = 1000;
const COLUMNS = "id, status, current_step, next_send_at, prep_status, skip_reason, last_error, fit_score, leads(email, first_name, last_name, company)";
const HEADER = ["email", "name", "company", "status", "emails_sent", "next_email", "fit", "replied"];

type Row = {
  status: string; current_step: number; next_send_at: string | null; prep_status: string | null; skip_reason: string | null;
  last_error: string | null; fit_score: number | null;
  leads: { email: string; first_name: string | null; last_name: string | null; company: string | null } | null;
};

/** Quotes a CSV cell; cells starting with = + - @ are prefixed so spreadsheets don't run them as formulas. */
function cell(v: string | number | null | undefined): string {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * GET /api/campaigns/{id}/export: every lead in the campaign with their status, as CSV. Streams
 * 1,000 rows at a time, so big campaigns never sit in memory.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const deny = await apiAuth();
  if (deny) return deny;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "not found" }, { status: 404 });
  const supa = db();
  const [campaignRes, stepsRes] = await Promise.all([
    supa.from("campaigns").select("name, status, mode").eq("id", id).maybeSingle(),
    supa.from("campaign_steps").select("id", { count: "exact", head: true }).eq("campaign_id", id),
  ]);
  const campaign = campaignRes.data as { name: string; status: string; mode: string } | null;
  if (!campaign) return Response.json({ error: "not found" }, { status: 404 });
  const ctxLabels = { mode: campaign.mode, totalSteps: stepsRes.count ?? 0, campaignStatus: campaign.status };

  const line = (r: Row) => {
    const l = r.leads;
    const waiting = r.status === "queued" || r.status === "in_progress";
    const st = campaignLeadStatus(r, ctxLabels);
    return [
      l?.email, [l?.first_name, l?.last_name].filter(Boolean).join(" "), l?.company,
      st.detail ? `${st.label} (${st.detail})` : st.label, r.current_step,
      waiting && campaign.status === "active" && r.next_send_at ? fmtDateTime(r.next_send_at) : "",
      r.fit_score ?? "", r.status === "replied" ? "yes" : "",
    ].map(cell).join(",") + "\r\n";
  };

  const enc = new TextEncoder();
  let n = 0;
  let done = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode("﻿" + HEADER.join(",") + "\r\n")); // BOM: Excel reads it as UTF-8
    },
    async pull(controller) {
      if (done) return controller.close();
      try {
        const { data, error } = await supa.from("campaign_leads").select(COLUMNS).eq("campaign_id", id)
          .order("created_at").order("id").range(n * CHUNK, n * CHUNK + CHUNK - 1);
        if (error) throw new Error(error.message);
        n++;
        const rows = (data ?? []) as unknown as Row[];
        if (rows.length) controller.enqueue(enc.encode(rows.map(line).join("")));
        if (rows.length < CHUNK) {
          done = true;
          controller.close();
        }
      } catch (err) {
        controller.error(err);
      }
    },
  });

  const slug = campaign.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "campaign";
  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug}-leads.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
