-- Run this in Supabase SQL Editor
-- Allows the CRM dashboard (browser, anon key) to read all tables
-- and the backend agent (secret key) to write everything

-- leads
alter table leads enable row level security;
create policy "anon read" on leads for select using (true);
create policy "service write" on leads for all using (auth.role() = 'service_role');

-- email_events
alter table email_events enable row level security;
create policy "anon read" on email_events for select using (true);
create policy "service write" on email_events for all using (auth.role() = 'service_role');

-- customers
alter table customers enable row level security;
create policy "anon read" on customers for select using (true);
create policy "anon write" on customers for all using (true) with check (true);

-- projects
alter table projects enable row level security;
create policy "anon read" on projects for select using (true);
create policy "anon write" on projects for all using (true) with check (true);
