import { test } from "node:test";
import assert from "node:assert/strict";
import {
  flattenExtractions,
  parseAmount,
  hadConversation,
  normaliseOutcome,
  normaliseDecision,
  statusAfterCallback,
  policyFor,
  escalationDraft,
  advocateVariables,
  callbackVariables,
} from "../lib/core.ts";

test("flattens Bolna's nested extraction shape", () => {
  const nested = {
    "Case details": {
      "Customer Name": { objective: "Ishaan", subjective: "Ishaan Gupta", confidence: 0.9 },
      company: { objective: null, subjective: "IndiGo" },
      reference_number: { objective: "AB12CD" },
      amountInr: { subjective: "Rs 6,400" },
    },
  };
  assert.deepEqual(flattenExtractions(nested), {
    customer_name: "Ishaan",
    company: "IndiGo",
    reference_number: "AB12CD",
    amount_inr: "Rs 6,400",
  });
});

test("flattens a flat extraction shape and skips empties", () => {
  assert.deepEqual(flattenExtractions({ outcome: "escalated", ticket_number: "IG-48213", next_step: "" }), {
    outcome: "escalated",
    ticket_number: "IG-48213",
  });
  assert.deepEqual(flattenExtractions({}), {});
  assert.deepEqual(flattenExtractions(null), {});
});

test("parses rupee amounts", () => {
  assert.equal(parseAmount("₹6,400"), 6400);
  assert.equal(parseAmount("Rs 1,25,000.50"), 125000.5);
  assert.equal(parseAmount("six thousand"), null);
  assert.equal(parseAmount(undefined), null);
});

test("detects whether a real conversation happened", () => {
  assert.equal(hadConversation({ id: "1", conversation_duration: 0, transcript: "user: hi" }), false);
  assert.equal(hadConversation({ id: "1", conversation_duration: 28, transcript: "assistant: Hello?\n" }), false);
  assert.equal(hadConversation({ id: "1", conversation_duration: 40, transcript: "assistant: Hi\nuser: my flight" }), true);
});

test("normalises outcomes and decisions", () => {
  assert.equal(normaliseOutcome("Escalated to refunds team"), "escalated");
  assert.equal(normaliseOutcome("Refund approved"), "approved");
  assert.equal(normaliseOutcome("Under process"), "pending");
  assert.equal(normaliseOutcome("needs customer verification"), "needs_customer_verification");
  assert.equal(normaliseDecision("wants_escalation"), "wants_escalation");
  assert.equal(normaliseDecision("Customer is okay with it"), "satisfied");
  assert.equal(normaliseDecision("will book a follow up"), "wants_follow_up");
  assert.equal(normaliseDecision("no response"), "no_response");
});

test("decides the final status after the callback", () => {
  assert.equal(statusAfterCallback("wants_escalation", "rejected"), "escalation_drafted");
  assert.equal(statusAfterCallback(null, "rejected"), "escalation_drafted");
  assert.equal(statusAfterCallback("satisfied", "escalated"), "resolved");
});

test("picks a policy note by sector", () => {
  assert.match(policyFor("IndiGo", "flight cancelled"), /DGCA/);
  assert.match(policyFor("Airtel", "wrong bill"), /TRAI/);
  assert.match(policyFor("HDFC Bank", ""), /RBI/);
  assert.match(policyFor("Flipkart", ""), /E-Commerce/);
  assert.match(policyFor("Random Co", ""), /National Consumer Helpline/);
});

test("builds agent variables with safe defaults", () => {
  const v = advocateVariables({ id: "c1", company: "IndiGo", amount_inr: 6400 });
  assert.equal(v.case_id, "c1");
  assert.equal(v.amount_inr, "6400");
  assert.equal(v.reference_number, "not provided");
  assert.match(v.policy_note, /DGCA/);
  for (const val of Object.values(v)) assert.equal(typeof val, "string");

  const cb = callbackVariables({ id: "c1", company: "IndiGo", outcome: "escalated", ticket_number: "IG-48213", amount_agreed: 6400 });
  assert.equal(cb.ticket_number, "IG-48213");
  assert.equal(cb.amount_agreed, "6400");
  assert.equal(cb.resolution_timeline, "not given");
});

test("drafts an escalation with the case facts", () => {
  const d = escalationDraft(
    {
      customer_name: "Ishaan",
      company: "IndiGo",
      issue_summary: "Flight cancelled by airline, refund not received",
      reference_number: "AB12CD",
      amount_inr: 6400,
      outcome: "rejected",
      ticket_number: "IG-48213",
    },
    new Date("2026-10-30T10:00:00Z"),
  );
  assert.match(d, /Complaint against: IndiGo/);
  assert.match(d, /AB12CD/);
  assert.match(d, /₹6,400/);
  assert.match(d, /ticket number IG-48213/);
});
