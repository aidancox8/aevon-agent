/**
 * tempo/dnc.js
 * Do-not-contact guard for the Tempo campaign. Many Changepain physicians and
 * staff work part-time at other clinics, so a lead clinic's scraped contact can
 * be a Changepain person even though Changepain itself is excluded. This module
 * checks a lead's contact name and email against tempo/do-not-contact.json.
 *
 * Matching rules (deliberately conservative to avoid false positives):
 *  - contact name: normalized full-name match (case/accents/"Dr." ignored)
 *  - email local part: exact first.last / firstlast / f.lastname / first_last
 *    pattern match; additionally, a bare substring match on last names of
 *    5+ characters (short surnames like Lau/Sun/Ho would false-positive).
 */

const names = require('./do-not-contact.json').names;

/**
 * Organisations that must never be contacted by any campaign, whoever the contact is.
 *
 * Separate from the people list above, because that list only matches a person's name or the
 * local part of their address. On 2026-08-06 "Changepain Medical & Allied Health Clinic"
 * <privateservices@changepain.ca> was found sitting in tempo_leads with status 'queued', one
 * send away from pitching clinic scheduling software to Aidan's own employer. dncReason()
 * cleared it, correctly by its own rules: "privateservices" matches no person on the list.
 *
 * The only guard was EXCLUDE_NAMES in the lead finder, which runs at discovery. Anything that
 * reached the table by another route, or before that guard existed, was unprotected. This
 * closes it at send time, which is the only place that actually matters.
 */
// Never contacted, at organisation level, on any campaign. The first two are Aidan's employer,
// which sat queued in tempo_leads and received two emails in June 2026 before anyone noticed.
// 'brendalaumd' is matched with separators stripped, so brendalaumd.com, brenda-lau-md.ca and
// "Brenda Lau MD" all catch.
const EXCLUDED_ORGS = ['changepain', 'change pain', 'artus', 'brendalaumd', 'brenda lau'];

/**
 * Domains where somebody asked us to stop.
 *
 * Kept separate from EXCLUDED_ORGS because the reason is different: those are places we choose
 * never to pitch, these are places that told us no. Mixing them would lose that distinction the
 * first time anyone asked why a name was on the list.
 *
 * Setting the lead's status to `unsubscribed` already stops the send, since every sender queries
 * `status = 'queued'`. This is the second layer, and it exists for one specific failure: a lead
 * finder re-discovering the same company later and inserting a FRESH row at `queued`, which the
 * status guard cannot see. The status protects the row; this protects the company.
 *
 * Each entry records who and when, because a do-not-contact list nobody can audit becomes a list
 * nobody trusts and eventually a list somebody quietly edits.
 */
const OPTED_OUT_DOMAINS = [
  // Robert replied "NO" 2026-08-25 to the Aevon "injury case intake" follow-up. He had a third
  // touch booked for 2026-08-30, which was cancelled. Note the address mismatch that let this
  // slip past automated matching: he writes from robert@, the row held rob@.
  'kornfeldlaw.com',
  // Laura Cyprus (Manager, Business Development & Marketing) replied "no" 2026-09-02 to the
  // Aevon "boughton law intake" email. A follow-up was booked for 2026-09-07 and was cancelled.
  // The SAME address mismatch as Kornfeld above: she writes from lcyprus@, the row held pr@.
  // Twice now. People reply from their own address, never the generic one we mailed, so the
  // domain fallback in reply-processor's matchLead() is the thing actually doing the work.
  'boughtonlaw.com',
];

/** Returns a reason if this lead's employer or email domain is excluded outright, else null. */
function excludedOrgReason(businessName, email) {
  const name = norm(businessName);
  const domain = String(email || '').toLowerCase().split('@')[1] || '';
  const nameSquashed = name.replace(/[^a-z]/g, '');

  // Somebody at this company said stop. That outranks every other reason to send.
  for (const d of OPTED_OUT_DOMAINS) {
    if (domain === d || domain.endsWith('.' + d)) {
      return `${d} asked not to be contacted again`;
    }
    // Catch a re-scrape that found the company but not the same address.
    const bare = d.replace(/\.[a-z.]+$/, '').replace(/[^a-z]/g, '');
    if (bare.length >= 6 && nameSquashed.includes(bare)) {
      return `${d} asked not to be contacted again`;
    }
  }
  for (const org of EXCLUDED_ORGS) {
    if (name && name.includes(org)) return `business is an excluded organisation (${org})`;
    // Also compare with separators stripped so "Brenda Lau MD" matches "brendalaumd".
    if (nameSquashed && nameSquashed.includes(org.replace(/\s/g, ''))) {
      return `business is an excluded organisation (${org})`;
    }
    // Compare against the domain with separators stripped, so "change-pain.ca" is caught too.
    if (domain && domain.replace(/[^a-z]/g, '').includes(org.replace(/\s/g, ''))) {
      return `email domain belongs to an excluded organisation (${domain})`;
    }
  }
  return null;
}

const norm = s => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip accents
  .toLowerCase().replace(/^dr\.?\s+/, '').replace(/[^a-z\s-]/g, '').replace(/\s+/g, ' ').trim();

const people = names.map(n => {
  const parts = norm(n).split(' ');
  return { full: norm(n), first: parts[0], last: parts[parts.length - 1] };
});

/** Returns a reason string if this contact must not be contacted, else null. */
function dncReason(contactName, email) {
  const cn = norm(contactName);
  if (cn) {
    for (const p of people) {
      if (cn === p.full) return `contact name matches do-not-contact list (${p.full})`;
      // "b. lau" / "lau, brenda" style
      if (cn.includes(p.last) && cn.includes(p.first)) return `contact name matches do-not-contact list (${p.full})`;
    }
  }
  const local = String(email || '').toLowerCase().split('@')[0].replace(/[^a-z._-]/g, '');
  if (local) {
    for (const p of people) {
      const pats = [
        p.first + '.' + p.last, p.first + p.last, p.first + '_' + p.last, p.first + '-' + p.last,
        p.first[0] + '.' + p.last, p.first[0] + p.last,
        p.last + '.' + p.first, p.last + p.first,
      ];
      if (pats.includes(local)) return `email matches do-not-contact person (${p.full})`;
      if (p.last.length >= 5 && local.includes(p.last)) return `email contains do-not-contact surname (${p.full})`;
    }
  }
  return null;
}

module.exports = { dncReason, excludedOrgReason };
