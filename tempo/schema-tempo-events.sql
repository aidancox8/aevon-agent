-- tempo_email_events: send/bounce/reply log for the Tempo campaign.
-- Separate from Aevon's email_events so the two campaigns' daily caps and
-- stats never mix (same reasoning as tempo_leads vs leads).
create table if not exists tempo_email_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  lead_id uuid references tempo_leads(id) on delete cascade,
  resend_email_id text,
  event_type text not null,       -- sent | opened | clicked | bounced | replied | error
  metadata jsonb
);

create index if not exists tempo_email_events_lead_idx on tempo_email_events (lead_id);
create index if not exists tempo_email_events_type_time_idx on tempo_email_events (event_type, created_at);
