"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ---------- Types (mirror supabase/schema.sql) ----------
type Case = {
  id: string;
  created_at: string;
  customer_name: string | null;
  customer_phone: string | null;
  company: string | null;
  company_phone: string | null;
  issue_summary: string | null;
  reference_number: string | null;
  amount_inr: number | null;
  desired_outcome: string | null;
  incident_date: string | null;
  outcome: string | null;
  ticket_number: string | null;
  resolution_timeline: string | null;
  amount_agreed: number | null;
  next_step: string | null;
  customer_decision: string | null;
  escalation_draft: string | null;
  status: string;
};
type Call = {
  id: string;
  created_at: string;
  kind: "intake" | "advocate" | "callback";
  status: string | null;
  conversation_duration: number | null;
  transcript: string | null;
  summary: string | null;
  recording_url: string | null;
  extracted: Record<string, string> | null;
};
type Event = { id: number; created_at: string; type: string; message: string };
type Detail = { case: Case; calls: Call[]; events: Event[] };

const KEY_STORE = "haq.key";
const POLL_MS = 3000;
const LIVE = new Set(["calling_company", "calling_customer"]);

// ---------- Helpers ----------
const rupees = (n: number | null | undefined) =>
  n == null ? "—" : `₹${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

const secs = (s: number | null) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");

function statusLabel(c: Case): { text: string; tone: "" | "live" | "won" | "bad" } {
  const co = c.company ?? "the company";
  switch (c.status) {
    case "intake_done": return { text: "Complaint taken", tone: "" };
    case "calling_company": return { text: `Calling ${co}`, tone: "live" };
    case "company_responded": return { text: `${co} responded`, tone: "" };
    case "calling_customer": return { text: "Calling you back", tone: "live" };
    case "resolved": return { text: c.outcome === "rejected" ? "Closed" : "Resolved", tone: c.outcome === "rejected" ? "" : "won" };
    case "escalation_drafted": return { text: "Ready to escalate", tone: "bad" };
    case "needs_attention": return { text: "Needs attention", tone: "bad" };
    default: return { text: c.status, tone: "" };
  }
}

const OUTCOME_COPY: Record<string, { title: (co: string) => string; tone: "" | "won" | "bad" }> = {
  approved: { title: (co) => `${co} agreed to pay`, tone: "won" },
  escalated: { title: (co) => `${co} escalated your refund`, tone: "won" },
  pending: { title: (co) => `${co} says it's in process`, tone: "" },
  rejected: { title: (co) => `${co} refused`, tone: "bad" },
  needs_customer_verification: { title: (co) => `${co} needs you to verify`, tone: "" },
};

function isTest(c: Case) {
  return (c.customer_name ?? "").toUpperCase().includes("SMOKE TEST");
}

// ---------- API ----------
function useApi(key: string | null, onUnauthorised: () => void) {
  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const res = await fetch(path, {
        ...init,
        headers: { "Content-Type": "application/json", "x-haq-key": key ?? "", ...(init?.headers ?? {}) },
        cache: "no-store",
      });
      if (res.status === 401) {
        onUnauthorised();
        throw new Error("That key didn't work. Use the WEBHOOK_SECRET from Vercel.");
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
      return body as T;
    },
    [key, onUnauthorised],
  );
}

// ---------- Page ----------
export default function Dashboard() {
  const [key, setKey] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [gateError, setGateError] = useState("");

  useEffect(() => {
    try { setKey(localStorage.getItem(KEY_STORE)); } catch { /* storage blocked */ }
    setReady(true);
  }, []);

  const signOut = useCallback(() => {
    try { localStorage.removeItem(KEY_STORE); } catch { /* ignore */ }
    setKey(null);
  }, []);

  if (!ready) return null;
  if (!key) {
    return (
      <Gate
        error={gateError}
        onSubmit={(k) => {
          setGateError("");
          try { localStorage.setItem(KEY_STORE, k); } catch { /* ignore */ }
          setKey(k);
        }}
      />
    );
  }
  return (
    <Cases
      apiKey={key}
      onUnauthorised={() => { setGateError("That key didn't work. Use the WEBHOOK_SECRET from Vercel."); signOut(); }}
      onSignOut={signOut}
    />
  );
}

