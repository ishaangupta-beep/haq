import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";

let client: SupabaseClient | null = null;

/** Server-only client (service role). Never import this into a client component. */
export function db(): SupabaseClient {
  if (!client) {
    client = createClient(env.supabaseUrl(), env.supabaseKey(), {
      auth: { persistSession: false },
    });
  }
  return client;
}

/** Tests only: swap in an in-memory client. */
export function __setDbForTests(c: SupabaseClient | null) {
  client = c;
}

export async function logEvent(caseId: string, type: string, message: string) {
  const { error } = await db().from("case_events").insert({ case_id: caseId, type, message });
  if (error) console.error("logEvent failed", error.message);
}
