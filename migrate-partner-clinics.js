#!/usr/bin/env node
/**
 * The partner search returned a lot of actual clinics, because Google Places matches a
 * clinic's own description rather than the service type asked for. Those are the wrong
 * answer to the question asked, but they are the right answer to a different one: they are
 * Tempo prospects the lead finder's search terms never surfaced.
 *
 * This moves the genuine ones across. It is deliberately strict, because a prospect list
 * polluted with construction firms and marketing agencies wastes sends and personalizer
 * budget. Anything not clearly a multi-provider treatment clinic is left behind.
 *
 *   node migrate-partner-clinics.js --dry
 *   node migrate-partner-clinics.js
 */
require('dotenv').config();
const supabase = require('./lib/supabase');
const { dncReason } = require('./tempo/dnc');

const DRY = process.argv.includes('--dry');

// Must look like a place that treats patients with more than one practitioner.
const CLINIC = /\b(clinic|physio|physical therapy|chiro|massage|rmt|rehab|wellness centre|wellness center|health centre|health center|sports med|integrated health|naturopath|kinesiolog|osteopath|acupunctur|pelvic|concussion)\b/i;

// Things that matched "clinic" but do not run a treatment schedule. Each of these actually
// appeared in the results.
const NOT_A_CLINIC = /construction|design|marketing|agency|digital|software|recruit|staffing|consult|broker|insurance|law|realty|real estate|dental lab|pharmacy|veterinar|immigration|visa\b|ime\b|dexa|imaging|lab services|supplies|equipment/i;

(async () => {
  const { data: partners, error } = await supabase
    .from('partners').select('*').eq('status', 'clinic_not_partner');
  if (error) throw new Error(error.message);

  const existing = [];
  for (let f = 0; ; f += 1000) {
    const { data } = await supabase.from('tempo_leads').select('business_name, email, website').range(f, f + 999);
    if (!data || !data.length) break;
    existing.push(...data);
    if (data.length < 1000) break;
  }
  const byName = new Set(existing.map(l => (l.business_name || '').toLowerCase().trim()));
  const byEmail = new Set(existing.map(l => (l.email || '').toLowerCase()).filter(Boolean));
  const bySite = new Set(existing.map(l => (l.website || '').toLowerCase().replace(/\/+$/, '')).filter(Boolean));

  let moved = 0, skipped = 0;
  const rejected = [];

  for (const p of partners || []) {
    const name = (p.business_name || '').trim();
    if (!CLINIC.test(name) || NOT_A_CLINIC.test(name)) { rejected.push(name); continue; }
    if (!p.email) { skipped++; continue; }
    if (byName.has(name.toLowerCase()) || byEmail.has(p.email.toLowerCase())
        || (p.website && bySite.has(p.website.toLowerCase().replace(/\/+$/, '')))) { skipped++; continue; }
    // The do-not-contact gate has to run here too. Migrating around it would be the one way
    // a barred name could reach the send queue.
    const dnc = dncReason(p.contact_name, p.email);
    if (dnc) { rejected.push(name + ' [DNC: ' + dnc + ']'); continue; }

    console.log(`${DRY ? '[dry] ' : ''}${name.slice(0, 46).padEnd(46)} ${p.email}`);
    if (!DRY) {
      // No email_subject, so the scheduled personalizer writes copy under the current
      // prompt rather than these inheriting anything stale.
      const { error: insErr } = await supabase.from('tempo_leads').insert({
        business_name: name, address: p.address || null, phone: p.phone || null,
        website: p.website || null, email: p.email, email_quality: p.email_quality || null,
        contact_name: p.contact_name || null, contact_role: p.contact_role || null,
        industry: 'clinic', city: p.city || null, status: 'queued', sequence_step: 0,
        qualification_score: 7,
        qualification_notes: 'Found during partner search; treatment clinic, not a referral partner.',
        source: 'partner-search-salvage',
      });
      if (insErr) { if (!/duplicate|unique/i.test(insErr.message)) console.log(`   (insert failed: ${insErr.message})`); skipped++; continue; }
      await supabase.from('partners').update({ status: 'moved_to_tempo_leads' }).eq('id', p.id);
    }
    byName.add(name.toLowerCase());
    moved++;
  }

  console.log(`\n${DRY ? 'Would move' : 'Moved'} ${moved} | skipped ${skipped} (duplicate or no email) | rejected ${rejected.length} as not a clinic`);
  if (rejected.length) console.log('  e.g. ' + rejected.slice(0, 6).join(' · '));
})().catch(e => { console.error('migration failed:', e.message); process.exit(1); });