function Gate({ onSubmit, error }: { onSubmit: (k: string) => void; error: string }) {
  const [v, setV] = useState("");
  return (
    <main className="gate">
      <form onSubmit={(e) => { e.preventDefault(); if (v.trim()) onSubmit(v.trim()); }}>
        <span className="wordmark">Haq</span>
        <p>Your AI that calls customer care for you and fights for your refund.</p>
        <label className="field">
          <span>Access key</span>
          <input type="password" value={v} onChange={(e) => setV(e.target.value)} autoFocus autoComplete="current-password" />
        </label>
        {error && <p className="err" role="alert">{error}</p>}
        <button className="btn" type="submit">Open dashboard</button>
      </form>
    </main>
  );
}

function Cases({ apiKey, onUnauthorised, onSignOut }: { apiKey: string; onUnauthorised: () => void; onSignOut: () => void }) {
  const api = useApi(apiKey, onUnauthorised);
  const [cases, setCases] = useState<Case[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [showTests, setShowTests] = useState(false);
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const say = (text: string, bad = false) => {
    setToast({ text, bad });
    setTimeout(() => setToast(null), 3500);
  };

  const loadCases = useCallback(async () => {
    try {
      setCases(await api<Case[]>("/api/cases"));
    } catch (e) {
      say((e as Error).message, true);
    }
  }, [api]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      setDetail(await api<Detail>(`/api/cases/${id}`));
    } catch (e) {
      say((e as Error).message, true);
    }
  }, [api]);

  // Poll: the list and the open case refresh every few seconds, so calls show up live
  useEffect(() => {
    loadCases();
    const t = setInterval(loadCases, POLL_MS);
    return () => clearInterval(t);
  }, [loadCases]);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    loadDetail(selected);
    const t = setInterval(() => loadDetail(selected), POLL_MS);
    return () => clearInterval(t);
  }, [selected, loadDetail]);

  const visible = useMemo(() => (cases ?? []).filter((c) => showTests || !isTest(c)), [cases, showTests]);

  // Open the newest case by default on wide screens
  useEffect(() => {
    if (!selected && visible.length && typeof window !== "undefined" && window.innerWidth > 860) {
      setSelected(visible[0].id);
    }
  }, [visible, selected]);

  async function act(action: "advocate" | "callback" | "escalate", label: string, done: string) {
    if (!detail) return;
    setBusy(action);
    try {
      await api(`/api/cases/${detail.case.id}/${action}`, { method: "POST", body: "{}" });
      say(done);
      await loadDetail(detail.case.id);
      await loadCases();
    } catch (e) {
      say(`${label} failed: ${(e as Error).message}`, true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <header className="bar">
        <div className="wordmark">Haq<small>Cases</small></div>
        <div className="bar-actions">
          <button className="btn" onClick={() => dialogRef.current?.showModal()}>New case</button>
          <button className="btn ghost" onClick={onSignOut}>Lock</button>
        </div>
      </header>

      <div className={`layout${selected ? " has-selection" : ""}`}>
        <nav className="list" aria-label="Cases">
          <div className="list-head">
            <h2>{visible.length} {visible.length === 1 ? "case" : "cases"}</h2>
            <label className="toggle">
              <input type="checkbox" checked={showTests} onChange={(e) => setShowTests(e.target.checked)} />
              Show test cases
            </label>
          </div>
          {cases === null && <p style={{ padding: "0 20px", color: "var(--muted)" }}>Loading cases…</p>}
          {visible.map((c) => {
            const s = statusLabel(c);
            return (
              <button key={c.id} className="docket" aria-current={c.id === selected} onClick={() => setSelected(c.id)}>
                <div className="docket-top">
                  <span className="docket-co">{c.company ?? "Unknown company"}</span>
                  <span className="docket-amt num">{rupees(c.amount_inr)}</span>
                </div>
                <div className="docket-issue">{c.customer_name ? `${c.customer_name}: ` : ""}{c.issue_summary ?? "No details yet"}</div>
                <span className={`status ${s.tone}`}>{s.text}</span>
              </button>
            );
          })}
        </nav>

        <main>
          {!detail && cases !== null && visible.length === 0 && (
            <section className="empty">
              <h1>No complaints yet.</h1>
              <p>
                Call the Haq number and tell it what went wrong, or add a case here. Haq calls the company, argues
                for you and calls you back with the result. Each case appears here as the calls happen.
              </p>
              <button className="btn" onClick={() => dialogRef.current?.showModal()}>New case</button>
            </section>
          )}
          {detail && (
            <CaseView
              d={detail}
              busy={busy}
              onBack={() => setSelected(null)}
              onAdvocate={() => act("advocate", "Calling customer care", `Calling ${detail.case.company ?? "the company"}…`)}
              onCallback={() => act("callback", "Calling the customer", "Calling the customer back…")}
              onEscalate={() => act("escalate", "Drafting the complaint", "Complaint drafted")}
              onCopied={() => say("Complaint copied")}
            />
          )}
        </main>
      </div>

      <NewCase
        dialogRef={dialogRef}
        onCreate={async (body) => {
          try {
            const c = await api<Case>("/api/cases", { method: "POST", body: JSON.stringify(body) });
            dialogRef.current?.close();
            say(body.start_now ? `Case created. Calling ${c.company}…` : "Case created");
            await loadCases();
            setSelected(c.id);
          } catch (e) {
            say((e as Error).message, true);
          }
        }}
      />

      {toast && <div className={`toast${toast.bad ? " bad" : ""}`} role="status">{toast.text}</div>}
    </>
  );
}

// ---------- Case view ----------
function CaseView(props: {
  d: Detail;
  busy: string | null;
  onBack: () => void;
  onAdvocate: () => void;
  onCallback: () => void;
  onEscalate: () => void;
  onCopied: () => void;
}) {
  const { case: c, calls, events } = props.d;
  const co = c.company ?? "The company";
  const s = statusLabel(c);
  const latest = (k: Call["kind"]) => [...calls].reverse().find((x) => x.kind === k);

  // Three calls, in order
  const order = ["intake_done", "calling_company", "company_responded", "calling_customer", "resolved", "escalation_drafted"];
  const at = order.indexOf(c.status);
  const advocateFailed = c.status === "needs_attention" && !c.outcome;
  const callbackFailed = c.status === "needs_attention" && !!c.outcome;
  const stations = [
    { n: 1, title: "You told Haq", note: c.customer_name ? `${c.customer_name} explained the problem` : "Complaint taken", state: "done" },
    {
      n: 2,
      title: `Haq called ${c.company ?? "the company"}`,
      note: c.status === "calling_company" ? "On the call now" : c.outcome ? (OUTCOME_COPY[c.outcome]?.title(co) ?? c.outcome) : advocateFailed ? "No one picked up" : "Waiting",
      state: advocateFailed ? "failed" : c.status === "calling_company" ? "live" : at >= 2 || c.outcome ? "done" : "",
    },
    {
      n: 3,
      title: "Haq called you back",
      note: c.status === "calling_customer" ? "On the call now" : callbackFailed ? "Couldn't reach you" : at >= 4 ? "You heard the result" : "Waiting",
      state: callbackFailed ? "failed" : c.status === "calling_customer" ? "live" : at >= 4 ? "done" : "",
    },
  ];
  const doneCount = stations.filter((x) => x.state === "done").length;
  const progress = Math.max(0, Math.min(2, doneCount - 1 + (stations.some((x) => x.state === "live") ? 0.5 : 0)));

  const oc = c.outcome ? OUTCOME_COPY[c.outcome] : null;
  const canCallCompany = !LIVE.has(c.status);
  const canCallBack = !LIVE.has(c.status) && !!c.outcome && !!c.customer_phone;
  const showEscalate = c.status !== "escalation_drafted" && (c.outcome === "rejected" || c.status === "needs_attention" || c.customer_decision === "wants_escalation");

  return (
    <article className="detail">
      <button className="btn ghost back" onClick={props.onBack}>All cases</button>

      <div className="claim">
        <h1>
          <span className="num">{rupees(c.amount_inr)}</span> from {c.company ?? "the company"}
          <span className="owed">{c.issue_summary ?? "Details pending"}</span>
        </h1>
        <span className={`status ${s.tone}`}>{s.text}</span>
      </div>

      <dl className="facts">
        <div className="fact"><dt>Customer</dt><dd>{c.customer_name ?? "—"}</dd></div>
        <div className="fact"><dt>Booking / reference</dt><dd className="num">{c.reference_number ?? "—"}</dd></div>
        <div className="fact"><dt>Wants</dt><dd>{c.desired_outcome ?? "—"}</dd></div>
        <div className="fact"><dt>Date of issue</dt><dd>{c.incident_date ?? "—"}</dd></div>
      </dl>

      <ol className="chain" aria-label="Calls in this case" style={{ "--p": `${(progress / 2) * 66.68}%` } as React.CSSProperties}>
        {stations.map((st) => (
          <li key={st.n} className={`station ${st.state}`}>
            <div className="dot" aria-hidden>{st.state === "done" ? "✓" : st.state === "failed" ? "!" : st.n}</div>
            <h3>{st.title}</h3>
            <p>{st.note}</p>
          </li>
        ))}
      </ol>

      {oc && (
        <section className="slip" aria-label="Result">
          <div>
            <h2>{oc.title(co)}</h2>
            <p>
              {c.resolution_timeline ? `Expected within ${c.resolution_timeline}. ` : ""}
              {c.amount_agreed != null ? `Amount agreed: ${rupees(c.amount_agreed)}. ` : ""}
              {c.next_step ?? ""}
            </p>
          </div>
          {c.ticket_number && (
            <div className={`stamp ${oc.tone}`}>
              <span>Ticket number</span>
              <strong className="num">{c.ticket_number}</strong>
            </div>
          )}
        </section>
      )}

      <div className="actions">
        {canCallCompany && (
          <button className="btn" onClick={props.onAdvocate} disabled={!!props.busy}>
            {props.busy === "advocate" ? "Calling…" : c.outcome ? `Call ${c.company ?? "the company"} again` : `Call ${c.company ?? "the company"} now`}
          </button>
        )}
        {canCallBack && (
          <button className="btn ghost" onClick={props.onCallback} disabled={!!props.busy}>
            {props.busy === "callback" ? "Calling…" : "Call customer with result"}
          </button>
        )}
        <a className="btn ghost" href={`/track/${c.id}`} target="_blank" rel="noreferrer">Customer's tracking page</a>
        {showEscalate && (
          <button className="btn ghost" onClick={props.onEscalate} disabled={!!props.busy}>
            {props.busy === "escalate" ? "Drafting…" : "Draft consumer helpline complaint"}
          </button>
        )}
      </div>

      {c.escalation_draft && (
        <section className="section">
          <h2>Complaint for the National Consumer Helpline</h2>
          <pre className="draft">{c.escalation_draft}</pre>
          <div className="actions">
            <button
              className="btn"
              onClick={() => navigator.clipboard?.writeText(c.escalation_draft ?? "").then(props.onCopied)}
            >
              Copy complaint
            </button>
            <a className="btn ghost" href="https://consumerhelpline.gov.in/" target="_blank" rel="noreferrer">
              Open consumer helpline
            </a>
          </div>
        </section>
      )}

      {calls.length > 0 && (
        <section className="section">
          <h2>Calls</h2>
          {(["advocate", "callback", "intake"] as const).map((k) => {
            const call = latest(k);
            return call ? <CallCard key={call.id} call={call} company={c.company ?? "Customer care"} customer={c.customer_name ?? "Customer"} open={k === "advocate"} /> : null;
          })}
        </section>
      )}

      {events.length > 0 && (
        <section className="section">
          <h2>What happened</h2>
          <ol className="timeline">
            {events.map((e) => (
              <li key={e.id} className={e.type === "error" ? "error" : ""}>
                <time dateTime={e.created_at}>{when(e.created_at)}</time>
                {e.message}
              </li>
            ))}
          </ol>
        </section>
      )}
    </article>
  );
}

const CALL_TITLES: Record<Call["kind"], (co: string) => string> = {
  intake: () => "Your call with Haq",
  advocate: (co) => `Haq's call with ${co}`,
  callback: () => "Haq's call back to you",
};

const HIDDEN_FIELDS = new Set(["customer_questions"]);

function CallCard({ call, company, customer, open }: { call: Call; company: string; customer: string; open: boolean }) {
  // In Bolna's transcript "assistant" is always Haq; "user" is whoever answered
  const other = call.kind === "advocate" ? company : customer;
  const lines = (call.transcript ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^(assistant|user)\s*:\s*(.*)$/i);
      return m ? { who: m[1].toLowerCase(), text: m[2] } : { who: "user", text: l };
    });
  const extracted = Object.entries(call.extracted ?? {}).filter(([k, v]) => v && !HIDDEN_FIELDS.has(k));
  const live = call.status && !["completed", "no-answer", "busy", "failed", "canceled", "stopped", "error", "balance-low"].includes(call.status);

  return (
    <details className="call" open={open}>
      <summary>
        <h3>{CALL_TITLES[call.kind](company)}</h3>
        <span className="meta num">
          {live ? <span className="status live">In progress</span> : <>{when(call.created_at)}{call.conversation_duration ? ` · ${secs(call.conversation_duration)}` : ""}</>}
        </span>
      </summary>
      <div className="call-body">
        {call.summary && <p className="call-summary">{call.summary}</p>}
        {call.recording_url && <audio controls preload="none" src={call.recording_url} />}
        {extracted.length > 0 && (
          <div className="extracted">
            {extracted.map(([k, v]) => (
              <div key={k}><span>{k.replace(/_/g, " ")}</span>{v}</div>
            ))}
          </div>
        )}
        {lines.length > 0 ? (
          <div className="transcript">
            {lines.map((l, i) => (
              <p key={i} className={`line ${l.who === "assistant" ? "haq" : "them"}`}>
                <b>{l.who === "assistant" ? "Haq" : other}</b>
                {l.text}
              </p>
            ))}
          </div>
        ) : (
          <p style={{ color: "var(--muted)" }}>{live ? "The transcript appears when the call ends." : "No transcript for this call."}</p>
        )}
      </div>
    </details>
  );
}

