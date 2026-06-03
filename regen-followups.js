/**
 * regen-followups.js
 * Rewrites the follow-up (email 2) copy for leads whose initial email already
 * sent (sequence_step = 1, status queued) using the improved follow-up style:
 * a different angle than email 1, offering a small concrete thing (a 2-min
 * example) rather than re-asking the same question.
 *
 * Only touches followup_subject / followup_body. Does not change schedule,
 * status, or the already-sent initial email.
 *
 * Usage: node regen-followups.js [--limit N]
 */

require('dotenv').config();
const supabase = require('./lib/supabase');
const { createGenerate } = require('./lib/gemini');
const generate = createGenerate(process.env.GEMINI_API_KEY);

const MIN_GAP = 4200;
let last = 0;
async function rl(p) {
  const gap = Date.now() - last;
  if (gap < MIN_GAP) await new Promise(r => setTimeout(r, MIN_GAP - gap));
  last = Date.now();
  return generate(p);
}

function prompt(lead) {
  return `You are Aidan from Aevon (custom software + AI agents for Lower Mainland BC businesses with repetitive manual work). You already sent this business a first cold email and got no reply. Write a SHORT follow-up.

Business: ${lead.business_name} (${lead.industry || 'unknown'})
Your first email said (subject): "${lead.email_subject}"
First email body: "${lead.email_body}"

Write a follow-up that:
- Is under 45 words, plain and human, first person.
- Takes a DIFFERENT angle than the first email — do not just repeat or "bump" it.
- Instead of re-asking, point them to a quick interactive example. End with a sentence like "I put together a couple of quick interactive examples of what I mean — worth a look: {{DEMO}}" and you MUST include the exact token {{DEMO}} where the link goes (replaced with a real tracked link at send time).
- No other pitch, no buzzwords, no em dashes, no "just circling back" / "bumping this".
- No sign-off (signature is added separately).
- Subject: brief, reply-thread style (can reuse "Re: ..." of the original).

Respond with JSON only:
{ "followup_subject": "...", "followup_body": "..." }`;
}

async function run() {
  const args = process.argv.slice(2);
  let limit = null;
  for (let i = 0; i < args.length; i++) if (args[i] === '--limit') limit = parseInt(args[++i], 10);

  let q = supabase.from('leads')
    .select('id, business_name, industry, email_subject, email_body, followup_subject')
    .eq('status', 'queued').eq('sequence_step', 1)
    .not('email_subject', 'is', null);
  if (limit) q = q.limit(limit);
  const { data: leads, error } = await q;
  if (error) throw new Error(error.message);
  if (!leads || !leads.length) { console.log('No pending follow-ups to regenerate.'); return; }

  console.log(`Regenerating ${leads.length} follow-up(s)...\n`);
  let ok = 0, fail = 0;
  for (const lead of leads) {
    process.stdout.write(`  [${lead.business_name}]... `);
    try {
      const raw = await rl(prompt(lead));
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('no JSON');
      const c = JSON.parse(m[0]);
      if (!c.followup_body) throw new Error('missing body');
      await supabase.from('leads').update({
        followup_subject: c.followup_subject || lead.followup_subject,
        followup_body: c.followup_body,
      }).eq('id', lead.id);
      console.log('done');
      ok++;
    } catch (e) { console.log('FAILED: ' + e.message); fail++; }
  }
  console.log(`\nDone. Rewritten: ${ok} | Failed: ${fail}`);
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
