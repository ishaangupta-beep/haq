// Pure logic: no network, no database. Unit-tested in tests/core.test.ts.

export type CallKind = "intake" | "advocate" | "callback";

export type CaseStatus =
  | "intake_done"
  | "calling_company"
  | "company_responded"
  | "calling_customer"
  | "resolved"
  | "escalation_drafted"
  | "needs_attention";

// Bolna statuses after which the payload won't change any more
export const TERMINAL_STATUSES = new Set([
  "completed",
  "no-answer",
  "busy",
  "failed",
  "canceled",
  "stopped",
  "error",
  "balance-low",
]);

export interface BolnaExecution {
  id: string;
  agent_id?: string;
  status?: string;
  termination_reason?: string | null;
  conversation_duration?: number | null;
  transcript?: string | null;
  summary?: string | null;
  extracted_data?: unknown;
  user_number?: string | null;
  telephony_data?: {
    recording_url?: string | null;
    call_type?: string | null;
    from_number?: string | null;
    to_number?: string | null;
  } | null;
  context_details?: {
    recipient_phone_number?: string | null;
    recipient_data?: Record<string, unknown> | null;
  } | null;
}

/**
 * Bolna nests extractions as Category → Extraction → { objective, subjective, ... }.
 * Agents set up in the dashboard may also return flat { field: value }.
 * This turns either shape into { field: value } with snake_case keys.
 */
export function flattenExtractions(data: unknown): Record<string, string> {
  const out: Record<string, string> = {};

  const isLeaf = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && ("objective" in v || "subjective" in v);

  const leafValue = (v: Record<string, unknown>): string | null => {
    const pick = v.objective ?? v.subjective;
    if (pick === null || pick === undefined) return null;
    return typeof pick === "string" ? pick : JSON.stringify(pick);
  };

  const walk = (node: unknown, key?: string) => {
    if (node === null || node === undefined) return;
    if (isLeaf(node)) {
      const val = leafValue(node);
      if (key && val !== null && val.trim() !== "") out[normaliseKey(key)] = val.trim();
      return;
    }
    if (typeof node === "object" && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, k);
      return;
    }
    if (key && (typeof node === "string" || typeof node === "number" || typeof node === "boolean")) {
      const s = String(node).trim();
      if (s !== "") out[normaliseKey(key)] = s;
    }
  };

  walk(data);
  return out;
}

