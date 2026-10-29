# Haq: backend

Haq is a voice AI agent that calls Indian customer care for you to get your refund.
This is the backend that chains the Bolna agents together:

```
User calls Haq ──► INTAKE agent ──webhook──► create case ──► POST /call ADVOCATE (to the company)
                                                                   │
           CALLBACK agent (to the user) ◄── POST /call ◄── save outcome ◄──webhook
                    │
                 webhook ──► resolved, or draft a National Consumer Helpline complaint
```

## Setup (about 15 minutes)

### 1. Supabase
1. Create a free project at supabase.com.
2. Open **SQL Editor**, paste `supabase/schema.sql`, and click **Run**.
3. Under **Project Settings → API**, copy the **Project URL** and the **service_role** key.

### 2. Environment
```bash
cp .env.example .env.local
```
Fill in:
- `BOLNA_API_KEY`: from Bolna **Developers**
- the 4 agent IDs
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
- `DEMO_COMPANY_NUMBER`: the number the advocate should call during the demo. On the trial plan, this must be a **verified** number (for example your own or a teammate's phone).
- `WEBHOOK_SECRET`: any random string

### 3. Run locally
```bash
npm install
npm test        # 16 tests: extraction parsing + the full call chain
npm run dev
```

### 4. Deploy (Bolna needs a public URL for webhooks)
1. Push to GitHub and import the repo into Vercel.
2. Add the same environment variables in Vercel → Settings → Environment Variables, then deploy.

### 5. Connect Bolna
In **each** of the Intake, Advocate and Callback agents, set the webhook URL (Analytics/Extractions tab) to:
```
https://<your-app>.vercel.app/api/webhooks/bolna?secret=<WEBHOOK_SECRET>
```

**Extraction names must match exactly**, because the backend reads these keys:

| Agent | Extraction keys |
|---|---|
| Intake | `customer_name`, `company`, `issue_summary`, `reference_number`, `amount_inr`, `desired_outcome`, `incident_date` |
| Advocate | `outcome`, `ticket_number`, `resolution_timeline`, `amount_agreed`, `next_step` |
| Callback | `customer_decision` |

The Advocate and Callback prompts use `{{variables}}`; the backend fills all of them, plus `{{case_id}}`.

## API

| Method | Path | What it does |
|---|---|---|
| POST | `/api/webhooks/bolna?secret=…` | Bolna posts every call update here |
| GET | `/api/cases` | List cases (for the dashboard) |
| POST | `/api/cases` | Create a case from a web form: `{ customer_name, customer_phone, company, issue_summary, reference_number, amount_inr, desired_outcome, incident_date }` |
| GET | `/api/cases/:id` | Case + calls (transcripts, recordings) + timeline |
| POST | `/api/cases/:id/advocate` | Call customer care now (`{ company_phone? }`) |
| POST | `/api/cases/:id/callback` | Call the customer back now |
| POST | `/api/cases/:id/escalate` | Draft the National Consumer Helpline complaint |

## Case statuses
`intake_done` → `calling_company` → `company_responded` → `calling_customer` → `resolved` | `escalation_drafted` | `needs_attention`

## Notes
- Duplicate webhook deliveries are safe: each call is processed exactly once.
- A call only counts as a conversation if the other side actually spoke (Bolna marks rejected calls as `completed` too).
- `AUTO_CHAIN=false` lets you trigger each step by hand from the dashboard. This is useful for a controlled demo.
- Policy notes in `lib/core.ts` are general summaries; check the wording before quoting them in the pitch.
- Every call uses Bolna credits.
