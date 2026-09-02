/**
 * lib/suppression.js — one opt-out list across every campaign.
 *
 * THE HOLE THIS CLOSES. Each campaign checks its OWN table for status='dont_contact'. So a
 * person who replied "no" to Tempo is still fair game in Aevon, because the row that carries
 * their refusal lives in a different table from the row about to email them. Measured
 * 2026-09-02: 10 live rows in `leads` and 158 in `tempo_leads` were queued to addresses that
 * had already opted out somewhere else. Same sender, same mailbox, same person, and as far as
 * the recipient is concerned they said no and got another email.
 *
 * tempo/dnc.js already generalised the ORGANISATION case this way, and cadre/sender.js imports
 * it. This does the same for the ADDRESS case, which is the one that actually keeps failing:
 * Kornfeld and Boughton both slipped through because a person replies from their own address
 * while the row holds a generic one.
 *
 * Deliberately reads from the database rather than a checked-in list. A file has to be edited
 * by hand and nobody remembers; a status column is written by the reply processor the moment
 * somebody declines, in whichever campaign they happened to decline to.
 */
const supabase = require('./supabase');
const { excludedOrgReason } = require('../tempo/dnc');

/** Every table that holds people we email. A new campaign gets added here, once. */
const LEAD_TABLES = ['leads', 'cadre_leads', 'tempo_leads'];
const STOP_STATUSES = ['dont_contact', 'unsubscribed', 'bounced'];

async function page(table, cols) {
  let out = [], from = 0;
  for (;;) {
    const { data, error } = await supabase.from(table).select(cols).range(from, from + 999);
    if (error) return null; // a table that is not there is not an error, it is just absent
    out = out.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}

/**
 * Build the union once per run. Callers hold the result and pass it to isSuppressed(), so a
 * send loop does not re-query per lead.
 *
 * Returns { emails: Set<string>, tables: string[], counted: number }.
 */
async function loadSuppressions() {
  const emails = new Set();
  const tables = [];
  for (const t of LEAD_TABLES) {
    const rows = await page(t, 'email, status');
    if (!rows) continue;
    tables.push(t);
    for (const r of rows) {
      if (!STOP_STATUSES.includes(r.status)) continue;
      const e = String(r.email || '').trim().toLowerCase();
      if (e.includes('@')) emails.add(e);
    }
  }
  return { emails, tables, counted: emails.size };
}

/**
 * Returns a printable reason to hold this send, or null to proceed.
 *
 * Order matters: the cheapest and most certain check first. The org check is last because it
 * is the fuzziest and most likely to produce a surprising match.
 */
function isSuppressed(email, businessName, index) {
  const e = String(email || '').trim().toLowerCase();
  if (!e.includes('@')) return 'not a usable address';
  if (index && index.emails.has(e)) return 'this address opted out or bounced on another campaign';
  const org = excludedOrgReason(businessName, e);
  if (org) return org;
  return null;
}

module.exports = { loadSuppressions, isSuppressed, LEAD_TABLES, STOP_STATUSES };