export function normaliseKey(k: string): string {
  return k
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

/** "₹6,400", "Rs 6400", "6400 rupees" → 6400. Returns null if no number. */
export function parseAmount(v: string | undefined | null): number | null {
  if (!v) return null;
  const m = v.replace(/,/g, "").match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/** Did a real two-way conversation happen? (Bolna's "completed" alone isn't enough.) */
export function hadConversation(e: BolnaExecution): boolean {
  if (!e.conversation_duration || e.conversation_duration <= 0) return false;
  return (e.transcript ?? "").split("\n").some((l) => l.trim().toLowerCase().startsWith("user:"));
}

/** Normalise free-text outcome from the advocate call. */
export function normaliseOutcome(v: string | undefined): string | null {
  if (!v) return null;
  const s = v.toLowerCase();
  if (s.includes("verif")) return "needs_customer_verification";
  if (s.includes("escalat")) return "escalated";
  if (s.includes("approv") || s.includes("accept") || s.includes("processed")) return "approved";
  if (s.includes("reject") || s.includes("denied") || s.includes("refus")) return "rejected";
  if (s.includes("pend") || s.includes("process")) return "pending";
  return s.trim() || null;
}

export function normaliseDecision(v: string | undefined): string | null {
  if (!v) return null;
  const s = v.toLowerCase();
  if (s.includes("escalat")) return "wants_escalation";
  if (s.includes("follow")) return "wants_follow_up";
  if (s.includes("accept")) return "accepts_offer";
  if (s.includes("no_response") || s.includes("no response")) return "no_response";
  if (s.includes("satisf") || s.includes("happy") || /\bok(ay)?\b/.test(s)) return "satisfied";
  return s.trim() || null;
}

/** Status after the callback call, based on what the user decided. */
export function statusAfterCallback(decision: string | null, outcome: string | null): CaseStatus {
  if (decision === "wants_escalation") return "escalation_drafted";
  if (!decision && (outcome === "rejected")) return "escalation_drafted";
  return "resolved";
}

// ---- Policy notes the advocate can cite ----
// Keep these general and verifiable; check exact wording before the demo.
const POLICIES: { match: RegExp; note: string }[] = [
  {
    match: /indigo|air india|spicejet|akasa|vistara|airline|flight/i,
    note:
      "Under DGCA passenger rules, when the airline cancels a flight the passenger is entitled to a full refund to the original payment mode; a credit shell is only an option if the passenger chooses it.",
  },
  {
    match: /airtel|jio|vodafone|\bvi\b|bsnl|telecom|broadband/i,
    note:
      "Under TRAI consumer rules, wrongly charged amounts must be corrected and refunded, and the customer can escalate to the appellate authority if the complaint isn't resolved.",
  },
  {
    match: /hdfc|icici|sbi|axis|kotak|bank|card|upi/i,
    note:
      "Under RBI rules, failed or wrongly debited transactions must be reversed within the prescribed time, and the bank must compensate for delays; unresolved complaints can go to the RBI Ombudsman.",
  },
  {
    match: /flipkart|amazon|myntra|meesho|zepto|blinkit|swiggy|zomato|order/i,
    note:
      "Under the Consumer Protection (E-Commerce) Rules, 2020, platforms must process refund requests within a reasonable time, and the customer can file with the National Consumer Helpline.",
  },
];

export function policyFor(company: string | null | undefined, issue?: string | null): string {
  const text = `${company ?? ""} ${issue ?? ""}`;
  return (
    POLICIES.find((p) => p.match.test(text))?.note ??
    "The customer is entitled to have a valid complaint resolved, and can escalate to the National Consumer Helpline if it isn't."
  );
}

// ---- Escalation draft (National Consumer Helpline) ----
export interface CaseLike {
  customer_name?: string | null;
  company?: string | null;
  issue_summary?: string | null;
  reference_number?: string | null;
  amount_inr?: number | null;
  desired_outcome?: string | null;
  incident_date?: string | null;
  outcome?: string | null;
  ticket_number?: string | null;
  resolution_timeline?: string | null;
  amount_agreed?: number | null;
  next_step?: string | null;
}

export function escalationDraft(c: CaseLike, callDate = new Date()): string {
  const d = callDate.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  const amt = c.amount_inr != null ? `₹${c.amount_inr.toLocaleString("en-IN")}` : "the amount due";
  return [
    `Complaint against: ${c.company ?? "[company]"}`,
    `Complainant: ${c.customer_name ?? "[name]"}`,
    ``,
    `Issue: ${c.issue_summary ?? "[issue]"}${c.incident_date ? ` (date of issue: ${c.incident_date})` : ""}.`,
    `Booking / reference number: ${c.reference_number ?? "[reference]"}. Amount involved: ${amt}.`,
    ``,
    `On ${d}, the company's customer care was contacted on my behalf. ` +
      `Result: ${c.outcome ?? "not resolved"}` +
      `${c.ticket_number ? `, ticket number ${c.ticket_number}` : ""}` +
      `${c.resolution_timeline ? `, stated timeline ${c.resolution_timeline}` : ""}.`,
    ``,
    `Relief sought: ${c.desired_outcome ?? "full refund"} of ${amt} to the original payment mode.`,
    ``,
    `Call recording and transcript are available as evidence.`,
  ].join("\n");
}

/** Variables passed to the Advocate agent ({{...}} in its prompt). */
export function advocateVariables(c: CaseLike & { policy_note?: string | null; id: string }) {
  return {
    case_id: c.id,
    customer_name: c.customer_name ?? "the customer",
    company: c.company ?? "the company",
    issue_summary: c.issue_summary ?? "",
    reference_number: c.reference_number ?? "not provided",
    amount_inr: c.amount_inr != null ? String(c.amount_inr) : "not provided",
    desired_outcome: c.desired_outcome ?? "full refund",
    incident_date: c.incident_date ?? "not provided",
    policy_note: c.policy_note ?? policyFor(c.company, c.issue_summary),
  };
}

/** Variables passed to the Callback agent. */
export function callbackVariables(c: CaseLike & { id: string }) {
  return {
    ...advocateVariables({ ...c, policy_note: "" }),
    outcome: c.outcome ?? "pending",
    ticket_number: c.ticket_number ?? "not given",
    resolution_timeline: c.resolution_timeline ?? "not given",
    amount_agreed: c.amount_agreed != null ? String(c.amount_agreed) : "not given",
    next_step: c.next_step ?? "none",
  };
}
