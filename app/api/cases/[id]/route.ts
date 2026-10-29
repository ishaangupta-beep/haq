import { NextResponse } from "next/server";
import { requireKey } from "@/lib/auth";
import { db } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// GET /api/cases/:id — case + its calls + timeline
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireKey(req);
  if (denied) return denied;
  const params = await ctx.params;
  const supa = db();
  const [c, calls, events] = await Promise.all([
    supa.from("cases").select("*").eq("id", params.id).single(),
    supa.from("calls").select("*").eq("case_id", params.id).order("created_at"),
    supa.from("case_events").select("*").eq("case_id", params.id).order("created_at"),
  ]);
  if (c.error || !c.data) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ case: c.data, calls: calls.data ?? [], events: events.data ?? [] });
}
