import { NextResponse } from "next/server";

/**
 * Protects the case API (it exposes phone numbers and can place paid calls).
 * Send the key as header `x-haq-key: <key>` or query `?key=<key>`.
 * Uses ADMIN_KEY if set, otherwise WEBHOOK_SECRET.
 * Returns a 401 response when the key is wrong, or null when it's fine.
 */
export function requireKey(req: Request): NextResponse | null {
  const expected = process.env.ADMIN_KEY || process.env.WEBHOOK_SECRET || "";
  if (!expected) {
    return NextResponse.json({ error: "Server has no ADMIN_KEY / WEBHOOK_SECRET set" }, { status: 500 });
  }
  const given = req.headers.get("x-haq-key") ?? new URL(req.url).searchParams.get("key");
  if (given !== expected) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  return null;
}
