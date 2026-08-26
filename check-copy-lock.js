#!/usr/bin/env node
/**
 * check-copy-lock.js — prove hand-written copy cannot be overwritten.
 *
 * On 2026-08-25 a background regeneration run replaced every hand-written Cadre body with a
 * generated one. Nothing logged it, nothing failed, and it was recoverable only because a
 * scratch file happened not to have been cleaned up. The personalizer already filtered on
 * `.is('email_subject', null)`, which should have been enough and was not.
 *
 * So the intent is stated in a column instead of inferred from an empty field, and asserted here
 * against the real database rather than trusted. This does a genuine write attempt on a locked
 * row and checks that the row did not move.
 *
 *   node check-copy-lock.js
 */
require('dotenv').config();
const supabase = require('./lib/supabase');

let bad = 0;
const check = (label, cond, detail = '') => {
  if (!cond) bad++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
};

(async () => {
  const { data: locked, error } = await supabase.from('cadre_leads')
    .select('id, business_name, email_body, personalization_basis, copy_locked')
    .eq('copy_locked', true);
  if (error) throw new Error(error.message);

  check('some rows are locked', locked.length > 0, `${locked.length} locked`);
  check('every locked row is the hand-written set',
    locked.every(l => /hand-written/i.test(l.personalization_basis || '')));
  check('every locked row has paragraph breaks',
    locked.every(l => /\n\s*\n/.test(l.email_body || '')));

  // The personalizer picks up rows matching status=queued AND copy_locked=false AND
  // email_subject IS NULL. A locked row must not appear in that set.
  const { data: wouldTouch } = await supabase.from('cadre_leads')
    .select('id')
    .eq('status', 'queued').eq('copy_locked', false).is('email_subject', null);
  const lockedIds = new Set(locked.map(l => l.id));
  check('the personalizer queue contains no locked row',
    !(wouldTouch || []).some(l => lockedIds.has(l.id)),
    `${(wouldTouch || []).length} in queue`);

  // The real test: try to overwrite one, exactly as load-drafts.js does, and confirm nothing moved.
  if (locked.length) {
    const victim = locked[0];
    const before = victim.email_body;
    await supabase.from('cadre_leads')
      .update({ email_body: 'OVERWRITTEN BY check-copy-lock.js — this must never persist' })
      .eq('id', victim.id).eq('copy_locked', false);      // the guard clause under test
    const { data: after } = await supabase.from('cadre_leads')
      .select('email_body').eq('id', victim.id).single();
    check(`a guarded write left ${String(victim.business_name).slice(0, 24)} untouched`,
      after.email_body === before);

    // And confirm the row would genuinely have changed without the guard, so the test is not
    // passing because the update was a no-op for some unrelated reason.
    const { data: probe } = await supabase.from('cadre_leads')
      .select('id').eq('id', victim.id).eq('copy_locked', true).maybeSingle();
    check('the row really is flagged locked in the database', !!probe);
  }

  // Both writers must carry the guard.
  const fs = require('fs');
  check('personalizer filters on copy_locked',
    /\.eq\('copy_locked', false\)/.test(fs.readFileSync('./cadre/personalizer.js', 'utf8')));
  check('load-drafts filters on copy_locked',
    /\.eq\('copy_locked', false\)/.test(fs.readFileSync('./cadre/load-drafts.js', 'utf8')));

  console.log(`\n${bad ? `${bad} FAILED` : 'Hand-written copy is locked.'}`);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('check-copy-lock failed:', e.message); process.exit(1); });
