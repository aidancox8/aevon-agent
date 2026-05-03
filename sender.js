/**
 * sender.js
 * Sends due emails via Resend (HTML format with open/click tracking),
 * stores Resend email IDs for webhook correlation, updates lead state.
 */

require('dotenv').config();
const { Resend } = require('resend');
const supabase = require('./lib/supabase');

const resend = new Resend(process.env.RESEND_API_KEY);

const FROM = process.env.FROM_EMAIL || 'onboarding@resend.dev';
const FROM_NAME = 'Aidan from Aevon';
const FOLLOWUP_DELAY_DAYS = 5;

function toHtml(text) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const paragraphs = escaped
    .split(/\n\n+/)
    .map(p => `<p style="margin:0 0 16px 0;line-height:1.6">${p.replace(/\n/g, '<br>')}</p>`)
    .join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9f9f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;padding:40px 20px">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;padding:40px;max-width:600px">
        <tr><td style="font-size:15px;color:#1a1a1a">
          ${paragraphs}
          <hr style="border:none;border-top:1px solid #e5e5e5;margin:32px 0">
          <p style="margin:0;font-size:12px;color:#999">
            Aevon &middot; Lower Mainland, BC &middot;
            <a href="https://aevon.ca" style="color:#6366F1;text-decoration:none">aevon.ca</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function run() {
  const now = new Date().toISOString();

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

    if (!subject || !body) continue;

    process.stdout.write(`  [${isFollowup ? 'followup' : 'email'}] ${lead.business_name} <${lead.email}>... `);

    try {
      const { data: sendData, error: sendError } = await resend.emails.send({
        from: `${FROM_NAME} <${FROM}>`,
        to: lead.email,
        subject,
        text: body,
        html: toHtml(body),
      });

      if (sendError) throw new Error(sendError.message);

      const resendId = sendData?.id;
      const nextStep = lead.sequence_step + 1;
      const isLastStep = nextStep >= 2;

      const update = {
        sequence_step: nextStep,
        last_sent_at: now,
        status: isLastStep ? 'sent' : 'queued',
        scheduled_send_at: isLastStep
          ? null
          : new Date(Date.now() + FOLLOWUP_DELAY_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      };

      if (resendId) {
        update[isFollowup ? 'resend_followup_id' : 'resend_email_id'] = resendId;
      }

      await supabase.from('leads').update(update).eq('id', lead.id);

      // Log the send event
      if (resendId) {
        await supabase.from('email_events').insert({
          lead_id: lead.id,
          resend_email_id: resendId,
          event_type: 'sent',
          metadata: { subject, is_followup: isFollowup },
        });
      }

      console.log(isLastStep ? 'done (sequence complete)' : `followup in ${FOLLOWUP_DELAY_DAYS}d`);
      sent++;
      await new Promise(r => setTimeout(r, 500));

    } catch (err) {
      const msg = err?.message || String(err);
      console.log(`FAILED: ${msg}`);
      try {
        await supabase.from('leads').update({ status: 'bounced', notes: msg }).eq('id', lead.id);
        await supabase.from('email_events').insert({
          lead_id: lead.id,
          event_type: 'bounced',
          metadata: { error: msg },
        });
      } catch (dbErr) {
        console.error(`  Could not log failure to Supabase: ${dbErr.message}`);
      }
      failed++;
    }
  }

  console.log(`\nDone. Sent: ${sent} | Failed: ${failed}`);
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
