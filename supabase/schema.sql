-- Haq database schema. Run once in Supabase → SQL Editor.

create extension if not exists "pgcrypto";

-- One row per complaint the user brings to Haq
create table if not exists cases (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Who
  customer_name       text,
  customer_phone      text,           -- E.164, e.g. +919876543210

  -- What (from the Intake call)
  company             text,
  company_phone       text,           -- helpline Haq should call (E.164)
  issue_summary       text,
  reference_number    text,
  amount_inr          numeric,
  desired_outcome     text,
  incident_date       text,
  policy_note         text,

  -- Result (from the Advocate call)
  outcome             text,           -- approved | rejected | pending | escalated | needs_customer_verification
  ticket_number       text,
  resolution_timeline text,
  amount_agreed       numeric,
  next_step           text,

  -- User's decision (from the Callback call)
  customer_decision   text,           -- satisfied | wants_escalation | accepts_offer | wants_follow_up | no_response

  -- Escalation
  escalation_draft    text,

  status              text not null default 'intake_done'
  -- intake_done → calling_company → company_responded → calling_customer
  --   → resolved | escalation_drafted | needs_attention
);

-- One row per phone call Bolna makes or receives for a case
create table if not exists calls (
  id                    uuid primary key default gen_random_uuid(),
  created_at            timestamptz not null default now(),
  case_id               uuid references cases(id) on delete cascade,
  kind                  text not null,  -- intake | advocate | callback
  execution_id          text unique,    -- Bolna execution id
  status                text,           -- Bolna lifecycle status
  termination_reason    text,
  conversation_duration numeric,
  transcript            text,
  summary               text,
  recording_url         text,
  extracted             jsonb,          -- flattened extractions
  processed_at          timestamptz     -- set once we've acted on the final payload
);

-- Human-readable timeline for the dashboard
create table if not exists case_events (
  id         bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  case_id    uuid references cases(id) on delete cascade,
  type       text not null,
  message    text not null
);

create index if not exists calls_case_idx on calls(case_id);
create index if not exists events_case_idx on case_events(case_id, created_at);

-- Keep updated_at fresh
create or replace function touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end; $$ language plpgsql;

drop trigger if exists cases_touch on cases;
create trigger cases_touch before update on cases
for each row execute function touch_updated_at();

-- Live updates for the dashboard
alter publication supabase_realtime add table cases;
alter publication supabase_realtime add table case_events;

-- Lock tables to the server (service role bypasses RLS)
alter table cases enable row level security;
alter table calls enable row level security;
alter table case_events enable row level security;
