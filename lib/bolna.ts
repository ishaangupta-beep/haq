import { env } from "./env";

/**
 * Place an outbound call with Bolna (POST /call).
 * user_data fills the {{variables}} in the agent's prompt and welcome message.
 * Docs: https://www.bolna.ai/docs/api-reference/calls/make
 */
export async function makeCall(opts: {
  agentId: string;
  to: string;
  userData: Record<string, string>;
}): Promise<{ executionId: string }> {
  const body: Record<string, unknown> = {
    agent_id: opts.agentId,
    recipient_phone_number: opts.to,
    user_data: opts.userData,
  };
  const from = env.fromNumber();
  if (from) body.from_phone_number = from;

  const res = await fetch(`${env.bolnaBase()}/call`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.bolnaKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON error body */
  }

  if (!res.ok) {
    throw new Error(`Bolna /call failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const executionId = (json.execution_id ?? json.id) as string | undefined;
  if (!executionId) throw new Error(`Bolna /call returned no execution_id: ${text.slice(0, 300)}`);
  return { executionId };
}
