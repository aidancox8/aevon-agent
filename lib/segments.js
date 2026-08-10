/**
 * lib/segments.js  —  which industries are worth sending to, decided from our own results.
 *
 * Measured 2026-08-04 over every lead ever emailed, counting only replies from a human
 * (the stored 'replied' events are 65% out-of-office, so the naive count is three times
 * too high and says the opposite about healthcare):
 *
 *     bucket                   sent  human replies   rate
 *     marketing                  43       1         2.33%
 *     financial/professional    714      10         1.40%
 *     legal                     168       2         1.19%
 *     real estate               230       1         0.43%
 *     trades                    271       0         0.00%
 *     healthcare                273       0         0.00%
 *     logistics                 248       0         0.00%
 *     other                      91       0         0.00%
 *
 * 883 emails into the bottom four produced not one human reply, and 2,111 more were queued
 * behind them, which was 55% of the remaining list. Belkins' 7.5M-send dataset finds industry
 * moves reply rate about 15x, far more than any copy change, so this is the highest-leverage
 * filter available and it costs nothing to apply.
 *
 * Deliberately a send-time filter rather than a database change: no rows are mutated, the
 * leads stay in place, and re-enabling a bucket is a one-line edit. The zero-reply buckets
 * are paused, not deleted, because 271 sends is a real signal but not a proof.
 *
 * NOTE: this governs the Aevon consulting list only. Tempo sells to clinics and lives in
 * tempo_leads, so pausing 'healthcare' here does not touch it.
 */

/** Coarse bucket for a fine-grained industry label. Order matters: first match wins. */
function bucketFor(industry) {
  const s = String(industry || '').toLowerCase();
  if (/clinic|dental|physio|chiro|veterinar|optometry|medical|health|rehab|kinesiology|home care|pharmaceutical/.test(s)) return 'healthcare';
  if (/law firm|notary|immigration consultant/.test(s)) return 'legal';
  if (/marketing|advertising|public relations|media buying|media company|market research/.test(s)) return 'marketing';
  if (/real estate|property management/.test(s)) return 'real estate';
  if (/insurance|financial|mortgage|accounting|bookkeeping|investment|business broker|consulting|engineering|surveying|staffing|recruitment|executive search|architecture|it consulting|grant writing|research company/.test(s)) return 'financial/professional';
  if (/logistics|freight|courier|warehouse|distribution|wholesale|moving|customs|trading|import export/.test(s)) return 'logistics';
  if (/contractor|hvac|plumbing|electrical|landscaping|restoration|inspection|equipment rental|manufacturing|field service|security company/.test(s)) return 'trades';
  return 'other';
}

/** Buckets that have produced at least one human reply. Everything else is paused. */
const ACTIVE_BUCKETS = new Set(['financial/professional', 'legal', 'marketing', 'real estate']);

/** True if we should still be starting new sequences into this industry. */
function isActiveSegment(industry) {
  return ACTIVE_BUCKETS.has(bucketFor(industry));
}

/**
 * Address tiers we still send to.
 *
 * 'generic' loses on both metrics at once, measured 2026-08-06 across 2,063 leads emailed:
 *
 *     tier        sent   bounced   bounce rate   human replies
 *     generic      180        18       10.00%        0
 *     personal    1252        75        5.99%        9
 *     (unset)      617        19        3.08%        5
 *     role          14         0        0.00%        0
 *
 * Twice the bounce rate of any other tier and not one reply. Bounces are the expensive half:
 * measured per unique lead the list is at 5.72%, past the 5% line where mailbox providers
 * start throttling a sender, and 1,860 more generic addresses were queued to go out. Dropping
 * them is the single cheapest way to pull the bounce rate back under the line.
 *
 * 'role' is left enabled: 14 sends is far too small to judge, and it bounced none of them.
 */
const SENDABLE_QUALITY = new Set(['personal', 'role', null, undefined, '']);

function isSendableAddress(quality) {
  return SENDABLE_QUALITY.has(quality);
}

/** Everything that has to be true before we start a new sequence with someone. */
function isWorthSending(lead) {
  return isActiveSegment(lead.industry) && isSendableAddress(lead.email_quality);
}

/**
 * The best-performing slice we have found: financial services in Metro Vancouver.
 *
 * Measured 2026-08-09 over every lead ever emailed, human replies only:
 *   Metro Vancouver financial services   317 contacted   6 replies   1.89%
 *   everything else                    1,795 contacted   6 replies   0.33%
 * 5.7x, and at p = 0.08% against the rest of the list, so this is not noise.
 *
 * Sending these first does not change the total the queue will ever return, roughly 7 replies
 * either way. It changes WHEN: about 4.9 of those land in the first two weeks instead of being
 * spread across six. At this volume the only thing worth optimising is how fast we learn.
 *
 * The niche is also small, which is the more important fact. Our own sweep finds 926 such
 * businesses in Metro Vancouver, 609 never contacted. Exhausting all of them yields roughly
 * 4 interested conversations. Front-loading buys speed, not a pipeline.
 */
const METRO_VANCOUVER = /vancouver|burnaby|richmond|surrey|coquitlam|langley|delta|new westminster|north vancouver|west vancouver|port moody|port coquitlam|maple ridge|white rock|pitt meadows/i;
const FINANCIAL_SERVICES = /mortgage|insurance|financial advisor|financial planning|investment advis|wealth|accounting|bookkeeping|business broker|notary|credit union/i;

function isHotSegment(lead) {
  return METRO_VANCOUVER.test(lead.city || '') && FINANCIAL_SERVICES.test(lead.industry || '');
}

module.exports = { bucketFor, isActiveSegment, isSendableAddress, isWorthSending, isHotSegment, ACTIVE_BUCKETS };
