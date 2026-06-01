/**
 * schedule-monday.js
 * Guarantees a full send day: pulls the highest-score, freshly-personalized
 * new leads forward to the next weekday 9am PT so the sender (cap 30/day) has
 * a full batch to send. Without this, personalizer dates leads for "next
 * weekday" generically and a run that finishes overnight could leave fewer
 * than 30 actually due.
 *
 * Schedules up to TARGET new leads. Follow-ups already due are untouched and
 * counted by the sender separately.
 */

require('dotenv').config();
const supabase = require('./lib/supabase');

const TARGET = parseInt(process.env.DAILY_CAP || '30', 10);

// Next weekday at 09:00 PT == 16:00 UTC (PDT). Good enough for scheduling.
function nextWeekday9amUTC() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(16, 0, 0, 0);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

async function run() {
  const when = nextWeekday9amUTC();

  // How many initials are ALREADY due on/before that slot? Don't over-schedule.
  const { count: alreadyDue } = await supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'queued').eq('sequence_step', 0)
    .not('email_subject', 'is', null)
    .lte('scheduled_send_at', when);

  const need = Math.max(0, TARGET - (alreadyDue || 0));
  if (need === 0) {
    console.log(`Already ${alreadyDue} initials due by ${when}. No scheduling needed.`);
    return;
  }

  // Pull the best-scoring personalized leads that are NOT yet due, forward.
  const { data: candidates, error } = await supabase
    .from('leads')
    .select('id, business_name, qualification_score, scheduled_send_at')
    .eq('status', 'queued').eq('sequence_step', 0)
    .not('email_subject', 'is', null)
    .gt('scheduled_send_at', when)
    .order('qualification_score', { ascending: false, nullsFirst: false })
    .limit(need);
  if (error) throw new Error(error.message);

  if (!candidates || !candidates.length) {
    console.log(`Wanted ${need} more, but no personalized leads available to pull forward. ${alreadyDue} will send.`);
    return;
  }

  const ids = candidates.map(c => c.id);
  const { error: upErr } = await supabase.from('leads').update({ scheduled_send_at: when }).in('id', ids);
  if (upErr) throw new Error(upErr.message);

  console.log(`Scheduled ${ids.length} top-score leads for ${when} (had ${alreadyDue} already due; target ${TARGET}).`);
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
