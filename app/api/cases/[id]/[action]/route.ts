import { NextResponse } from "next/server";
import { startAdvocate, startCallback, draftEscalation } from "@/lib/workflow";

export const dynamic = "force-dynamic";

// POST /api/cases/:id/advocate   { company_phone? }  — call customer care now
// POST /api/cases/:id/callback                       — call the customer back now
// POST /api/cases/:id/escalate                       — draft the National Consumer Helpline complaint
export async function POST(req: Request, ctx: { params: Promise<{ id: string; action: string }> }) {
  const params = await ctx.params;
  const body = await req.json().catch(() => ({}));
  try {
    switch (params.action) {
      case "advocate":
        return NextResponse.json(await startAdvocate(params.id, body?.company_phone));
      case "callback":
        return NextResponse.json(await startCallback(params.id));
      case "escalate":
        return NextResponse.json({ draft: await draftEscalation(params.id) });
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 404 });
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
