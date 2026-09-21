#!/usr/bin/env node
/**
 * aevon-renewal-copy.js
 *
 * Re-runs the Canadian real-estate and mortgage leads with a new first email: the 2021
 * five-year renewal wave. The old sequence (Front Desk agent, $1,500, demo link) went out with
 * HTML and links in the era that landed in junk, so the leads count as unseen, not exhausted.
 *
 * Canada only. A US mortgage is a 30-year fixed with no term end, so "renewal" means nothing
 * there; the US leads keep whatever copy they have and are not touched.
 *
 * What it does to each lead in the pool:
 *   - writes the renewal first email + two follow-ups (variant by realtor vs broker)
 *   - restarts the sequence at step 0, status queued
 *   - tags personalization_basis 'campaign:renewal-2026-realtor' | 'campaign:renewal-2026-broker' so regen-copy
 *     and regen-followups leave the copy alone
 *   - schedules the send no earlier than 30 days after the lead's last old email
 *   - lifts qualification_score to 10 so the test goes out ahead of the 3,000+ other queued
 *     leads (which all score 7 to 9); the prior status, step and score are kept in notes
 *
 * Usage:
 *   node aevon-renewal-copy.js            dry run: counts, dates, one sample of each variant
 *   node aevon-renewal-copy.js --apply    snapshots leads to leads_backup_<date>, then writes
 */
require('dotenv').config({ quiet: true });
const { createClient } = require('@supabase/supabase-js');
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

const INDUSTRIES = ['real estate brokerage', 'real estate team', 'mortgage brokerage', 'mortgage broker'];
const GAP_DAYS = 30;

// City strings on this list look like "Surrey BC", "Vancouver", "Bellevue WA", "Phoenix AZ".
const US_STATE = /\b(WA|OR|AZ|CO|TX|CA|NV|IL|GA|FL|NY|NJ|MA|PA|OH|MI|MN|NC|SC|VA|MD|UT|ID|MT|WI|MO|TN|KY|IN|OK|KS|NE|IA|AR|LA|AL|MS|NM|HI|AK|DC|CT|RI|NH|VT|ME|DE|WV|ND|SD|WY)$/;
const CANADA = /\b(BC|AB|ON|QC|MB|SK|NS|NB|PE|NL|YT|NT|NU)$|british columbia|vancouver|burnaby|richmond|surrey|coquitlam|langley|delta|new westminster|white rock|maple ridge|abbotsford|chilliwack|mission|kelowna|victoria|nanaimo|sooke|squamish|whistler|port moody|pitt meadows|calgary|edmonton|toronto|ottawa|winnipeg|montreal/i;
const isCanadian = l => !US_STATE.test(l.city || '') && CANADA.test(l.city || '');

// Never these three (CLAUDE.md hard rule 2).
const NEVER = new Set(['jean@vancouvercommercialbrokers.ca', 'info@restaurantbusinessbroker.ca', 'sales@restaurantbusinessbroker.ca']);

// ── Copy ─────────────────────────────────────────────────────────────────────
// No greeting (the sender's convention), no link, no product name, no price. One fact about
// them, one sentence on what gets built, one question that is easy to answer with a no.
// The sender appends the signature and the opt-out line.
const COPY = {
  realtor: {
    basis: 'campaign:renewal-2026-realtor',
    email_subject: 'your 2021 buyers',
    email_body:
`Anyone you sold to in 2021 on a five-year term comes up for renewal this year, and the lender's letter reaches them months before the date. By the time it comes up in conversation with you, most have already decided whether they are staying put or moving.

The CRMs realtors use fire on the closing anniversary, not the term end, so this usually runs on memory. I build small tools for offices like yours that watch those dates and put the check-in in front of you a few months out, already drafted.

Do you know which of your 2021 clients renew this year, or is that not something anyone tracks?`,
    followup_subject: 're: your 2021 buyers',
    followup_body:
`Quick one on the note below. If the renewal dates are already handled, a one-word no saves us both the thread. If they are not, I can show you what the reminder looks like.`,
    followup2_subject: 're: your 2021 buyers',
    followup2_body:
`Last one from me. The 2021 renewals keep landing through the year either way, so if this ever becomes worth a look, reply and I will pick it up. All the best.`,
  },
  broker: {
    basis: 'campaign:renewal-2026-broker',
    email_subject: 'your 2021 fundings',
    email_body:
`Your 2021 fundings come up for renewal this year and your software already flags them for you. The realtor who referred each of those files never hears about it, even though it is the moment their client decides whether to move.

I build small tools for brokerages like yours that send that renewal heads-up to the referring agent a few months out, with the note already drafted, so the referral relationship gets something back.

Is that something you do by hand today, or does it just not happen?`,
    followup_subject: 're: your 2021 fundings',
    followup_body:
`Quick one on the note below. If your referring agents already get a heads-up at renewal, a one-word no is a fine answer. If they do not, I can show you what the note to them would look like.`,
    followup2_subject: 're: your 2021 fundings',
    followup2_body:
`Last one from me. If looping your referral partners in at renewal ever becomes worth a look, reply and I will pick it up. All the best.`,
  },
};

