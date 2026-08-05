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

module.exports = { bucketFor, isActiveSegment, ACTIVE_BUCKETS };
