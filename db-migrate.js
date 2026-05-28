/**
 * db-migrate.js
 * Runs all schema migrations directly against Supabase Postgres.
 * Safe to re-run - uses IF NOT EXISTS and DROP IF EXISTS throughout.
 *
 * Usage: node db-migrate.js
 */

require('dotenv').config();
const { Client } = require('pg');

const client = new Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

const migrations = [
  {
    name: '001_leads',
    sql: `
      create table if not exists leads (
        id uuid primary key default gen_random_uuid(),
        created_at timestamptz default now(),
        business_name text not null,
        address text,
        phone text,
        website text,
        email text,
        industry text,
        city text,
        sequence_step integer default 0,
        status text default 'queued',
        scheduled_send_at timestamptz,
        last_sent_at timestamptz,
        email_subject text,
        email_body text,
        followup_subject text,
        followup_body text,
        resend_email_id text,
        resend_followup_id text,
        opened_at timestamptz,
        clicked_at timestamptz,
        qualification_score integer,
        qualification_notes text,
        lead_insights text,
        notes text
      );
      create index if not exists leads_send_queue
        on leads (scheduled_send_at, status, sequence_step)
        where status = 'queued';
    `,
  },
  {
    name: '002_email_events',
    sql: `
      create table if not exists email_events (
        id uuid primary key default gen_random_uuid(),
        created_at timestamptz default now(),
        lead_id uuid references leads(id) on delete cascade,
        resend_email_id text,
        event_type text not null,
        metadata jsonb
      );
      create index if not exists email_events_lead_id on email_events (lead_id);
      create index if not exists email_events_type on email_events (event_type);
    `,
  },
  {
    name: '003_customers',
    sql: `
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
        status text default 'prospect',
        lead_id uuid references leads(id),
        notes text
      );
    `,
  },
  {
    name: '004_projects',
    sql: `
      create table if not exists projects (
        id uuid primary key default gen_random_uuid(),
        created_at timestamptz default now(),
        customer_id uuid references customers(id) on delete cascade,
        name text not null,
        description text,
        status text default 'scoping',
        build_fee integer,
        monthly_fee integer,
        start_date date,
        due_date date,
        completed_date date,
        notes text
      );
      create index if not exists projects_customer_id on projects (customer_id);
      create index if not exists projects_status on projects (status);
    `,
  },
  {
    name: '005_invoices',
    sql: `
      create table if not exists invoices (
        id uuid primary key default gen_random_uuid(),
        created_at timestamptz default now(),
        project_id uuid references projects(id) on delete cascade,
        customer_id uuid references customers(id) on delete cascade,
        invoice_number text,
        status text default 'draft',
        amount integer not null,
        due_date date,
        paid_date date,
        notes text
      );
      create index if not exists invoices_customer_id on invoices (customer_id);
      create index if not exists invoices_status on invoices (status);
    `,
  },
  {
    name: '006_leads_insights_column',
    sql: `alter table leads add column if not exists lead_insights text;`,
  },
  {
    name: '009_email_unique',
    sql: `
      CREATE UNIQUE INDEX IF NOT EXISTS leads_email_unique
        ON leads (email)
        WHERE email IS NOT NULL;
    `,
  },
  {
    name: '008_rls',
    sql: `
      alter table leads enable row level security;
      drop policy if exists "anon read" on leads;
      drop policy if exists "service write" on leads;
      create policy "anon read" on leads for select using (true);
      create policy "service write" on leads for all using (auth.role() = 'service_role');

      alter table email_events enable row level security;
      drop policy if exists "anon read" on email_events;
      drop policy if exists "service write" on email_events;
      create policy "anon read" on email_events for select using (true);
      create policy "service write" on email_events for all using (auth.role() = 'service_role');

      alter table customers enable row level security;
      drop policy if exists "anon read" on customers;
      drop policy if exists "anon write" on customers;
      create policy "anon read" on customers for select using (true);
      create policy "anon write" on customers for all using (true) with check (true);

      alter table projects enable row level security;
      drop policy if exists "anon read" on projects;
      drop policy if exists "anon write" on projects;
      create policy "anon read" on projects for select using (true);
      create policy "anon write" on projects for all using (true) with check (true);

      alter table invoices enable row level security;
      drop policy if exists "anon read" on invoices;
      drop policy if exists "anon write" on invoices;
      create policy "anon read" on invoices for select using (true);
      create policy "anon write" on invoices for all using (true) with check (true);
    `,
  },
];

async function run() {
  await client.connect();
  console.log('Connected to Supabase Postgres.\n');

  for (const migration of migrations) {
    process.stdout.write(`  [${migration.name}]... `);
    try {
      await client.query(migration.sql);
      console.log('done');
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
    }
  }

  await client.end();
  console.log('\nAll migrations complete. Run this anytime you add new tables.');
}

run().catch(async err => {
  console.error('Fatal:', err.message);
  await client.end();
  process.exit(1);
});
