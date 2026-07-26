-- v5: add source column to leads + RLS policy for website form submissions

ALTER TABLE leads ADD COLUMN IF NOT EXISTS source text;

-- Allow anonymous users to insert website leads
-- (run this if RLS is enabled on the leads table)
CREATE POLICY IF NOT EXISTS "anon can insert website leads"
  ON leads FOR INSERT
  TO anon
  WITH CHECK (source = 'website' AND status = 'website_lead');
