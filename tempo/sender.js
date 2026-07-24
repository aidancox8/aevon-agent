/**
 * tempo/sender.js
 * Sends due Tempo campaign emails via Resend. Duplicate of the Aevon sender
 * pointed at tempo_leads / tempo_email_events, so the two campaigns never mix.
 *
 * SAFETY: OFF by default. Without --send (or TEMPO_SEND=1) it runs as a dry run
 * that only prints what WOULD go out. Turn it on only after pricing is set.
 *
 * Usage:
 *   node tempo/sender.js            # dry run — prints the send plan, sends nothing
 *   node tempo/sender.js --send     # actually send (respects cap + guards)
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Resend } = require('resend');
const dns = require('dns').promises;
try { dns.setServers(['8.8.8.8', '1.1.1.1']); } catch (e) {}
const supabase = require('../lib/supabase');
const { dncReason } = require('./dnc');

const TABLE = 'tempo_leads';
const EVENTS = 'tempo_email_events';
const LIVE = process.argv.includes('--send') || process.env.TEMPO_SEND === '1';

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.FROM_EMAIL || 'onboarding@resend.dev';
const FROM_NAME = 'Aidan from Aevon';
const FOLLOWUP_DELAY_DAYS = 5;
const DAILY_CAP = parseInt(process.env.TEMPO_DAILY_CAP || '20', 10);
const FOLLOWUP_MAX_SHARE = 0.4;
const DEMO_URL = 'https://clinic-scheduler-demo.web.app';

// ── shared guards (same logic as the Aevon sender) ──────────────────────────

const mxCache = new Map();
async function domainAcceptsMail(email) {
  const domain = (email.split('@')[1] || '').toLowerCase().trim();
  if (!domain) return false;
  if (mxCache.has(domain)) return mxCache.get(domain);
  let ok = true;
  try {
    const mx = await dns.resolveMx(domain);
    ok = Array.isArray(mx) && mx.some(r => r && r.exchange && r.exchange.trim());
  } catch (e) {
    ok = !(e.code === 'ENOTFOUND' || e.code === 'ENODATA');
  }
  mxCache.set(domain, ok);
  return ok;
}

function emailRisk(email) {
  const e = (email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return 'malformed';
  const [local, domain] = e.toLowerCase().split('@');
  if (/^\d{2,}[a-z]/.test(local)) return 'digit-prefix artifact';
  if (/^(corporation|email|phone|fax|tel|contact|info|office|mailto|address|hours)[a-z]{3,}/.test(local)) return 'concatenated-word artifact';
  if (/[a-z]+(reception|enquir|inquir|bookkeeping|customerservice|frontdesk|webmaster)/.test(local)) return 'glued label-word artifact';
  if (local.includes('/')) return 'url-in-address artifact';
  if (/\d{3}[-.]\d{3}/.test(local)) return 'embedded-phone artifact';
  if (local.length > 40) return 'over-long local part';
  if (e.includes('%')) return 'url-encoded artifact';
  if (/^(qodeinteractive\.com|example\.com|sentry\.io|wixpress\.com|yourdomain\.com)$/.test(domain)) return 'template-vendor domain';
  return null;
}

function getVancouverDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Vancouver',
    year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short',
  }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type).value;
  return { y: parseInt(get('year')), m: parseInt(get('month')), d: parseInt(get('day')), weekday: get('weekday') };
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
  if (m === 1 && d === 1) return true;
  if (m === 7 && d === 1) return true;
  if (m === 9 && d === 30) return true;
  if (m === 11 && d === 11) return true;
  if (m === 12 && d === 25) return true;
  if (m === 12 && d === 26) return true;
  if (m === 2 && d === firstMonday(y, 2) + 14) return true;
  const easter = getEaster(y);
  const gf = new Date(y, easter.m - 1, easter.d - 2);
  if (m === gf.getMonth() + 1 && d === gf.getDate()) return true;
  if (m === 5) {
    const may24 = new Date(y, 4, 24);
    while (may24.getDay() !== 1) may24.setDate(may24.getDate() - 1);
    if (d === may24.getDate()) return true;
  }
  if (m === 8 && d === firstMonday(y, 8)) return true;
  if (m === 9 && d === firstMonday(y, 9)) return true;
  if (m === 10 && d === firstMonday(y, 10) + 7) return true;
  return false;
}

function isSendableDay() {
  const van = getVancouverDate();
  if (van.weekday === 'Sat' || van.weekday === 'Sun') return { ok: false, reason: 'weekend' };
  if (isBCHoliday(van)) return { ok: false, reason: 'BC statutory holiday' };
  return { ok: true };
}

function vancouverDayStartISO() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const g = t => parts.find(p => p.type === t).value;
  const ymd = `${g('year')}-${g('month')}-${g('day')}`;
  for (let h = 6; h <= 9; h++) {
    const guess = new Date(`${ymd}T0${h}:00:00.000Z`);
    const vanWall = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', hour: '2-digit', hour12: false }).format(guess);
    if (vanWall === '00') return guess.toISOString();
  }
  return new Date(`${ymd}T08:00:00.000Z`).toISOString();
}

// Plain, left-aligned personal email — identical styling to the Aevon sender.
function toHtml(text) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Linkify bare https URLs AND the bare demo domain the personalizer writes as plain text.
  const linked = escaped
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#5254cc">$1</a>')
    // Bare demo domains (either demo world) written as plain text by the personalizer.
    .replace(/(^|[\s(])((?:allied|clinic)-scheduler-demo\.web\.app)/g, '$1<a href="https://$2" style="color:#5254cc">$2</a>');
  const paragraphs = linked.split(/\n\n+/).map(p => `<p style="margin:0 0 14px 0">${p.replace(/\n/g, '<br>')}</p>`).join('');
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0">
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:14px;line-height:1.5;color:#222222">
    ${paragraphs}
    <table cellpadding="0" cellspacing="0" style="margin-top:18px">
      <tr>
        <td style="padding-right:12px;vertical-align:middle">
          <img src="https://aevon.ca/logo-email.png" width="38" height="38" alt="Aevon" style="display:block;border-radius:8px">
        </td>
        <td style="vertical-align:middle">
          <div style="font-size:14px;font-weight:700;color:#1a1a1a">Aidan Cox</div>
          <div style="font-size:12px;color:#666666;margin-top:2px">
            <a href="https://aevon.ca/tempo.html" style="color:#666666;text-decoration:none">aevon.ca/tempo</a>
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
  console.log(LIVE ? '[Tempo sender] LIVE MODE — emails will be sent.\n'
                   : '[Tempo sender] DRY RUN — nothing will be sent. Use --send to go live.\n');

  const sendable = isSendableDay();
  if (!sendable.ok) { console.log(`Skipping — today is a ${sendable.reason}.`); return; }

  const now = new Date().toISOString();
  const dayStart = vancouverDayStartISO();
  const { count: sentToday } = await supabase.from(EVENTS)
    .select('id', { count: 'exact', head: true })
    .eq('event_type', 'sent')
    .gte('created_at', dayStart);

  const remaining = DAILY_CAP - (sentToday || 0);
  if (remaining <= 0) { console.log(`Daily cap reached (${sentToday}/${DAILY_CAP}).`); return; }

  const cols = 'id, business_name, email, contact_name, email_subject, email_body, followup_subject, followup_body, followup2_subject, followup2_body, sequence_step, qualification_score, scheduled_send_at';
  const baseFilter = q => q.eq('status', 'queued').not('email_subject', 'is', null).not('email', 'is', null).lte('scheduled_send_at', now);

  const { data: followups, error: fErr } = await baseFilter(
    supabase.from(TABLE).select(cols).in('sequence_step', [1, 2])
  ).order('scheduled_send_at', { ascending: true }).limit(DAILY_CAP);
  if (fErr) throw new Error(fErr.message);

  const { data: initialsPool, error: iErr } = await baseFilter(
    supabase.from(TABLE).select(cols).eq('sequence_step', 0)
  ).order('qualification_score', { ascending: false, nullsFirst: false })
   .order('scheduled_send_at', { ascending: true }).limit(200);
  if (iErr) throw new Error(iErr.message);

  // Named contacts (a real person's inbox) go before role inboxes at equal footing.
  const ROLE_INBOXES = new Set(['info', 'contact', 'hello', 'hi', 'office', 'admin', 'reception', 'general', 'inquiries', 'enquiries', 'mail', 'team', 'support', 'careers']);
  const isRoleInbox = email => {
    const local = String(email || '').split('@')[0].toLowerCase().replace(/[._-]?\d+$/, '');
    return ROLE_INBOXES.has(local) || ROLE_INBOXES.has(local.replace(/[._-]/g, ''));
  };
  const named = (initialsPool || []).filter(l => !isRoleInbox(l.email));
  const role = (initialsPool || []).filter(l => isRoleInbox(l.email));
  const initials = [...named, ...role];

  const followupBudget = Math.min(followups?.length || 0, Math.ceil(DAILY_CAP * FOLLOWUP_MAX_SHARE));
  const pickedFollowups = (followups || []).slice(0, followupBudget);
  const pickedInitials = initials.slice(0, Math.max(0, remaining - pickedFollowups.length));
  let due = [...pickedFollowups, ...pickedInitials].slice(0, remaining);

  if (!due.length) { console.log('No emails due right now.'); return; }

  // Safety net: never email a lead who already replied.
  const { data: repliedRows } = await supabase.from(EVENTS)
    .select('lead_id').eq('event_type', 'replied').in('lead_id', due.map(l => l.id));
  const repliedSet = new Set((repliedRows || []).map(r => r.lead_id));
  due = due.filter(l => !repliedSet.has(l.id));
  if (!due.length) { console.log('No emails due after reply filter.'); return; }

  console.log(`${LIVE ? 'Sending' : 'Would send'} ${due.length} email(s) — ${pickedFollowups.length} follow-up, ${due.length - pickedFollowups.length} new | ${sentToday || 0}/${DAILY_CAP} sent today.\n`);

  let sent = 0, failed = 0;
  for (const lead of due) {
    const step = lead.sequence_step;
    const subject = step === 2 ? lead.followup2_subject : step === 1 ? lead.followup_subject : lead.email_subject;
    const body = step === 2 ? lead.followup2_body : step === 1 ? lead.followup_body : lead.email_body;
    if (!subject || !body) {
      if (step >= 1 && LIVE) await supabase.from(TABLE).update({ status: 'dont_contact', scheduled_send_at: null }).eq('id', lead.id);
      continue;
    }

    process.stdout.write(`  [${step === 0 ? 'email' : 'followup ' + step}] ${lead.business_name} <${lead.email}>... `);

    // Hard gate: never email a Changepain person, even at another clinic.
    const dnc = dncReason(lead.contact_name, lead.email);
    if (dnc) {
      console.log(`SKIPPED (${dnc})`);
      if (LIVE) await supabase.from(TABLE).update({ status: 'dont_contact', scheduled_send_at: null, notes: `Held by sender: ${dnc}` }).eq('id', lead.id);
      failed++;
      continue;
    }

    const risk = emailRisk(lead.email);
    if (risk) {
      console.log(`SKIPPED (${risk})`);
      if (LIVE) await supabase.from(TABLE).update({ status: 'paused', scheduled_send_at: null, notes: `Held by sender: ${risk}` }).eq('id', lead.id);
      failed++;
      continue;
    }
    if (!(await domainAcceptsMail(lead.email))) {
      console.log('SKIPPED (no MX)');
      if (LIVE) await supabase.from(TABLE).update({ status: 'paused', scheduled_send_at: null, notes: 'Held by sender: domain has no mail server.' }).eq('id', lead.id);
      failed++;
      continue;
    }

    if (!LIVE) { console.log(`ok — "${subject}"`); sent++; continue; }

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
      const nextStep = step + 1;
      const isLastStep = nextStep >= 3;
      await supabase.from(TABLE).update({
        sequence_step: nextStep,
        last_sent_at: now,
        status: isLastStep ? 'dont_contact' : 'queued',
        scheduled_send_at: isLastStep ? null : new Date(Date.now() + FOLLOWUP_DELAY_DAYS * 86400000).toISOString(),
        ...(resendId ? { resend_email_id: resendId } : {}),
      }).eq('id', lead.id);
      if (resendId) {
        await supabase.from(EVENTS).insert({
          lead_id: lead.id, resend_email_id: resendId, event_type: 'sent',
          metadata: { subject, step, is_followup: step > 0 },
        });
      }
      console.log(isLastStep ? 'done (sequence complete)' : `followup in ${FOLLOWUP_DELAY_DAYS}d`);
      sent++;
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      const msg = err?.message || String(err);
      const isPermanent = /invalid|not found|unsubscribed|bounced/i.test(msg) || err?.statusCode === 422;
      console.log(`FAILED: ${msg}`);
      try {
        await supabase.from(TABLE).update({ status: isPermanent ? 'bounced' : 'error', notes: msg }).eq('id', lead.id);
        await supabase.from(EVENTS).insert({ lead_id: lead.id, event_type: isPermanent ? 'bounced' : 'error', metadata: { error: msg } });
      } catch (dbErr) { console.error(`  Could not log failure: ${dbErr.message}`); }
      failed++;
    }
  }

  console.log(`\nDone. ${LIVE ? 'Sent' : 'Would send'}: ${sent} | Skipped/failed: ${failed}`);
  if (!LIVE) console.log('\nThis was a dry run. Set pricing in tempo/offer.md, then run: node tempo/sender.js --send');
}

run().catch(err => { console.error('Fatal error:', err.message); process.exit(1); });
