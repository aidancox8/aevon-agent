require('dotenv').config();
const supabase = require('./lib/supabase');

const SIGNOFF_PATTERN = /\n+\s*(?:(?:best|regards|thanks|cheers|sincerely|warm regards),?\s*\n+\s*)?aidan[\s\S]*$/i;

async function run() {
  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, email_body, followup_body')
    .not('email_subject', 'is', null);

  if (error) throw new Error(error.message);

  let fixed = 0;

  for (const lead of leads) {
    const updates = {};

    for (const field of ['email_body', 'followup_body']) {
      const original = lead[field];
      if (!original) continue;
      const stripped = original.replace(SIGNOFF_PATTERN, '').trimEnd();
      if (stripped !== original) updates[field] = stripped;
    }

    if (Object.keys(updates).length) {
      await supabase.from('leads').update(updates).eq('id', lead.id);
      fixed++;
    }
  }

  console.log(`Done. Fixed sign-offs on ${fixed} leads.`);
}

run().catch(err => { console.error(err.message); process.exit(1); });
