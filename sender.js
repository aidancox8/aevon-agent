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

// ── Send-day guard ────────────────────────────────────────────────

function getVancouverDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Vancouver',
    year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short',
  }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type).value;
  return {
    y: parseInt(get('year')),
    m: parseInt(get('month')),
    d: parseInt(get('day')),
    weekday: get('weekday'), // 'Sun','Mon',...,'Sat'
  };
}

function getEaster(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m2 = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m2 + 114) / 31);
  const day = ((h + l - 7 * m2 + 114) % 31) + 1;
  return { m: month, d: day };
}

function firstMonday(y, m) {
  const date = new Date(y, m - 1, 1);
  while (date.getDay() !== 1) date.setDate(date.getDate() + 1);
  return date.getDate();
}

function isBCHoliday({ y, m, d }) {
  // Fixed
  if (m === 1  && d === 1)  return true; // New Year's Day
  if (m === 7  && d === 1)  return true; // Canada Day
  if (m === 9  && d === 30) return true; // National Day for Truth and Reconciliation
  if (m === 11 && d === 11) return true; // Remembrance Day
  if (m === 12 && d === 25) return true; // Christmas Day
  if (m === 12 && d === 26) return true; // Boxing Day

  // Family Day: 3rd Monday of February
  if (m === 2 && d === firstMonday(y, 2) + 14) return true;

  // Good Friday: 2 days before Easter
  const easter = getEaster(y);
  const gfDate = new Date(y, easter.m - 1, easter.d - 2);
  if (m === gfDate.getMonth() + 1 && d === gfDate.getDate()) return true;

  // Victoria Day: last Monday on or before May 24
  if (m === 5) {
    const may24 = new Date(y, 4, 24);
    while (may24.getDay() !== 1) may24.setDate(may24.getDate() - 1);
    if (d === may24.getDate()) return true;
  }

  // BC Day: 1st Monday of August
  if (m === 8  && d === firstMonday(y, 8))  return true;

  // Labour Day: 1st Monday of September
  if (m === 9  && d === firstMonday(y, 9))  return true;

  // Thanksgiving: 2nd Monday of October
  if (m === 10 && d === firstMonday(y, 10) + 7) return true;

  return false;
}

function isSendableDay() {
  const van = getVancouverDate();
  if (van.weekday === 'Sat' || van.weekday === 'Sun') return { ok: false, reason: 'weekend' };
  if (isBCHoliday(van)) return { ok: false, reason: 'BC statutory holiday' };
  return { ok: true };
}

// Plain, left-aligned personal email. No card/wrapper/hero image — a marketing
// template look is the #1 "this was sent by a bot" tell. Mirrors how a person
// actually types a 1:1 email, with a simple text signature.
function toHtml(text) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const paragraphs = escaped
    .split(/\n\n+/)
    .map(p => `<p style="margin:0 0 14px 0">${p.replace(/\n/g, '<br>')}</p>`)
    .join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0">
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:14px;line-height:1.5;color:#222222">
    ${paragraphs}
    <p style="margin:14px 0 0 0">Aidan Cox<br>
    Aevon<br>
    <a href="https://calendar.app.google/7R7srDKzWrvmLQg37" style="color:#1155cc">Book a call</a></p>
  </div>
</body>
</html>`;
}

async function run() {
  const sendable = isSendableDay();
  if (!sendable.ok) {
    console.log(`Skipping — today is a ${sendable.reason}.`);
    return;
  }

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
        reply_to: 'aidan@aevon.ca',
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
        status: isLastStep ? 'dont_contact' : 'queued',
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
      const isPermanent = /invalid|not found|unsubscribed|bounced/i.test(msg) || err?.statusCode === 422;
      const newStatus = isPermanent ? 'bounced' : 'error';
      console.log(`FAILED (${newStatus}): ${msg}`);
      try {
        await supabase.from('leads').update({ status: newStatus, notes: msg }).eq('id', lead.id);
        await supabase.from('email_events').insert({
          lead_id: lead.id,
          event_type: newStatus,
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
