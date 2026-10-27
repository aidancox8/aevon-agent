/**
 * cadre/posting-copy.js
 *
 * The posting-quote email and the rules for who may get it, shared by the one-off batch
 * (posting-quote-batch.js) and the daily autopilot (posting-autopilot.js) so the two can
 * never drift. One checkable fact per email: a line from the company's own job posting.
 */
const { excludedOrgReason } = require('../tempo/dnc');

const CANADA = /\b(BC|AB|SK|MB|ON|QC|NS|NB|NL|PE|YT|NT|NU)\b|British Columbia|Alberta|Ontario|Saskatchewan|Manitoba|Canada/i;
const QUEBEC = /\bQC\b|Quebec|Québec/i;
const BC = /\bBC\b|British Columbia/i;
// US city strings in cadre_leads end in a two-letter state code ("Dallas, TX").
const US = /,\s*(A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b/;
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// The quote has to read as a task after "asked the new hire to".
const TASK_VERB = /^(maintain|track|manage|monitor|support|keep|update|coordinate|assist|schedule|enter|help|ensure|administer|oversee|organize|record|review|lead|develop|conduct|plan|verify|audit|prepare|input|process|create|build|implement|facilitate|deliver|issue|file|document)\b/i;

function cleanQuote(q) {
  let s = String(q || '').replace(/\s+/g, ' ').trim().replace(/^[-•*\s]+/, '');
  const m = s.match(/^[^.]{20,220}\./); // first sentence if there is one
  if (m) s = m[0];
  if (s.length > 200) s = s.slice(0, 200).replace(/\s+\S*$/, '') + '...';
  // A first-sentence cut can land inside "(ie. ...)". Drop an unclosed bracket and what follows.
  const open = s.lastIndexOf('(');
  if (open > -1 && s.indexOf(')', open) === -1) s = s.slice(0, open).replace(/[\s,;:]+$/, '');
  return s.replace(/\.$/, '');
}
function firstName(n) { const f = String(n || '').trim().split(/\s+/)[0]; return /^[A-Z][a-z'-]+$/.test(f) ? f : null; }

function region(l) {
  const c = l.city || '';
  if (CANADA.test(c)) return QUEBEC.test(c) ? 'QC' : 'CA';
  if (US.test(c)) return 'US';
  return null;
}

/** Why this lead must not get the posting-quote email, or null if it may. */
function blockReason(l, { maxPostingAgeDays = null, regions = ['CA'] } = {}) {
  if (!l.signal_quote) return 'no posting quote';
  if (!l.email) return 'no email';
  if (l.last_sent_at) return 'already emailed';
  if (!['queued', 'needs_review'].includes(l.status)) return `status ${l.status}`;
  if (['generic', 'invalid'].includes(l.email_quality)) return `email ${l.email_quality}`;
  if (/parked by hand|dont_contact|HRIS|domain does not match|survived/i.test(l.notes || '')) return 'parked in notes';
  const ex = excludedOrgReason(l.business_name, l.email);
  if (ex) return ex;
  if (l.staff_estimate && (l.staff_estimate < 20 || l.staff_estimate > 1000)) return `${l.staff_estimate} staff`;
  const q = cleanQuote(l.signal_quote);
  if (q.split(' ').length < 6) return 'quote too short';
  if (!TASK_VERB.test(q)) return 'quote does not read as a task';
  const r = region(l);
  if (!regions.includes(r)) return `region ${r || 'unknown'}`;
  if (maxPostingAgeDays != null) {
    if (!l.signal_date) return 'posting date unknown';
    if (Date.now() - new Date(l.signal_date).getTime() > maxPostingAgeDays * 864e5) return 'posting too old';
  }
  return null;
}

function emailFor(l) {
  const hi = firstName(l.contact_name) ? `Hi ${firstName(l.contact_name)},` : `Hi ${l.business_name} team,`;
  const when = l.signal_date ? `Your ${MONTH[new Date(l.signal_date).getUTCMonth()]} job posting` : 'A recent job posting of yours';
  const tail = BC.test(l.city || '') && l.industry === 'trades'
    ? 'It also checks the Skilled Trades Certification apprentice ratio and COR training records for BC contractors.'
    : 'It also keeps the training records an auditor asks for ready to export.';
  return {
    subject: 'your job posting',
    body: [
      hi, '',
      `${when} asked the new hire to "${cleanQuote(l.signal_quote)}".`, '',
      `That is the part of the job Cadre takes off their plate. Every certification sits on the employee record, the worker and their supervisor are warned at 60, 30 and 7 days, and the staff list syncs from the HR or payroll system you already run. ${tail}`, '',
      'I am looking for a few companies to use it free for a while in exchange for honest feedback. Would a 20-minute look be worth it?', '',
      'Thanks,', 'Aidan Cox', 'Aevon', 'aevon.ca', '',
    ].join('\r\n'),
  };
}

module.exports = { CANADA, BC, cleanQuote, firstName, region, blockReason, emailFor };
