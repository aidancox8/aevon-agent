-- cadre_leads: a THIRD, separate lead store, for the HR/credentials offer.
--
-- Kept apart from `leads` (Aevon) and `tempo_leads` (clinic scheduling) for the same reason
-- those two are separate: the campaigns never mix, and stopping one is just not running its
-- scripts.
--
-- The important difference from the other two is not the columns, it is how a row gets here.
-- `leads` and `tempo_leads` were both filled by scraping Google Places for a business type,
-- then guessing the pain. Between them that produced 3,808 sends and zero meetings.
--
-- A row in THIS table requires a signal: something the company itself published showing it has
-- the credential-tracking problem. A job ad for a credentialing or compliance coordinator, a
-- posting that asks someone to "maintain the certification spreadsheet", a review complaining
-- their HR tool cannot track licence expiry. `signal_quote` holds their own words and
-- `signal_url` says where it came from. No signal, no row.
create table if not exists cadre_leads (
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
  industry text,                      -- regulated vertical: health, trades, transport, childcare, security, food
  city text,
  source text,                        -- jobbank | review | marketplace | referral
  staff_estimate int,                 -- rough headcount; drives the pricing band

  -- The signal. This is what makes the row worth having.
  signal_type text,                   -- hiring_credentialing | hiring_compliance | manual_tracking | tool_gap
  signal_quote text,                  -- their own words, verbatim
  signal_url text,
  signal_date date,

  status text default 'queued',       -- queued | sent | replied | bounced | unsubscribed | converted | dont_contact
  sequence_step int default 0,
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
  notes text,
  email_hunt_attempted_at timestamptz
);

-- A signal is mandatory. This is a CHECK rather than a convention because the convention is
-- exactly what eroded on the other two campaigns: rows arrived with no evidence of pain and
-- nobody noticed until thousands of emails had gone out.
alter table cadre_leads drop constraint if exists cadre_leads_requires_signal;
alter table cadre_leads add constraint cadre_leads_requires_signal
  check (signal_quote is not null and length(btrim(signal_quote)) > 20 and signal_url is not null);

create unique index if not exists cadre_leads_business_uniq
  on cadre_leads (lower(btrim(business_name)));
create index if not exists cadre_leads_status_idx on cadre_leads (status, sequence_step);

-- Hand-written copy must not be silently replaced by generated copy.
--
-- On 2026-08-25 a background regeneration run overwrote every hand-written Cadre body. The
-- personalizer already filtered on `email_subject is null`, which should have prevented it and
-- did not, and the loss was recoverable only because a scratch file happened to survive. An
-- empty field is a weak way to express "leave this alone"; a column says it outright.
--
-- Set by cadre/copy-handwritten.js. Honoured by cadre/personalizer.js and cadre/load-drafts.js.
-- Asserted against the live database by check-copy-lock.js, which attempts a real write.
alter table cadre_leads add column if not exists copy_locked boolean not null default false;
comment on column cadre_leads.copy_locked is
  'Hand-written copy. The personalizer must skip this row. Set by cadre/copy-handwritten.js.';
