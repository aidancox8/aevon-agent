#!/usr/bin/env node
/**
 * cadre/hr-contacts.js — derive an HR address for leads whose website we know but whose
 * address we could not find published anywhere.
 *
 * WHY THIS EXISTS. After find-websites and hunt-emails, most leads have a website and no
 * address, because small industrial companies publish a phone number and a contact form rather
 * than a mailbox. The list is otherwise unusable: a signal-qualified company we cannot reach is
 * the same as no lead at all.
 *
 * WHY hr@ AND NOT SOMETHING ELSE. Measured against the addresses actually found published on
 * this campaign's own leads (n=79): hr@ is the second most common local part after info@, at 9
 * of 79. For comparison, in tempo_leads (clinics) hr@ appears once in 688, and in the Aevon
 * list 6 in 5,000. So hr@ is roughly a hundred times more common in THIS audience than in the
 * other two, which is what makes the guess worth testing at all. It is still a guess.
 *
 * WHAT WE CAN AND CANNOT VERIFY. Port 25 is blocked outbound from the VM and from here, so
 * there is no SMTP RCPT probe available and no way to confirm a mailbox exists. What we can do
 * is an MX lookup, which proves the domain accepts mail at all and removes parked and dead
 * domains. Everything past that is unproven, so:
 *
 *   - the address is written with email_quality = 'guessed'
 *   - the row is parked at status = 'needs_review', which the sender's query
 *     (status in queued|sent) will not pick up
 *
 * That second part matters: CADRE_ARMED is true and the scheduled sender goes out at 12 a day,
 * so writing a guessed address straight to 'queued' would start mailing unverified addresses
 * the next morning with nobody having agreed to it. Releasing them is a deliberate, separate
 * act. Do a measured batch first and watch the bounce rate; the sender halts above 5%.
 *
 *   node cadre/hr-contacts.js --dry
 *   node cadre/hr-contacts.js --limit 50
 *   node cadre/hr-contacts.js --release 30     move 30 reviewed guesses to queued
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const dnsBase = require('dns');
// The system resolver on this machine fails MX lookups wholesale: a first run reported
// "no MX" for novartis.com and homedepot.com, which is plainly wrong. sender.js has pinned
// public resolvers since June for the same reason. Without this the script silently
// concludes every domain is dead.
try { dnsBase.setServers(['8.8.8.8', '1.1.1.1']); } catch (e) { /* keep system resolvers */ }
const dns = dnsBase.promises;
const supabase = require('../lib/supabase');

const TABLE = 'cadre_leads';
const DRY = process.argv.includes('--dry');
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? parseInt(process.argv[i + 1], 10) : null;
};
const LIMIT = arg('limit');
const RELEASE = arg('release');

/**
 * Apex domains that belong to somebody else: free mail, a social profile, or a site builder.
 * Checked against the DERIVED apex rather than the raw host, because "acme.wixsite.com" starts
 * with the company name and would otherwise pass a prefix test and yield hr@wixsite.com.
 */
const NOT_A_COMPANY_DOMAIN = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com',
  'facebook.com', 'linkedin.com', 'instagram.com', 'indeed.com', 'glassdoor.com',
  'wixsite.com', 'weebly.com', 'squarespace.com', 'godaddysites.com', 'business.site',
  'sites.google.com', 'linktr.ee', 'wordpress.com', 'blogspot.com', 'myshopify.com',
]);

/** "https://www.example.co.uk/careers?x=1" -> "example.co.uk" */
function apexOf(website) {
  let host;
  try {
    host = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./i, '').toLowerCase();
  // Keep three labels for the compound TLDs this list actually contains (.co.uk, .com.au,
  // .co.nz), two otherwise. A naive last-two-labels rule turns example.co.uk into co.uk and
  // then guesses hr@co.uk, which is somebody else's domain entirely.
  const parts = host.split('.');
  const compound = /^(co|com|org|net|gov|ac)\.[a-z]{2}$/.test(parts.slice(-2).join('.'));
  const keep = compound ? 3 : 2;
  const apex = parts.length <= keep ? host : parts.slice(-keep).join('.');
  return NOT_A_COMPANY_DOMAIN.has(apex) ? null : apex;
}

