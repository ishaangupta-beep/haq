// Orchestration: decides what happens after each Bolna call.
//
//   Intake call ends    → create case          → (auto) start Advocate call
//   Advocate call ends  → save company's reply → (auto) start Callback call
//   Callback call ends  → save user's decision → resolve, or draft escalation

import { db, logEvent } from "./supabase";
import { env } from "./env";
import { makeCall } from "./bolna";
import {
  TERMINAL_STATUSES,
  type BolnaExecution,
  type CallKind,
  flattenExtractions,
  hadConversation,
  parseAmount,
  normaliseOutcome,
  normaliseDecision,
  statusAfterCallback,
  policyFor,
  escalationDraft,
  advocateVariables,
  callbackVariables,
} from "./core";

type Result = { action: string; caseId?: string };

/** Entry point for every Bolna webhook delivery. Safe to call repeatedly for the same call. */
export async function handleExecution(e: BolnaExecution): Promise<Result> {
  if (!e?.id) return { action: "ignored:no-id" };
  const supa = db();

  // Which call is this? Outbound calls were registered when we placed them.
  const { data: existing } = await supa
    .from("calls")
    .select("id, case_id, kind, processed_at")
    .eq("execution_id", e.id)
    .maybeSingle();

  let kind: CallKind | null = (existing?.kind as CallKind) ?? null;
  if (!kind) {
    const agents = env.agents();
    if (e.agent_id === agents.intake) kind = "intake";
    else if (e.agent_id === agents.advocate) kind = "advocate";
    else if (e.agent_id === agents.callback) kind = "callback";
  }
  if (!kind) return { action: "ignored:unknown-agent" };

  // Live status for the dashboard while the call is still running
  if (!TERMINAL_STATUSES.has(e.status ?? "")) {
    if (existing) await supa.from("calls").update({ status: e.status }).eq("id", existing.id);
    return { action: `progress:${e.status}`, caseId: existing?.case_id ?? undefined };
  }

  if (existing?.processed_at) return { action: "ignored:already-processed", caseId: existing.case_id };

  // Make sure a row exists (intake calls are inbound, so we haven't seen them yet)
  if (!existing) {
    await supa.from("calls").upsert({ execution_id: e.id, kind }, { onConflict: "execution_id", ignoreDuplicates: true });
  }

  // Claim the call atomically so duplicate webhooks don't double-process it
  const extracted = flattenExtractions(e.extracted_data);
  const { data: claimed } = await supa
    .from("calls")
    .update({
      processed_at: new Date().toISOString(),
      status: e.status,
      termination_reason: e.termination_reason ?? null,
      conversation_duration: e.conversation_duration ?? null,
      transcript: e.transcript ?? null,
      summary: e.summary ?? null,
      recording_url: e.telephony_data?.recording_url ?? null,
      extracted,
    })
    .eq("execution_id", e.id)
    .is("processed_at", null)
    .select("id, case_id")
    .maybeSingle();

  if (!claimed) return { action: "ignored:raced" };

  if (kind === "intake") return onIntakeDone(e, extracted, claimed.id);

  // If the webhook beat our own insert, fall back to the case_id we passed as a call variable
  const fromVars = e.context_details?.recipient_data?.case_id;
  const caseId = claimed.case_id ?? (typeof fromVars === "string" ? fromVars : null);
  if (caseId && !claimed.case_id) await supa.from("calls").update({ case_id: caseId }).eq("id", claimed.id);

  if (kind === "advocate") return onAdvocateDone(e, extracted, caseId);
  return onCallbackDone(e, extracted, caseId);
}

async function onIntakeDone(e: BolnaExecution, x: Record<string, string>, callRowId: string): Promise<Result> {
  if (!hadConversation(e) || !x.company) {
    return { action: "intake:no-usable-conversation" };
  }
  const supa = db();
  const callerPhone =
    e.context_details?.recipient_phone_number ?? e.user_number ?? e.telephony_data?.from_number ?? null;

  const { data: c, error } = await supa
    .from("cases")
    .insert({
      customer_name: x.customer_name ?? null,
      customer_phone: callerPhone,
      company: x.company,
      issue_summary: x.issue_summary ?? null,
      reference_number: x.reference_number ?? null,
      amount_inr: parseAmount(x.amount_inr),
      desired_outcome: x.desired_outcome ?? null,
      incident_date: x.incident_date ?? null,
      policy_note: policyFor(x.company, x.issue_summary),
      status: "intake_done",
    })
    .select("id")
    .single();
  if (error || !c) throw new Error(`Could not create case: ${error?.message}`);

  await supa.from("calls").update({ case_id: c.id }).eq("id", callRowId);
  await logEvent(c.id, "intake", `${x.customer_name ?? "Caller"} reported an issue with ${x.company}.`);

  if (env.autoChain()) await safeStart(c.id, () => startAdvocate(c.id));
  return { action: "intake:case-created", caseId: c.id };
}

