import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { handleExecution } from "@/lib/workflow";
import type { BolnaExecution } from "@/lib/core";

export const dynamic = "force-dynamic";

// Paste this URL into each agent's Analytics/Extractions → Webhook URL:
//   https://<your-app>.vercel.app/api/webhooks/bolna?secret=<WEBHOOK_SECRET>
export async function POST(req: Request) {
  const secret = env.webhookSecret();
  if (secret && new URL(req.url).searchParams.get("secret") !== secret) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  let payload: BolnaExecution;
  try {
    payload = (await req.json()) as BolnaExecution;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  try {
    const result = await handleExecution(payload);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("webhook error", msg);
    // 200 so Bolna doesn't hammer retries on a logic error; the error is in our logs
    return NextResponse.json({ action: "error", error: msg });
  }
}