/** Does this domain accept mail at all? Cheap, and it removes parked domains. */
async function hasMx(domain) {
  try {
    const mx = await dns.resolveMx(domain);
    return Array.isArray(mx) && mx.length > 0;
  } catch {
    return false;
  }
}

async function release(n) {
  const { data, error } = await supabase.from(TABLE)
    .select('id, business_name, email')
    .eq('status', 'needs_review').eq('email_quality', 'guessed')
    .order('qualification_score', { ascending: false, nullsFirst: false })
    .limit(n);
  if (error) throw new Error(error.message);
  if (!data.length) { console.log('Nothing parked at needs_review.'); return; }
  console.log(`Releasing ${data.length} guessed address(es) to queued:\n`);
  for (const r of data) console.log(`  ${r.email.padEnd(38)} ${r.business_name}`);
  if (DRY) { console.log('\nDry run, nothing changed.'); return; }
  const { error: e2 } = await supabase.from(TABLE)
    .update({ status: 'queued' }).in('id', data.map(r => r.id));
  if (e2) throw new Error(e2.message);
  console.log(`\nReleased. The scheduled sender will pick these up at ${process.env.CADRE_DAILY_CAP || 12}/day.`);
  console.log('Watch the bounce rate: the sender halts above 5%.');
}

(async () => {
  if (RELEASE) return release(RELEASE);

  const { data: leads, error } = await supabase.from(TABLE)
    .select('id, business_name, website, city, qualification_score')
    .is('email', null).not('website', 'is', null)
    .not('status', 'in', '("dont_contact","unsubscribed","bounced")')
    .order('qualification_score', { ascending: false, nullsFirst: false });
  if (error) throw new Error(error.message);

  const batch = LIMIT ? leads.slice(0, LIMIT) : leads;
  console.log(`${DRY ? 'DRY RUN: ' : ''}${batch.length} lead(s) with a website and no address\n`);

  let wrote = 0, noMx = 0, noDomain = 0;
  const seen = new Set();
  for (const lead of batch) {
    const domain = apexOf(lead.website);
    if (!domain) { noDomain++; console.log(`  skip ${String(lead.business_name).slice(0, 32).padEnd(34)}not a company domain (${lead.website})`); continue; }
    // Two leads can share a parent company's domain. One address per domain, or the same
    // mailbox gets the same pitch twice under different company names.
    if (seen.has(domain)) { console.log(`  dup  ${String(lead.business_name).slice(0, 32).padEnd(34)}${domain} already used`); continue; }

    if (!await hasMx(domain)) { noMx++; console.log(`  none ${String(lead.business_name).slice(0, 32).padEnd(34)}${domain} has no MX`); continue; }

    seen.add(domain);
    const email = `hr@${domain}`;
    wrote++;
    console.log(`  ok   ${String(lead.business_name).slice(0, 32).padEnd(34)}${email}`);
    if (!DRY) {
      const { error: e2 } = await supabase.from(TABLE).update({
        email,
        email_quality: 'guessed',
        status: 'needs_review',
        email_hunt_attempted_at: new Date().toISOString(),
      }).eq('id', lead.id);
      if (e2) console.log(`       FAILED to save: ${e2.message}`);
    }
  }

  console.log(`\n${wrote} address(es) derived. ${noMx} domains with no MX, ${noDomain} not a company domain.`);
  if (wrote && !DRY) {
    console.log(`\nParked at status='needs_review' so the armed sender will NOT touch them.`);
    console.log(`These are GUESSES: an MX record proves the domain takes mail, not that hr@ exists.`);
    console.log(`Release a measured batch first:  node cadre/hr-contacts.js --release 30`);
  }
})().catch(e => { console.error('hr-contacts failed:', e.message); process.exit(1); });
