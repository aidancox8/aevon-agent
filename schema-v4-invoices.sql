-- Run in Supabase SQL Editor

create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  project_id uuid references projects(id) on delete cascade,
  customer_id uuid references customers(id) on delete cascade,
  invoice_number text,
  status text default 'draft',        -- draft | sent | paid | overdue
  amount integer not null,            -- in dollars
  due_date date,
  paid_date date,
  notes text
);

create index if not exists invoices_customer_id on invoices (customer_id);
create index if not exists invoices_status on invoices (status);

-- RLS
alter table invoices enable row level security;
create policy "anon read" on invoices for select using (true);
create policy "anon write" on invoices for all using (true) with check (true);
