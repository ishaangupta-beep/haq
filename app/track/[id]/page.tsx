"use client";

import { use, useEffect, useState } from "react";

type TrackCase = {
  id: string;
  created_at: string;
  updated_at: string;
  customer_name: string | null;
  company: string | null;
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
  escalation_draft: string | null;
  status: string;
};
type TrackEvent = { id: number; created_at: string; type: string; message: string };

const rupees = (n: number | null) => (n == null ? "" : `₹${Number(n).toLocaleString("en-IN")}`);
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

function headline(c: TrackCase): { title: string; body: string; tone: "" | "live" | "won" | "bad" } {
  const co = c.company ?? "the company";
  switch (c.status) {
    case "intake_done":
      return { title: "We've got your complaint", body: `Haq will call ${co} for you shortly.`, tone: "" };
    case "calling_company":
      return { title: `Haq is on the phone with ${co}`, body: "Arguing your case right now. This page updates by itself.", tone: "live" };
    case "company_responded":
    case "calling_customer":
    case "resolved":
      if (c.outcome === "approved") return { title: `${co} agreed to pay`, body: "Your refund has been approved.", tone: "won" };
      if (c.outcome === "escalated") return { title: `${co} escalated your refund`, body: "Your case is with their refunds team.", tone: "won" };
      if (c.outcome === "pending") return { title: `${co} says it's in process`, body: "Haq will follow up if it doesn't arrive in time.", tone: "" };
      if (c.outcome === "needs_customer_verification")
        return { title: `${co} needs you to verify`, body: c.next_step ?? "They need to confirm your identity before going ahead.", tone: "" };
      if (c.outcome === "rejected") return { title: `${co} refused`, body: "You can take this to the National Consumer Helpline.", tone: "bad" };
      return { title: "Haq has spoken to the company", body: "Details below.", tone: "" };
    case "escalation_drafted":
      return { title: "Ready to escalate", body: `${co} didn't resolve it. Your complaint for the National Consumer Helpline is ready.`, tone: "bad" };
    case "needs_attention":
      return { title: "We hit a snag", body: `We couldn't get through to ${co} yet. Haq will try again.`, tone: "bad" };
    default:
      return { title: "Your case", body: "", tone: "" };
  }
}

export default function Track({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<{ case: TrackCase; events: TrackEvent[] } | null>(null);
  const [missing, setMissing] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      const res = await fetch(`/api/track/${id}`, { cache: "no-store" }).catch(() => null);
      if (stop || !res) return;
      if (res.status === 404) return setMissing(true);
      if (res.ok) setData(await res.json());
    };
    load();
    const t = setInterval(load, 4000);
    return () => { stop = true; clearInterval(t); };
  }, [id]);

  if (missing) {
    return (
      <main className="track">
        <div className="track-brand">Haq</div>
        <section className="track-card">
          <h1 className="track-title">We couldn't find this case</h1>
          <p className="track-body">Check the link from your message, or call Haq again to start a new complaint.</p>
        </section>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="track">
        <div className="track-brand">Haq</div>
        <p className="track-body">Loading your case…</p>
      </main>
    );
  }

  const c = data.case;
  const h = headline(c);
  const steps = [
    { label: "Complaint taken", done: true, live: false },
    { label: `Call with ${c.company ?? "company"}`, done: !!c.outcome, live: c.status === "calling_company" },
    { label: "Result shared", done: ["resolved", "escalation_drafted"].includes(c.status), live: c.status === "calling_customer" },
  ];

  return (
    <main className="track">
      <div className="track-brand">Haq</div>
      <p className="track-hello">{c.customer_name ? `Hi ${c.customer_name}, here's your case.` : "Here's your case."}</p>

      <section className={`track-card ${h.tone}`} aria-live="polite">
        <span className={`status ${h.tone}`}>{steps.find((s) => s.live) ? "Live" : h.tone === "won" ? "Good news" : h.tone === "bad" ? "Action needed" : "Update"}</span>
        <h1 className="track-title">{h.title}</h1>
        <p className="track-body">{h.body}</p>

        {c.ticket_number && (
          <div className={`stamp ${h.tone === "won" ? "won" : h.tone === "bad" ? "bad" : ""}`} style={{ marginTop: 16, display: "inline-block" }}>
            <span>Ticket number</span>
            <strong className="num">{c.ticket_number}</strong>
          </div>
        )}
        {(c.resolution_timeline || c.amount_agreed != null) && (
          <p className="track-body" style={{ marginTop: 16 }}>
            {c.resolution_timeline ? `Expected within ${c.resolution_timeline}. ` : ""}
            {c.amount_agreed != null ? `Amount agreed: ${rupees(c.amount_agreed)}.` : ""}
          </p>
        )}
      </section>

      <ol className="track-steps" aria-label="Progress">
        {steps.map((s, i) => (
          <li key={s.label} className={s.done ? "done" : s.live ? "live" : ""}>
            <span className="track-dot" aria-hidden>{s.done ? "✓" : i + 1}</span>
            {s.label}
            {s.live && <em> · happening now</em>}
          </li>
        ))}
      </ol>

      <dl className="track-facts">
        <div><dt>Company</dt><dd>{c.company ?? "—"}</dd></div>
        <div><dt>Amount</dt><dd className="num">{rupees(c.amount_inr) || "—"}</dd></div>
        <div><dt>Booking / reference</dt><dd className="num">{c.reference_number ?? "—"}</dd></div>
        <div><dt>You asked for</dt><dd>{c.desired_outcome ?? "—"}</dd></div>
        <div className="wide"><dt>Issue</dt><dd>{c.issue_summary ?? "—"}</dd></div>
      </dl>

      {c.escalation_draft && (
        <section className="track-section">
          <h2>Your complaint for the National Consumer Helpline</h2>
          <p className="track-body">Copy it and file it on the government's consumer helpline. It's free.</p>
          <pre className="draft">{c.escalation_draft}</pre>
          <div className="actions">
            <button
              className="btn"
              onClick={() => navigator.clipboard?.writeText(c.escalation_draft ?? "").then(() => { setCopied(true); setTimeout(() => setCopied(false), 2500); })}
            >
              {copied ? "Copied" : "Copy complaint"}
            </button>
            <a className="btn ghost" href="https://consumerhelpline.gov.in/" target="_blank" rel="noreferrer">Open consumer helpline</a>
          </div>
        </section>
      )}

      {data.events.length > 0 && (
        <section className="track-section">
          <h2>What happened</h2>
          <ol className="timeline">
            {data.events.map((e) => (
              <li key={e.id}>
                <time dateTime={e.created_at}>{when(e.created_at)}</time>
                {e.message}
              </li>
            ))}
          </ol>
        </section>
      )}

      <p className="track-foot">Haq is an AI assistant that calls customer care for you. It never asks for OTPs, passwords or card numbers.</p>
    </main>
  );
}
