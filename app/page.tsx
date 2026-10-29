// Placeholder — the dashboard UI is built in the frontend step.
export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui", padding: 32 }}>
      <h1>Haq backend is running</h1>
      <p>
        API: <code>GET /api/cases</code>, <code>POST /api/cases</code>, <code>GET /api/cases/:id</code>,{" "}
        <code>POST /api/cases/:id/advocate|callback|escalate</code>, <code>POST /api/webhooks/bolna</code>
      </p>
    </main>
  );
}