async function onAdvocateDone(e: BolnaExecution, x: Record<string, string>, caseId: string | null): Promise<Result> {
  if (!caseId) return { action: "advocate:no-case" };
  const supa = db();

  if (!hadConversation(e)) {
    await supa.from("cases").update({ status: "needs_attention" }).eq("id", caseId);
    await logEvent(caseId, "advocate", `Customer care didn't pick up (${e.termination_reason ?? e.status}).`);
    return { action: "advocate:no-answer", caseId };
  }

  const outcome = normaliseOutcome(x.outcome);
  await supa
    .from("cases")
    .update({
      outcome,
      ticket_number: x.ticket_number ?? null,
      resolution_timeline: x.resolution_timeline ?? null,
      amount_agreed: parseAmount(x.amount_agreed),
      next_step: x.next_step ?? null,
      status: "company_responded",
    })
    .eq("id", caseId);

  await logEvent(
    caseId,
    "advocate",
    `Customer care responded: ${outcome ?? "unclear"}` +
      (x.ticket_number ? ` · ticket ${x.ticket_number}` : "") +
      (x.resolution_timeline ? ` · ${x.resolution_timeline}` : ""),
  );

  if (env.autoChain()) await safeStart(caseId, () => startCallback(caseId));
  return { action: "advocate:recorded", caseId };
}

async function onCallbackDone(e: BolnaExecution, x: Record<string, string>, caseId: string | null): Promise<Result> {
  if (!caseId) return { action: "callback:no-case" };
  const supa = db();

  if (!hadConversation(e)) {
    await supa.from("cases").update({ customer_decision: "no_response", status: "needs_attention" }).eq("id", caseId);
    await logEvent(caseId, "callback", "Couldn't reach the customer with the result.");
    return { action: "callback:no-answer", caseId };
  }

  const { data: c } = await supa.from("cases").select("*").eq("id", caseId).single();
  const decision = normaliseDecision(x.customer_decision);
  const status = statusAfterCallback(decision, c?.outcome ?? null);

  const update: Record<string, unknown> = { customer_decision: decision, status };
  if (status === "escalation_drafted" && c) update.escalation_draft = escalationDraft(c);
  await supa.from("cases").update(update).eq("id", caseId);

  await logEvent(
    caseId,
    "callback",
    status === "escalation_drafted"
      ? "Customer wants to escalate — National Consumer Helpline complaint drafted."
      : `Customer informed of the result (${decision ?? "acknowledged"}).`,
  );
  return { action: `callback:${status}`, caseId };
}

// ---- Starting outbound calls ----

export async function startAdvocate(caseId: string, companyPhone?: string): Promise<{ executionId: string }> {
  const supa = db();
  const { data: c, error } = await supa.from("cases").select("*").eq("id", caseId).single();
  if (error || !c) throw new Error("Case not found");

  const to = env.demoCompanyNumber() ?? companyPhone ?? c.company_phone;
  if (!to) throw new Error("No helpline number for this company. Set DEMO_COMPANY_NUMBER or pass company_phone.");
  if (companyPhone && companyPhone !== c.company_phone) {
    await supa.from("cases").update({ company_phone: companyPhone }).eq("id", caseId);
  }

  const { executionId } = await makeCall({
    agentId: env.agents().advocate,
    to,
    userData: advocateVariables(c),
  });

  await supa
    .from("calls")
    .upsert({ case_id: caseId, kind: "advocate", execution_id: executionId }, { onConflict: "execution_id" });
  await supa.from("cases").update({ status: "calling_company" }).eq("id", caseId);
  await logEvent(caseId, "advocate", `Calling ${c.company ?? "the company"} customer care…`);
  return { executionId };
}

export async function startCallback(caseId: string): Promise<{ executionId: string }> {
  const supa = db();
  const { data: c, error } = await supa.from("cases").select("*").eq("id", caseId).single();
  if (error || !c) throw new Error("Case not found");
  if (!c.customer_phone) throw new Error("No phone number on file for the customer.");

  const { executionId } = await makeCall({
    agentId: env.agents().callback,
    to: c.customer_phone,
    userData: callbackVariables(c),
  });

  await supa
    .from("calls")
    .upsert({ case_id: caseId, kind: "callback", execution_id: executionId }, { onConflict: "execution_id" });
  await supa.from("cases").update({ status: "calling_customer" }).eq("id", caseId);
  await logEvent(caseId, "callback", `Calling ${c.customer_name ?? "the customer"} back with the result…`);
  return { executionId };
}

async function safeStart(caseId: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("auto-chain failed", msg);
    await db().from("cases").update({ status: "needs_attention" }).eq("id", caseId);
    await logEvent(caseId, "error", msg);
  }
}

export async function draftEscalation(caseId: string): Promise<string> {
  const supa = db();
  const { data: c, error } = await supa.from("cases").select("*").eq("id", caseId).single();
  if (error || !c) throw new Error("Case not found");
  const draft = escalationDraft(c);
  await supa.from("cases").update({ escalation_draft: draft, status: "escalation_drafted" }).eq("id", caseId);
  await logEvent(caseId, "escalation", "National Consumer Helpline complaint drafted.");
  return draft;
}
