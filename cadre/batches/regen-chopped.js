// One-off, 2026-09-05: trim three source-truncated quotes to a verbatim prefix, then clear the
// generated copy on every lead the audit flagged so the personalizer rewrites it.
require('dotenv').config({ path: __dirname + '/../../.env' });
const sb = require('../../lib/supabase');
const ids = require('./regen-ids.json');
const TRIM = {
  'LRG': 'Ensure teams design and deliver high-quality training programmes',
  'Fujifilm': 'Maintains department training and task certification records',
  'LB&B Associates Inc.': 'Maintain training records in compliance with government contract specifications',
};
(async () => {
  for (const [name, q] of Object.entries(TRIM)) {
    const { error } = await sb.from('cadre_leads').update({ signal_quote: q }).eq('business_name', name).eq('status', 'queued');
    console.log(error ? `trim ${name} FAILED ${error.message}` : `trimmed ${name}`);
  }
  const { data, error } = await sb.from('cadre_leads').update({ email_subject: null, email_body: null, scheduled_send_at: null }).in('id', ids).eq('copy_locked', false).select('id');
  console.log(error ? `clear FAILED ${error.message}` : `cleared copy on ${data.length} lead(s)`);
})();
