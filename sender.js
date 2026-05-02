/**
 * sender.js
 * Checks Supabase for leads due to be emailed, sends via Resend,
 * then updates the lead's sequence state.
 *
 * Run on a schedule (GitHub Actions cron, Mon-Fri business hours).
 * Safe to run multiple times - only processes leads where scheduled_send_at <= now.
 */

require('dotenv').config();
const { Resend } = require('resend');
const supabase = require('./lib/supabase');

const resend = new Resend(process.env.RESEND_API_KEY);

// Switch to hello@aevon.ca once domain is verified in Resend
const FROM = process.env.FROM_EMAIL || 'onboarding@resend.dev';
const FROM_NAME = 'Aidan from Aevon';

// Days to wait before sending follow-up
const FOLLOWUP_DELAY_DAYS = 5;

async function run() {
  const now = new Date().toISOString();

  // Fetch leads due to send (initial email not yet sent)
  const { data: due, error } = await supabase
    .from('leads')
    .select('id, business_name, email, email_subject, email_body, followup_subject, followup_body, sequence_step')
    .eq('status', 'queued')
    .not('email_subject', 'is', null)
    .not('email', 'is', null)
    .lte('scheduled_send_at', now)
    .order('scheduled_send_at', { ascending: true })
    .limit(50);

  if (error) throw new Error(`Supabase fetch failed: ${error.message}`);
  if (!due || due.length === 0) {
    console.log('No emails due right now.');
    return;
  }

  console.log(`Sending ${due.length} email(s)...\n`);

  let sent = 0;
  let failed = 0;

  for (const lead of due) {
    const isFollowup = lead.sequence_step === 1;
    const subject = isFollowup ? lead.followup_subject : lead.email_subject;
    const body = isFollowup ? lead.followup_body : lead.email_body;

    if (!subject || !body) {
      console.log(`  [skip] ${lead.business_name} - missing ${isFollowup ? 'followup' : 'email'} content`);
      continue;
    }

    process.stdout.write(`  [${isFollowup ? 'followup' : 'email'}] ${lead.business_name} <${lead.email}>... `);

    try {
      const { error: sendError } = await resend.emails.send({
        from: `${FROM_NAME} <${FROM}>`,
        to: lead.email,
        subject,
        text: body,
      });

      if (sendError) throw new Error(sendError.message);

      // Update lead state
      const nextStep = lead.sequence_step + 1;
      const isLastStep = nextStep >= 2; // 2 emails total

      const update = {
        sequence_step: nextStep,
        last_sent_at: now,
        status: isLastStep ? 'sent' : 'queued',
        scheduled_send_at: isLastStep
          ? null
          : new Date(Date.now() + FOLLOWUP_DELAY_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      };

      await supabase.from('leads').update(update).eq('id', lead.id);

      console.log(isLastStep ? 'done (sequence complete)' : `followup scheduled in ${FOLLOWUP_DELAY_DAYS} days`);
      sent++;

      // Brief delay between sends
      await new Promise(r => setTimeout(r, 500));

    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      await supabase.from('leads').update({ status: 'bounced', notes: err.message }).eq('id', lead.id);
      failed++;
    }
  }

  console.log(`\nDone. Sent: ${sent} | Failed: ${failed}`);
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
