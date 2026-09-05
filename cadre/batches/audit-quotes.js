// One-off audit, 2026-09-05: which generated bodies quote a chopped fragment.
// Writes the ids to regen-ids.json so the copy can be cleared and regenerated.
require('dotenv').config({ path: __dirname + '/../../.env' });
const fs = require('fs');
const sb = require('../../lib/supabase');
const src = fs.readFileSync(__dirname + '/../personalizer.js', 'utf8');
const cq = new Function(src.slice(src.indexOf('function cleanQuote'), src.indexOf('\n}', src.indexOf('function cleanQuote')) + 2) + '; return cleanQuote;')();

const CHOPPED = /\b(and|or|to|of|the|with|as|such|a|an|in|for|by|on|are|is|including|U)[.]?$/i;

(async () => {
  const { data, error } = await sb.from('cadre_leads')
    .select('id,business_name,signal_quote,email_subject,email_body,copy_locked,scheduled_send_at')
    .eq('status', 'queued').not('email_subject', 'is', null).eq('copy_locked', false).limit(300);
  if (error) throw new Error(error.message);
  const bad = [];
  for (const r of data) {
    const m = (r.email_body || '').match(/["“]([^"”]{15,})["”]/);
    const inBody = m ? m[1].trim() : '';
    const chopped = !inBody || CHOPPED.test(inBody) || /&$/.test(inBody) || /\bquoted\b/i.test(r.email_body);
    if (chopped) {
      bad.push(r);
      console.log('!! ' + r.business_name.slice(0, 28).padEnd(30) + ' body=' + JSON.stringify(inBody.slice(-60)) + '\n      new clean=' + JSON.stringify(cq(r.signal_quote)));
    }
  }
  console.log('\nflagged', bad.length, 'of', data.length);
  fs.writeFileSync(__dirname + '/regen-ids.json', JSON.stringify(bad.map((b) => b.id)));
})();
