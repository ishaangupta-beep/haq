function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name} — see .env.example`);
  return v;
}

export const env = {
  bolnaKey: () => req("BOLNA_API_KEY"),
  bolnaBase: () => process.env.BOLNA_API_BASE || "https://api.bolna.ai",
  fromNumber: () => process.env.BOLNA_FROM_NUMBER || undefined,
  agents: () => ({
    intake: req("BOLNA_INTAKE_AGENT_ID"),
    advocate: req("BOLNA_ADVOCATE_AGENT_ID"),
    callback: req("BOLNA_CALLBACK_AGENT_ID"),
  }),
  // Accept the "API URL" form too (…supabase.co/rest/v1/) — the client needs the bare project URL
  supabaseUrl: () => req("SUPABASE_URL").trim().replace(/\/rest\/v1\/?$/, "").replace(/\/+$/, ""),
  supabaseKey: () => req("SUPABASE_SERVICE_ROLE_KEY"),
  autoChain: () => (process.env.AUTO_CHAIN ?? "true").toLowerCase() === "true",
  demoCompanyNumber: () => process.env.DEMO_COMPANY_NUMBER || undefined,
  webhookSecret: () => process.env.WEBHOOK_SECRET || "",
};
