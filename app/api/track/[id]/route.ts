import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/track/:id — public, read-only view of ONE case for the customer.
// The case id is an unguessable UUID (like a courier tracking link).
// Deliberately excludes phone numbers, transcripts, recordings and other cases.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const supa = db();
  const [c, events] = await Promise.all([
    supa
      .from("cases")
      .select(
        "id, created_at, updated_at, customer_name, company, issue_summary, reference_number, amount_inr, desired_outcome, incident_date, outcome, ticket_number, resolution_timeline, amount_agreed, next_step, escalation_draft, status",
      )
      .eq("id", id)
      .maybeSingle(),
    supa.from("case_events").select("id, created_at, type, message").eq("case_id", id).neq("type", "error").order("created_at"),
  ]);
  if (!c.data) return NextResponse.json({ error: "not found" }, { status: 404 });

  const firstName = (c.data.customer_name ?? "").trim().split(/\s+/)[0] || null;
  return NextResponse.json(
    { case: { ...c.data, customer_name: firstName }, events: events.data ?? [] },
    { headers: { "Cache-Control": "no-store" } },
  );
}
