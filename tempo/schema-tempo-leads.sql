-- tempo_leads: a SEPARATE lead store for the Tempo (clinic scheduling) campaign.
-- Kept apart from `leads` (Aevon) on purpose so the two campaigns never mix and you
-- can switch back to Aevon at any time by simply not running the tempo/ scripts.
-- Mirrors the columns the Aevon pipeline uses.
create table if not exists tempo_leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  business_name text not null,
  address text,
  phone text,
  website text,
  email text,
  email_quality text,                 -- personal | role | generic
  contact_name text,
  contact_role text,
  industry text,                      -- the clinic search term that found them
  city text,
  source text,
  status text default 'queued',       -- queued | sent | replied | bounced | unsubscribed | converted | dont_contact
  sequence_step int default 0,        -- 0 = initial, 1/2 = follow-ups
  scheduled_send_at timestamptz,
  last_sent_at timestamptz,
  qualification_score int,            -- 0-10
  qualification_notes text,
  lead_insights text,
  personalization_basis text,
  email_subject text,
  email_body text,
  followup_subject text,
  followup_body text,
  followup2_subject text,
  followup2_body text,
  resend_email_id text,
  opened_at timestamptz,
  clicked_at timestamptz,
  notes text
);

create index if not exists tempo_leads_status_idx on tempo_leads (status);
create index if not exists tempo_leads_score_idx on tempo_leads (qualification_score desc);
create unique index if not exists tempo_leads_website_uidx on tempo_leads (lower(website)) where website is not null;