// ---------- New case form ----------
type NewCaseBody = {
  customer_name: string;
  customer_phone: string;
  company: string;
  company_phone?: string;
  issue_summary: string;
  reference_number: string;
  amount_inr: string;
  desired_outcome: string;
  incident_date: string;
  start_now: boolean;
};

function NewCase({ dialogRef, onCreate }: { dialogRef: React.RefObject<HTMLDialogElement | null>; onCreate: (b: NewCaseBody) => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  return (
    <dialog ref={dialogRef} aria-labelledby="new-case-title">
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const get = (k: string) => String(f.get(k) ?? "").trim();
          setSaving(true);
          await onCreate({
            customer_name: get("customer_name"),
            customer_phone: get("customer_phone"),
            company: get("company"),
            company_phone: get("company_phone") || undefined,
            issue_summary: get("issue_summary"),
            reference_number: get("reference_number"),
            amount_inr: get("amount_inr"),
            desired_outcome: get("desired_outcome"),
            incident_date: get("incident_date"),
            start_now: f.get("start_now") === "on",
          });
          setSaving(false);
        }}
      >
        <h2 id="new-case-title">New case</h2>
        <p>The same details Haq collects on the phone.</p>
        <div className="row">
          <label className="field"><span>Customer name</span><input name="customer_name" required defaultValue="" /></label>
          <label className="field"><span>Customer phone</span><input name="customer_phone" required placeholder="+91…" inputMode="tel" /></label>
        </div>
        <div className="row">
          <label className="field"><span>Company</span><input name="company" required placeholder="IndiGo" /></label>
          <label className="field"><span>Booking / reference</span><input name="reference_number" placeholder="AB12CD" /></label>
        </div>
        <label className="field"><span>What went wrong</span><input name="issue_summary" required placeholder="Flight cancelled by airline, refund not received" /></label>
        <div className="row">
          <label className="field"><span>Amount (₹)</span><input name="amount_inr" inputMode="numeric" placeholder="6400" /></label>
          <label className="field"><span>Date of issue</span><input name="incident_date" placeholder="20 October 2026" /></label>
        </div>
        <div className="row">
          <label className="field">
            <span>Customer wants</span>
            <select name="desired_outcome" defaultValue="full refund">
              <option>full refund</option>
              <option>partial refund</option>
              <option>bill correction</option>
              <option>cancellation</option>
              <option>other</option>
            </select>
          </label>
          <label className="field"><span>Customer care number (optional)</span><input name="company_phone" placeholder="Uses the demo number if empty" inputMode="tel" /></label>
        </div>
        <div className="form-foot">
          <label className="check"><input type="checkbox" name="start_now" defaultChecked /> Call the company straight away</label>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn ghost" onClick={() => dialogRef.current?.close()}>Cancel</button>
            <button type="submit" className="btn" disabled={saving}>{saving ? "Creating…" : "Create case"}</button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
