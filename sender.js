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

// Daily send budget is enforced HERE (not in personalizer) so a high-score
// lead found today goes out next send, not a month behind the backlog.
const DAILY_CAP = parseInt(process.env.DAILY_CAP || '30', 10);
// Follow-ups go out first (time-sensitive) but never take more than this share
// of the daily cap, so new leads always keep at least the rest. Leaned toward
// new leads (0.3) while the fresh-lead backlog drains; raise toward 0.5 once
// initials and follow-ups are balanced again. Env-overridable.
const FOLLOWUP_MAX_SHARE = parseFloat(process.env.FOLLOWUP_MAX_SHARE || '0.3');

// Start of "today" in Vancouver, as an ISO timestamp, for counting today's sends.
// Last-line guard against malformed / scraper-artifact emails reaching Resend.
// Returns a reason string if the address looks unsafe to send, else null.
function emailRisk(email) {
  const e = (email || '').trim();
  // Hard format check (also catches whitespace, commas, multiple addresses, junk).
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return 'malformed';
  const [local, domain] = e.toLowerCase().split('@');
  // Leading digits glued to letters: "8011carol@", "604info@" — scraper artifact.
  if (/^\d{2,}[a-z]/.test(local)) return 'digit-prefix artifact';
  // Role/label words concatenated to a name with no separator: "corporationpam",
  // "emailmatt", "phonejohn" — a word ran into the address during scraping.
  if (/^(corporation|email|phone|fax|tel|contact|info|office|mailto|address|hours|monday|tuesday|wednesday|thursday|friday)[a-z]{3,}/.test(local)) {
    return 'concatenated-word artifact';
  }
  // A mailbox word with 1-3 junk letters stuck to the front: "ushello@" (us+hello),
  // "ninfo@" (n+info), "drhello@" — from scraping "contact us hello@" etc. Flag
  // when a known mailbox word sits at position 1-3 but the local doesn't simply
  // START with that word (so clean "info@"/"hello@" are left alone).
  var roleWord = '(info|hello|contact|sales|admin|office|enquir|inquir|support|reception|booking|mail|us)';
  if (new RegExp('^[a-z]{1,3}' + roleWord).test(local) && !new RegExp('^' + roleWord).test(local)) {
    return 'glued role-word artifact';
  }
  // Absurdly long local part (concatenated text blob).
  if (local.length > 40) return 'over-long local part';
  // URL-encoded junk ("%20jnsandhu@") — percent has no business in a real address.
  if (local.includes('%')) return 'url-encoded artifact';
  // Phone number glued to the front ("583-6000e-mailinfo@").
  if (/^\d{3}[-.]\d{3,4}/.test(local)) return 'phone-prefix artifact';
  // The word "e-mail" embedded in the local part — scrape label residue.
  if (/e-?mail/.test(local) && local.length > 8) return 'email-label artifact';
  // Known web-vendor/theme domains scraped from site templates, never the business.
  if (/^(qodeinteractive\.com|example\.com|sentry\.io|wixpress\.com|godaddy\.com|domain\.com|yourdomain\.com|email\.com|sentry\.wixpress\.com)$/.test(domain)) {
    return 'template-vendor domain';
  }
  return null;
}

// Pick the best landing page for a lead. Insurance brokerages get the vertical
// page built for them; everyone else gets the general interactive demos.
function landingFor(industry, leadId) {
  const i = industry || '';
  let page = 'demo.html';
  if (/insurance/i.test(i)) page = 'insurance.html';
  else if (/mortgage|lending/i.test(i)) page = 'mortgage.html';
  else if (/real estate|realtor|realty/i.test(i)) page = 'realestate.html';
  return `https://aevon.ca/${page}?ref=${leadId}`;
}

