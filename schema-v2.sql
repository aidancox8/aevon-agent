-- Run this in Supabase SQL Editor (adds to existing schema)

-- Track Resend email IDs and open/click analytics on leads table
alter table leads
  add column if not exists resend_email_id text,
  add column if not exists resend_followup_id text,
  add column if not exists opened_at timestamptz,
  add column if not exists clicked_at timestamptz,
  add column if not exists qualification_score integer,
  add column if not exists qualification_notes text;

-- Email events from Resend webhooks
create table if not exists email_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  lead_id uuid references leads(id) on delete cascade,
  resend_email_id text,
  event_type text not null, -- delivered | opened | clicked | bounced | complained | unsubscribed | replied
  metadata jsonb
);

create index if not exists email_events_lead_id on email_events (lead_id);
create index if not exists email_events_type on email_events (event_type);

-- Customers (converted leads or manually added clients)
create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  company_name text not null,
  contact_name text,
  email text,
  phone text,
  website text,
  industry text,
  city text,
  status text default 'prospect', -- prospect | active | completed | churned
  lead_id uuid references leads(id),
  notes text
);

-- Projects
create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  customer_id uuid references customers(id) on delete cascade,
  name text not null,
  description text,
  status text default 'scoping', -- scoping | in_progress | review | completed | cancelled
  build_fee integer,
  monthly_fee integer,
  start_date date,
  due_date date,
  completed_date date,
  notes text
);

create index if not exists projects_customer_id on projects (customer_id);
create index if not exists projects_status on projects (status);
