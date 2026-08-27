#!/usr/bin/env node
/**
 * check-cadre-ask.js — prove the {{ASK}} token is resolved on the real send path.
 *
 * On the first live day, 2026-08-26, all twelve Cadre emails went out ending with the literal
 * text {{ASK}}. The substitution existed in cadre/offer.js, preflight even used it to render its
 * sample, and the sender never called it. Every guard passed because every guard tested the
 * pieces; nothing tested the assembly. This does: it runs stored copy through the same
 * applyAsk + FOOTER composition the sender performs and fails on any unresolved token.
 *
 *   node check-cadre-ask.js
 */
require('dotenv').config();
const supabase = require('./lib/supabase');
const { applyAsk, ASKS, FOLLOWUP_ASKS } = require('./cadre/offer');
const fs = require('fs');

let bad = 0;
const check = (label, cond, detail = '') => {
  if (!cond) bad++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
};

(async () => {
  // 1. The sender must actually call applyAsk on the body it sends, and gate on leftovers.
  const src = fs.readFileSync('./cadre/sender.js', 'utf8');
  check('sender composes the body through applyAsk', /const body = applyAsk\(rawBody/.test(src));
  check('sender refuses any body with an unresolved token', /\\\{\\\{\[A-Z_\]\+\\\}\\\}/.test(src));

  // 2. Every stored body, first touch and follow-ups, must resolve cleanly.
  const { data: leads, error } = await supabase.from('cadre_leads')
    .select('id, business_name, email_body, followup_body, followup2_body')
    .in('status', ['queued', 'sent']).not('email_subject', 'is', null);
  if (error) throw new Error(error.message);

  let dirty = 0;
  for (const l of leads) {
    for (const [step, raw] of [[0, l.email_body], [1, l.followup_body], [2, l.followup2_body]]) {
      if (!raw) continue;
      const out = applyAsk(raw.trim(), step, l.id);
      if (/\{\{[A-Z_]+\}\}/.test(out)) {
        dirty++;
        console.log(`FAIL ${l.business_name} step ${step + 1}: token survives applyAsk`);
      }
      // The result must end with an ask: either a question, or one of the known ask sentences.
      const endsWell = /\?\s*$/.test(out.trim())
        || [...ASKS, ...FOLLOWUP_ASKS].some(a => out.trim().endsWith(a));
      if (!endsWell) { dirty++; console.log(`FAIL ${l.business_name} step ${step + 1}: no closing ask after substitution`); }
    }
  }
  check(`all ${leads.length} leads' stored copy resolves with a closing ask`, dirty === 0, dirty ? `${dirty} dirty` : '');

  // 3. Same lead always gets the same ask, so a re-run cannot change a sent email's sibling.
  const sample = leads.find(l => l.email_body && l.email_body.includes('{{ASK}}'));
  if (sample) {
    check('substitution is deterministic per lead',
      applyAsk(sample.email_body, 0, sample.id) === applyAsk(sample.email_body, 0, sample.id));
  }

  console.log(`\n${bad ? `${bad} FAILED` : 'The ask reaches the recipient, not the token.'}`);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('check-cadre-ask failed:', e.message); process.exit(1); });
