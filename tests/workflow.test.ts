import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fakeSupabase } from "./fakeSupabase";
import { __setDbForTests } from "../lib/supabase";
import { handleExecution } from "../lib/workflow";

const AGENTS = { intake: "agent-intake", advocate: "agent-advocate", callback: "agent-callback" };
Object.assign(process.env, {
  BOLNA_API_KEY: "bn-test",
  BOLNA_INTAKE_AGENT_ID: AGENTS.intake,
  BOLNA_ADVOCATE_AGENT_ID: AGENTS.advocate,
  BOLNA_CALLBACK_AGENT_ID: AGENTS.callback,
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "x",
  AUTO_CHAIN: "true",
  DEMO_COMPANY_NUMBER: "+910000000001",
});

let db: ReturnType<typeof fakeSupabase>;
let bolnaCalls: { agent_id: string; recipient_phone_number: string; user_data: Record<string, string> }[];
let execSeq = 0;

beforeEach(() => {
  db = fakeSupabase();
  __setDbForTests(db.client);
  bolnaCalls = [];
  execSeq = 0;
  globalThis.fetch = (async (_url: string, init: any) => {
    bolnaCalls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ execution_id: `exec-${++execSeq}`, status: "queued" }), { status: 200 });
  }) as any;
});

const convo = "assistant: Hi\nuser: yes";

function intakePayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "intake-1",
    agent_id: AGENTS.intake,
    status: "completed",
    conversation_duration: 95,
    transcript: convo,
    user_number: "+919999999999",
    extracted_data: {
      Case: {
        customer_name: { objective: "Ishaan" },
        company: { objective: "IndiGo" },
        issue_summary: { objective: "Flight cancelled, refund not received" },
        reference_number: { objective: "AB12CD" },
        amount_inr: { objective: "₹6,400" },
        desired_outcome: { objective: "full refund" },
        incident_date: { objective: "20 October 2026" },
      },
    },
    ...overrides,
  };
}

test("full happy path: intake → advocate → callback → resolved", async () => {
  // 1. Intake call finishes
  const r1 = await handleExecution(intakePayload());
  assert.equal(r1.action, "intake:case-created");
  const c = db.tables.cases[0];
  assert.equal(c.company, "IndiGo");
  assert.equal(c.amount_inr, 6400);
  assert.equal(c.customer_phone, "+919999999999");
  assert.match(c.policy_note, /DGCA/);

  // Advocate call placed to the demo number with the case variables
  assert.equal(bolnaCalls.length, 1);
  assert.equal(bolnaCalls[0].agent_id, AGENTS.advocate);
  assert.equal(bolnaCalls[0].recipient_phone_number, "+910000000001");
  assert.equal(bolnaCalls[0].user_data.reference_number, "AB12CD");
  assert.equal(bolnaCalls[0].user_data.case_id, c.id);
  assert.equal(c.status, "calling_company");

  // 2. Advocate: in-progress delivery, then final
  const advExec = "exec-1";
  assert.equal((await handleExecution({ id: advExec, agent_id: AGENTS.advocate, status: "in-progress" })).action, "progress:in-progress");
  const r2 = await handleExecution({
    id: advExec,
    agent_id: AGENTS.advocate,
    status: "completed",
    conversation_duration: 120,
    transcript: convo,
    extracted_data: { outcome: "Escalated to refunds team", ticket_number: "IG-48213", resolution_timeline: "7 working days", amount_agreed: "6400" },
  });
  assert.equal(r2.action, "advocate:recorded");
  assert.equal(c.outcome, "escalated");
  assert.equal(c.ticket_number, "IG-48213");
  assert.equal(c.amount_agreed, 6400);

  // Callback placed to the customer with the result
  assert.equal(bolnaCalls.length, 2);
  assert.equal(bolnaCalls[1].agent_id, AGENTS.callback);
  assert.equal(bolnaCalls[1].recipient_phone_number, "+919999999999");
  assert.equal(bolnaCalls[1].user_data.ticket_number, "IG-48213");
  assert.equal(c.status, "calling_customer");

  // 3. Callback finishes
  const r3 = await handleExecution({
    id: "exec-2",
    agent_id: AGENTS.callback,
    status: "completed",
    conversation_duration: 60,
    transcript: convo,
    extracted_data: { customer_decision: "satisfied" },
  });
  assert.equal(r3.action, "callback:resolved");
  assert.equal(c.status, "resolved");
  assert.ok(db.tables.case_events.length >= 5);
});

test("duplicate webhook deliveries are processed once", async () => {
  await handleExecution(intakePayload());
  await handleExecution(intakePayload());
  assert.equal(db.tables.cases.length, 1);
  assert.equal(bolnaCalls.length, 1);
});

test("unanswered intake creates no case", async () => {
  const r = await handleExecution(intakePayload({ conversation_duration: 0, transcript: "assistant: Hello?" }));
  assert.equal(r.action, "intake:no-usable-conversation");
  assert.equal(db.tables.cases.length, 0);
  assert.equal(bolnaCalls.length, 0);
});

test("customer care not picking up flags the case", async () => {
  await handleExecution(intakePayload());
  const r = await handleExecution({ id: "exec-1", agent_id: AGENTS.advocate, status: "no-answer", conversation_duration: 0 });
  assert.equal(r.action, "advocate:no-answer");
  assert.equal(db.tables.cases[0].status, "needs_attention");
  assert.equal(bolnaCalls.length, 1); // no callback placed
});

test("rejected + customer wants escalation → complaint drafted", async () => {
  await handleExecution(intakePayload());
  await handleExecution({
    id: "exec-1", agent_id: AGENTS.advocate, status: "completed", conversation_duration: 90, transcript: convo,
    extracted_data: { outcome: "rejected", next_step: "customer may escalate" },
  });
  const r = await handleExecution({
    id: "exec-2", agent_id: AGENTS.callback, status: "completed", conversation_duration: 50, transcript: convo,
    extracted_data: { customer_decision: "wants_escalation" },
  });
  assert.equal(r.action, "callback:escalation_drafted");
  assert.match(db.tables.cases[0].escalation_draft, /Complaint against: IndiGo/);
});

test("webhook arriving before our call row is saved still finds the case", async () => {
  await handleExecution(intakePayload());
  const caseId = db.tables.cases[0].id;
  // Simulate the race: drop the advocate call row we registered
  db.tables.calls = db.tables.calls.filter((r) => r.kind !== "advocate");
  const r = await handleExecution({
    id: "exec-1", agent_id: AGENTS.advocate, status: "completed", conversation_duration: 90, transcript: convo,
    extracted_data: { outcome: "approved" },
    context_details: { recipient_data: { case_id: caseId } },
  });
  assert.equal(r.action, "advocate:recorded");
  assert.equal(db.tables.cases[0].outcome, "approved");
});

test("unknown agents are ignored", async () => {
  const r = await handleExecution({ id: "x", agent_id: "someone-else", status: "completed" });
  assert.equal(r.action, "ignored:unknown-agent");
});
