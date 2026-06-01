/**
 * enrich-emails.js
 * Re-scrapes leads that have a website but no email, using the upgraded
 * contact-finder (homepage + contact/about/team pages, decision-maker
 * preference). Fills email / email_quality / contact_name / contact_role
 * where a contact is found.
 *
 * After this runs, leads still missing an email are genuinely unreachable
 * and can be cleared with --purge (or the SQL in the console).
 *
 * Usage:
 *   node enrich-emails.js              re-scrape no-email leads
 *   node enrich-emails.js --purge      after enriching, delete leads still
 *                                      with no email
 *   node enrich-emails.js --limit 100  cap how many to process this run
 */

require('dotenv').config();
const supabase = require('./lib/supabase');
const { findContact } = require('./lib/contact-finder');

const CONCURRENCY = 6;

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { purge: false, limit: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--purge') out.purge = true;
    if (a[i] === '--limit') out.limit = parseInt(a[++i], 10);
  }
  return out;
}

async function enrich(limit) {
  let q = supabase.from('leads')
    .select('id, business_name, website')
    .is('email', null)
    .not('website', 'is', null)
    .order('qualification_score', { ascending: false, nullsFirst: false });
  if (limit) q = q.limit(limit);

  const { data: leads, error } = await q;
  if (error) throw new Error(`Fetch failed: ${error.message}`);
  if (!leads || leads.length === 0) { console.log('No no-email leads with a website to enrich.'); return 0; }

  console.log(`Enriching ${leads.length} lead(s)...\n`);
  let found = 0, still = 0, done = 0;

  // Process in small parallel batches (network bound).
  for (let i = 0; i < leads.length; i += CONCURRENCY) {
    const batch = leads.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async lead => {
      let contact;
      try { contact = await findContact(lead.website); }
      catch { contact = null; }
      done++;
      if (contact && contact.email) {
        await supabase.from('leads').update({
          email: contact.email,
          email_quality: contact.emailQuality,
          contact_name: contact.contactName,
          contact_role: contact.contactRole,
        }).eq('id', lead.id);
        found++;
        console.log(`  [${done}/${leads.length}] ${lead.business_name} -> ${contact.email} (${contact.emailQuality}${contact.contactName ? ', ' + contact.contactName : ''})`);
      } else {
        still++;
      }
    }));
  }

  console.log(`\nEnrichment done. Found email for ${found} | still no email ${still} | processed ${done}`);
  return found;
}

async function purge() {
  const { data, error } = await supabase.from('leads')
    .delete()
    .is('email', null)
    .neq('status', 'replied')
    .neq('status', 'converted')
    .select('id');
  if (error) throw new Error(`Purge failed: ${error.message}`);
  console.log(`Purged ${data ? data.length : 0} unreachable (no-email) lead(s).`);
}

async function run() {
  const args = parseArgs();
  await enrich(args.limit);
  if (args.purge) {
    console.log('\nPurging leads still without an email...');
    await purge();
  } else {
    console.log('\nRe-run with --purge to delete leads that are still unreachable.');
  }
}

run().catch(err => { console.error('Fatal error:', err.message); process.exit(1); });
