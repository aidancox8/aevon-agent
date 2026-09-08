#!/usr/bin/env node
/**
 * cadre/followups-5.js, the touch-2 that asks where the REST of the HR records live.
 *
 * Touch 1 asks one thing, how they track certification renewals, because it quotes a
 * certification line from their own ad and anything wider read as a non sequitur (rewrite of
 * 2026-09-02). Touch 2 is where a different question belongs. This one names the incumbent:
 * SharePoint, or the payroll system's HR module, which is what most 50 to 1,000 staff companies
 * actually use for onboarding paperwork, signed policies and reviews. It is answerable with
 * "SharePoint, and it is fine", and either answer tells us their stack. Approved by Aidan
 * 2026-09-08.
 *
 * Applies to every lead whose touch 2 has not gone out and whose copy is not locked. Hand-written
 * follow-ups are locked (cadre/followups*.js run before copy_locked existed were locked after),
 * so this replaces generated touch-2 copy only. Touch 3 is filled in where it is missing, with
 * the same close-out shape as the hand-written set.
 *
 *   node cadre/followups-5.js --dry
 *   node cadre/followups-5.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const supabase = require('../lib/supabase');

const DRY = process.argv.includes('--dry');

function touch2(first) {
  return `Hi ${first || 'there'},

Different question, since the renewals one may not have landed.

Where do the rest of the HR records live today, SharePoint, the payroll system's HR module, or a mix? Onboarding paperwork, signed policies, reviews.

Asking because Cadre keeps all of it on one record per person, and the payroll HR add-ons charge per head for about half of that.

{{ASK}}`;
}

function touch3(first) {
  return `Hi ${first || 'there'},

Last one from me on this.

If the records are already handled, or it is simply not this year's problem, no reply needed and I will leave it there.

If it is worth a look in a few months, say so and I will come back then.`;
}

/** Same rules as cadre/followups-4.js. */
function reject(body) {
  const words = body.trim().split(/\s+/).length;
  if (words > 90) return `${words} words, too long for a follow-up`;
  if (/\bcircl(e|ing) back|following up|bumping this|touching base|per my last\b/i.test(body)) return 'contains a filler follow-up phrase';
  if (/\bour (clients|customers)\b|\bcompanies like\b|\bwe help \d/i.test(body)) return 'implies customers that do not exist';
  if (/\$|\bprice|\bpricing\b|\bper user\b/i.test(body)) return 'mentions price';
  if (/—/.test(body)) return 'contains an em dash';
  if (!/\n\n/.test(body)) return 'no paragraph breaks';
  return null;
}

(async () => {
  for (const [which, body] of [['touch 2', touch2('there')], ['touch 3', touch3('there')]]) {
    const why = reject(body);
    if (why) { console.error(`REJECT ${which}: ${why}`); process.exit(1); }
  }
  const { data, error } = await supabase.from('cadre_leads')
    .select('id, business_name, status, sequence_step, contact_name, followup_body, followup2_body')
    .eq('copy_locked', false)
    .in('status', ['queued', 'sent'])
    .lte('sequence_step', 1);
  if (error) throw new Error(error.message);

  let replaced = 0, filled = 0, t3 = 0;
  for (const l of data) {
    const first = (l.contact_name || '').trim().split(/\s+/)[0];
    const u = { followup_subject: 'follow-up', followup_body: touch2(first) };
    if (l.followup_body) replaced++; else filled++;
    if (!l.followup2_body) { u.followup2_subject = 'follow-up'; u.followup2_body = touch3(first); t3++; }
    if (DRY) continue;
    const { error: e } = await supabase.from('cadre_leads').update(u).eq('id', l.id).eq('copy_locked', false).lte('sequence_step', 1);
    if (e) console.error(`FAIL ${l.business_name}: ${e.message}`);
  }
  console.log(`${DRY ? 'Would write' : 'Wrote'} touch 2 on ${data.length} lead(s): ${replaced} replaced generated copy, ${filled} had none. Touch 3 filled on ${t3}.`);
  console.log(`\n${touch2('there')}\n`);
})().catch((e) => { console.error(e.message); process.exit(1); });
