-- pulse_email_events: the third event store, mirroring email_events (Aevon) and
-- tempo_email_events (Tempo) so daily-review.js can report all three side by side.
--
-- Kept separate for the same reason the lead tables are: one campaign's numbers never
-- contaminate another's, and switching a campaign off is just not running its scripts.
create table if not exists pulse_email_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  lead_id uuid,
  event_type text not null,   -- sent | delivered | bounced | replied | clicked | error | held
  metadata jsonb
);

create index if not exists pulse_events_type_idx on pulse_email_events (event_type, created_at desc);
create index if not exists pulse_events_lead_idx on pulse_email_events (lead_id);

-- Scheduling columns on the lead table. The other two campaigns pace off scheduled_send_at,
-- which pulse_leads already has, but it needs to be populated for anything to go out.
alter table pulse_leads add column if not exists send_batch int;