const variantFor = l => (/mortgage/i.test(l.industry) ? 'broker' : 'realtor');

// The pool: queued at any step, or finished the old sequence without a word back. Out: the one
// who said no, everyone who replied, bounces, paused, generic inboxes.
function inPool(l) {
  if (!l.email || NEVER.has(String(l.email).toLowerCase())) return false;
  if (l.email_quality === 'generic') return false;
  if (!isCanadian(l)) return false;
  if (l.status === 'queued') return true;
  if (l.status === 'dont_contact') {
    const n = String(l.notes || '');
    if (/replied|said no|unsubscribe|opt/i.test(n)) return false;
    return n.trim() === '' || /Recovered from isFollowup bug/.test(n);
  }
  return false;
}

function scheduleFor(l, now) {
  if (!l.last_sent_at) return now;
  const earliest = new Date(new Date(l.last_sent_at).getTime() + GAP_DAYS * 864e5);
  return earliest > now ? earliest : now;
}

async function snapshot() {
  const client = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const name = `leads_backup_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  await client.query(`CREATE TABLE IF NOT EXISTS ${name} AS TABLE leads`);
  const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${name}`);
  await client.end();
  console.log(`Snapshot: ${name} (${rows[0].n} rows)`);
}

(async () => {
  let all = [], from = 0;
  while (true) {
    const { data, error } = await supabase.from('leads')
      .select('id, business_name, industry, city, email, email_quality, status, sequence_step, last_sent_at, qualification_score, notes, personalization_basis')
      .in('industry', INDUSTRIES).range(from, from + 999);
    if (error) throw new Error(error.message);
    all = all.concat(data); if (data.length < 1000) break; from += 1000;
  }
  const pool = all.filter(inPool);
  const already = pool.filter(l => /^campaign:renewal-2026/.test(l.personalization_basis || ''));
  const todo = pool.filter(l => !/^campaign:/.test(l.personalization_basis || ''));  // never overwrite another hand-set campaign
  const now = new Date();

  const by = (arr, k) => arr.reduce((m, l) => (m[k(l)] = (m[k(l)] || 0) + 1, m), {});
  console.log(`${all.length} real-estate/mortgage leads, ${pool.length} in the Canadian pool, ${already.length} already on renewal copy, ${todo.length} to write.`);
  console.log('variant:', by(todo, variantFor));
  console.log('was:', by(todo, l => `${l.status}/${l.sequence_step}`));
  const dated = todo.map(l => scheduleFor(l, now));
  console.log(`send dates: ${dated.filter(d => d <= now).length} ready now, ${dated.filter(d => d > now).length} held for the ${GAP_DAYS}-day gap, latest ${dated.sort((a, b) => a - b).pop()?.toISOString().slice(0, 10)}`);
  console.log('excluded from the Canadian pool:', by(all.filter(l => isCanadian(l) && !inPool(l)), l => l.status + (l.email_quality === 'generic' ? '/generic' : '')));
  console.log(`US leads left untouched: ${all.filter(l => US_STATE.test(l.city || '')).length}`);

  if (!APPLY) {
    for (const v of ['realtor', 'broker']) {
      const s = todo.find(l => variantFor(l) === v);
      if (!s) continue;
      console.log(`\n── ${v} sample: ${s.business_name} (${s.city}) ──\nSubject: ${COPY[v].email_subject}\n\n${COPY[v].email_body}\n`);
    }
    console.log('Dry run. Re-run with --apply to write.');
    process.exit(0);
  }

  await snapshot();
  let n = 0, failed = 0;
  for (const l of todo) {
    const v = COPY[variantFor(l)];
    const stamp = now.toISOString().slice(0, 10);
    const note = `renewal-2026: restarted ${stamp} (was ${l.status}/${l.sequence_step}, score ${l.qualification_score})`;
    const patch = {
      email_subject: v.email_subject, email_body: v.email_body,
      followup_subject: v.followup_subject, followup_body: v.followup_body,
      followup2_subject: v.followup2_subject, followup2_body: v.followup2_body,
      personalization_basis: v.basis,
      status: 'queued', sequence_step: 0,
      scheduled_send_at: scheduleFor(l, now).toISOString(),
      qualification_score: 10,
      notes: l.notes && l.notes.trim() ? `${l.notes} | ${note}` : note,
    };
    const { error } = await supabase.from('leads').update(patch).eq('id', l.id);
    if (error) { failed++; console.log(`FAILED ${l.business_name}: ${error.message}`); } else n++;
  }
  console.log(`\nWrote ${n}, failed ${failed}.`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e.message); process.exit(1); });