function vancouverDayStartISO() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const g = t => parts.find(p => p.type === t).value;
  // Vancouver midnight expressed in UTC. PST=UTC-8, PDT=UTC-7; use the offset
  // implied by comparing the wall date — simplest robust approach: build a Date
  // for that wall-clock midnight in the zone via a known-good formatter round-trip.
  const ymd = `${g('year')}-${g('month')}-${g('day')}`;
  // Find the UTC instant whose Vancouver date is ymd and time is 00:00.
  for (let h = 6; h <= 9; h++) { // PST/PDT are UTC+7/8; midnight Van = 07:00 or 08:00 UTC
    const guess = new Date(`${ymd}T0${h}:00:00.000Z`);
    const vanWall = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', hour: '2-digit', hour12: false }).format(guess);
    if (vanWall === '00') return guess.toISOString();
  }
  return new Date(`${ymd}T08:00:00.000Z`).toISOString();
}

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
function toHtml(text, leadId, industry) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Make bare https URLs in the body clickable (e.g. the {{DEMO}} link the
  // sender substitutes into follow-ups). Plain-text version keeps the raw URL.
  const linked = escaped.replace(/(https?:\/\/[^\s<]+)/g,
    '<a href="$1" style="color:#5254cc">$1</a>');

  const paragraphs = linked
    .split(/\n\n+/)
    .map(p => `<p style="margin:0 0 14px 0">${p.replace(/\n/g, '<br>')}</p>`)
    .join('');

  // Clean link to the real site, tagged so a visit is attributed to this lead.
  // Not a redirect/masked link — just aevon.ca with a query param — so it carries
  // no deliverability risk while letting us see who was interested enough to look.
  const siteUrl = leadId ? landingFor(industry, leadId) : 'https://aevon.ca/demo.html';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0">
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:14px;line-height:1.5;color:#222222">
    ${paragraphs}
    <table cellpadding="0" cellspacing="0" style="margin-top:18px">
      <tr>
        <td style="padding-right:12px;vertical-align:middle">
          <img src="https://aevon.ca/logo.svg" width="38" height="38" alt="Aevon" style="display:block;border-radius:8px">
        </td>
        <td style="vertical-align:middle">
          <div style="font-size:14px;font-weight:700;color:#1a1a1a">Aidan Cox</div>
          <div style="font-size:12px;color:#666666;margin-top:2px">
            <a href="${siteUrl}" style="color:#666666;text-decoration:none">aevon.ca</a>
            &nbsp;&middot;&nbsp;
            <a href="mailto:aidan@aevon.ca" style="color:#666666;text-decoration:none">aidan@aevon.ca</a>
            &nbsp;&middot;&nbsp;
            <a href="https://calendar.app.google/7R7srDKzWrvmLQg37" style="color:#666666;text-decoration:none">Book a call</a>
          </div>
        </td>
      </tr>
    </table>
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

  // How many already went out today (across all hourly runs)? Enforce the cap.
  const dayStart = vancouverDayStartISO();
  const { count: sentToday } = await supabase
    .from('email_events')
    .select('id', { count: 'exact', head: true })
    .eq('event_type', 'sent')
    .gte('created_at', dayStart);

  const remaining = DAILY_CAP - (sentToday || 0);
  if (remaining <= 0) {
    console.log(`Daily cap reached (${sentToday}/${DAILY_CAP} sent today). Done.`);
    return;
  }

  const cols = 'id, business_name, email, email_subject, email_body, followup_subject, followup_body, followup2_subject, followup2_body, sequence_step, qualification_score, scheduled_send_at, industry';
  const baseFilter = q => q
    .eq('status', 'queued')
    .not('email_subject', 'is', null)
    .not('email', 'is', null)
    .lte('scheduled_send_at', now);

  // Follow-ups (sequence_step 1 = 2nd email, 2 = 3rd/final): time-sensitive,
  // sent first, oldest scheduled first.
  const { data: followups, error: fErr } = await baseFilter(
    supabase.from('leads').select(cols).in('sequence_step', [1, 2])
  ).order('scheduled_send_at', { ascending: true }).limit(DAILY_CAP);
  if (fErr) throw new Error(`Supabase fetch (followups) failed: ${fErr.message}`);

  // New leads (sequence_step = 0): highest score first, then oldest in queue.
  // Fetch a larger pool than the cap so we can re-tier named contacts ahead of
  // role inboxes in JS without the DB's score-only limit cutting them off.
  const { data: initialsPool, error: iErr } = await baseFilter(
    supabase.from('leads').select(cols).eq('sequence_step', 0)
  ).order('qualification_score', { ascending: false, nullsFirst: false })
   .order('scheduled_send_at', { ascending: true }).limit(Math.max(DAILY_CAP * 6, 120));
  if (iErr) throw new Error(`Supabase fetch (initials) failed: ${iErr.message}`);

  // Prefer a real person's inbox over a generic role/catch-all box. Decision-
  // makers don't read info@/contact@/sales@, so a named contact at a slightly
  // lower score is a better send than a high-score role inbox. Stable partition
  // keeps score order within each tier (pool already arrived score-sorted).
  const ROLE_INBOXES = new Set([
    'info', 'contact', 'contactus', 'contact-us', 'hello', 'hi', 'office',
    'general', 'inquiries', 'enquiries', 'admin', 'sales', 'support', 'team',
    'reception', 'accounts', 'account', 'mail', 'email', 'service',
    'customerservice', 'help', 'marketing', 'connect', 'careers', 'jobs', 'hr',
    'billing', 'orders', 'booking', 'bookings', 'reservations', 'quotes',
    'quote', 'customs', 'foodbank', 'sold', 'noreply', 'no-reply'
  ]);
  const isRoleInbox = email => {
    const local = String(email || '').split('@')[0].toLowerCase().replace(/[._-]?\d+$/, '');
    return ROLE_INBOXES.has(local) || ROLE_INBOXES.has(local.replace(/[._-]/g, ''));
  };
  const named = (initialsPool || []).filter(l => !isRoleInbox(l.email));
  const role  = (initialsPool || []).filter(l =>  isRoleInbox(l.email));
  const initials = [...named, ...role];

  // Budget: follow-ups capped at half the cap; unused slots roll to new leads,
  // and unused new-lead slots roll back to follow-ups — never exceed `remaining`.
  const followupBudget = Math.min(followups?.length || 0, Math.ceil(DAILY_CAP * FOLLOWUP_MAX_SHARE));
  const pickedFollowups = (followups || []).slice(0, followupBudget);
  const initialBudget = Math.max(0, remaining - pickedFollowups.length);
  const pickedInitials = (initials || []).slice(0, initialBudget);
  // If new leads didn't use their full share, let extra follow-ups fill the gap.
  let due = [...pickedFollowups, ...pickedInitials];
  if (due.length < remaining) {
    const extra = (followups || []).slice(pickedFollowups.length, pickedFollowups.length + (remaining - due.length));
    due = [...pickedFollowups, ...extra, ...pickedInitials];
  }
  due = due.slice(0, remaining);

  if (due.length === 0) {
    console.log('No emails due right now.');
    return;
  }

  // Safety net: never email anyone who has already replied with real human
  // intent, even if the reply-processor couldn't match it, hasn't run yet this
  // hour, or the lead's status wasn't updated. A logged 'replied' event is
  // ground truth and closes the timing gap between the hourly reply-processor
  // and this hourly sender.
  // EXCEPTION: a pure out-of-office (intent 'auto_reply') is NOT a real reply —
  // those leads should still get their follow-up once they're back.
  const dueIds = due.map(l => l.id);
  const { data: repliedRows } = await supabase
    .from('email_events')
    .select('lead_id, metadata')
    .eq('event_type', 'replied')
    .in('lead_id', dueIds);
  const repliedSet = new Set(
    (repliedRows || [])
      .filter(r => (r.metadata?.intent || r.metadata?.outcome || 'replied') !== 'auto_reply')
      .map(r => r.lead_id)
  );
  if (repliedSet.size) {
    const before = due.length;
    due = due.filter(l => !repliedSet.has(l.id));
    console.log(`Skipped ${before - due.length} lead(s) who already replied (safety net).`);
    // Clear their queue state so they stop showing as due in future runs.
    await supabase.from('leads')
      .update({ scheduled_send_at: null })
      .in('id', [...repliedSet])
      .eq('status', 'queued');
  }

  if (due.length === 0) {
    console.log('No emails due after reply filter.');
    return;
  }

  console.log(`Sending ${due.length} email(s) — ${pickedFollowups.length} follow-up, ${pickedInitials.length} new | ${sentToday || 0}/${DAILY_CAP} already sent today.\n`);

  let sent = 0;
  let failed = 0;

  for (const lead of due) {
    const step = lead.sequence_step;
    const subject = step === 2 ? lead.followup2_subject : step === 1 ? lead.followup_subject : lead.email_subject;
    let body = step === 2 ? lead.followup2_body : step === 1 ? lead.followup_body : lead.email_body;

    if (!subject || !body) {
      // No copy for this step (e.g. an older lead with no 3rd-email text). End
      // the sequence cleanly so it isn't re-fetched and skipped every run.
      if (step >= 1) {
        await supabase.from('leads').update({ status: 'dont_contact', scheduled_send_at: null }).eq('id', lead.id);
      }
      continue;
    }

    // Replace the {{DEMO}} token (follow-ups) with a clean, ref-tagged link to
    // the interactive demo page. Done at send time because the ref is the lead id.
    const demoUrl = landingFor(lead.industry, lead.id);
    body = body.replace(/\{\{DEMO\}\}/g, demoUrl);

    process.stdout.write(`  [${step === 0 ? 'email' : 'followup ' + step}] ${lead.business_name} <${lead.email}>... `);

    // Pre-send validation: never hand a malformed/artifact address to Resend.
    // A bounce hurts the young domain more than skipping does. Park it for review.
    const risk = emailRisk(lead.email);
    if (risk) {
      console.log(`SKIPPED (${risk})`);
      await supabase.from('leads').update({
        status: 'paused',
        scheduled_send_at: null,
        notes: `Held by sender: email looks invalid (${risk}). Needs a valid address.`,
      }).eq('id', lead.id);
      failed++;
      continue;
    }

    try {
      const { data: sendData, error: sendError } = await resend.emails.send({
        from: `${FROM_NAME} <${FROM}>`,
        reply_to: 'aidan@aevon.ca',
        to: lead.email,
        subject,
        text: body,
        html: toHtml(body, lead.id, lead.industry),
      });

      if (sendError) throw new Error(sendError.message);

      const resendId = sendData?.id;
      const nextStep = lead.sequence_step + 1;
      const isLastStep = nextStep >= 3;

      const update = {
        sequence_step: nextStep,
        last_sent_at: now,
        status: isLastStep ? 'dont_contact' : 'queued',
        scheduled_send_at: isLastStep
          ? null
          : new Date(Date.now() + FOLLOWUP_DELAY_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      };

      if (resendId) {
        update[step === 0 ? 'resend_email_id' : 'resend_followup_id'] = resendId;
      }

      await supabase.from('leads').update(update).eq('id', lead.id);

      // Log the send event
      if (resendId) {
        await supabase.from('email_events').insert({
          lead_id: lead.id,
          resend_email_id: resendId,
          event_type: 'sent',
          metadata: { subject, step, is_followup: step > 0 },
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
