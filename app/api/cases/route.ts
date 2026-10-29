import { NextResponse } from "next/server";
import { requireKey } from "@/lib/auth";
import { db, logEvent } from "@/lib/supabase";
import { env } from "@/lib/env";
import { parseAmount, policyFor } from "@/lib/core";
import { startAdvocate } from "@/lib/workflow";

export const dynamic = "force-dynamic";

// GET /api/cases — list for the dashboard
export async function GET(req: Request) {
  const denied = requireKey(req);
  if (denied) return denied;
  const { data, error } = await db().from("cases").select("*").order("created_at", { ascending: false }).limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// POST /api/cases — create a case from the web form (fallback to the phone intake)
export async function POST(req: Request) {
  const denied = requireKey(req);
  if (denied) return denied;
  const b = await req.json().catch(() => null);
  if (!b?.company || !b?.customer_phone) {
    return NextResponse.json({ error: "company and customer_phone are required" }, { status: 400 });
  }

  const { data: c, error } = await db()
    .from("cases")
    .insert({
      customer_name: b.customer_name ?? null,
      customer_phone: b.customer_phone,
      company: b.company,
      company_phone: b.company_phone ?? null,
      issue_summary: b.issue_summary ?? null,
      reference_number: b.reference_number ?? null,
      amount_inr: typeof b.amount_inr === "number" ? b.amount_inr : parseAmount(String(b.amount_inr ?? "")),
      desired_outcome: b.desired_outcome ?? "full refund",
      incident_date: b.incident_date ?? null,
      policy_note: policyFor(b.company, b.issue_summary),
      status: "intake_done",
    })
    .select("*")
    .single();
  if (error || !c) return NextResponse.json({ error: error?.message }, { status: 500 });

  await logEvent(c.id, "intake", `${c.customer_name ?? "Customer"} reported an issue with ${c.company} (web form).`);

  if (b.start_now ?? env.autoChain()) {
    try {
      await startAdvocate(c.id);
    } catch (err) {
      await logEvent(c.id, "error", err instanceof Error ? err.message : String(err));
    }
  }
  return NextResponse.json(c, { status: 201 });
}
