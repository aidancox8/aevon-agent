/**
 * lib/visit-quality.js  —  tell a real visitor from an email security scanner.
 *
 * Corporate mail filters (Defender, Mimecast, Proofpoint and friends) fetch every link in an
 * inbound email to check it before the recipient ever sees the message. Those fetches hit the
 * tracking endpoint and look exactly like a visit. Roughly half of all recorded clicks land
 * within two minutes of a send, which is the classic signature.
 *
 * The first version of this got 14 of 39 wrong, all in the dangerous direction, because of two
 * assumptions that do not survive a three-email sequence:
 *
 *   1. It measured every visit against the FIRST email ever sent to that lead. A scanner
 *      fetching the third email therefore looked like someone returning six days later. Reid
 *      Brothers had five clicks, every one under a minute from a send, and was reported as
 *      "visited well after delivery; visited on 3 separate days".
 *   2. It treated visits on separate days as proof of a human. Three emails produce three
 *      scans on three different days without a person being involved at all.
 *
 * Both are fixed by measuring against the NEAREST PRECEDING send instead, and by requiring at
 * least one click that a scanner cannot explain before anything else is allowed to count.
 *
 * One assumption that was tested and does NOT hold: browser version. Chrome 140+ accounts for
 * 69% of clicks inside the scan window while stale Chrome 120-129 is only 17%, because modern
 * scanners spoof the current user agent. Version tells you nothing here, in either direction.
 * Mobile still does: only 12% of mobile clicks fall in the scan window against a 49% baseline.
 */

const MOBILE = /iPhone|Android|Mobile|iPad/i;
const OBVIOUS_BOT = /HeadlessChrome|bot\b|crawler|spider|Python|curl|Go-http|axios|Java\/|Scan|Proofpoint|Mimecast|Barracuda/i;

/** Minutes after a send inside which a click is assumed to be a link scan. */
const SCAN_WINDOW_MIN = 10;

/**
 * Minutes from a click back to the send that preceded it, or null if we have no send for it.
 * Sends are allowed to be up to a minute later than the click to absorb clock skew between
 * the mail provider's webhook and the tracking endpoint.
 */
function minutesSinceNearestSend(clickAt, sendTimes) {
  const t = +new Date(clickAt);
  const prior = (sendTimes || []).map(Number).filter(s => s <= t + 60000).sort((a, b) => a - b);
  if (!prior.length) return null;
  return (t - prior[prior.length - 1]) / 60000;
}


/** Minutes: clicks on different leads inside this window are treated as one burst. */
const BATCH_WINDOW_MIN = 15;
/** Distinct leads in a burst before it stops being a coincidence. */
const BATCH_MIN_LEADS = 3;

/**
 * Find clicks that belong to a cross-lead burst.
 *
 * The per-send scan window misses one whole class of machine traffic: a security vendor that
 * serves many companies and sweeps its queue on a schedule rather than on delivery. That shows
 * up as fifteen unrelated leads clicked inside the same fifteen minutes, hours after any of
 * them were sent, so every one of those clicks looks "unexplained" on its own. Recorded bursts
 * here reach 15 leads at once.
 *
 * A person cannot be browsing as three different companies at the same moment, so a burst is
 * machine traffic regardless of what the timing against their own send says.
 *
 * @param {{lead_id: string, created_at: string}[]} allClicks  every click across all leads
 * @returns {Set<string>} keys of `${lead_id}|${created_at}` to ignore
 */
function batchClickKeys(allClicks) {
  const sorted = [...(allClicks || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const drop = new Set();
  let burst = [];
  const flush = () => {
    if (new Set(burst.map(c => c.lead_id)).size >= BATCH_MIN_LEADS) {
      burst.forEach(c => drop.add(`${c.lead_id}|${c.created_at}`));
    }
    burst = [];
  };
  for (const c of sorted) {
    if (burst.length && (new Date(c.created_at) - new Date(burst[burst.length - 1].created_at)) / 60000 > BATCH_WINDOW_MIN) flush();
    burst.push(c);
  }
  flush();
  return drop;
}


/** A polling loop hits on a near-fixed interval. Gaps inside this band count toward that. */
const CADENCE_LO_MIN = 45;
const CADENCE_HI_MIN = 80;
const CADENCE_MIN_HITS = 3;
/** Distinct browser/OS shapes beyond which a single small business is not plausible. */
const MAX_UA_SHAPES = 4;

/** Strip version numbers so Chrome/124 and Chrome/145 count as one browser shape. */
const uaShape = ua => String(ua || '').replace(/[\d._]+/g, '');

/**
 * Detect a machine polling the page rather than a person visiting it.
 *
 * This is the signature the per-send and cross-lead tests both miss, because it looks like an
 * engaged prospect on every other measure: many clicks, spread over days, from several
 * devices, long after the send. Madison Eyes scored highest on the entire warm list this way,
 * with 24 clicks over 9 days from 8 device shapes. The gaps give it away:
 *
 *   63, 120, 61, 150, ... 61, 67, 53, 66, ... 61, 69, 0, 50, 68, 0   (minutes)
 *
 * Ten of twenty-three gaps sit within a few minutes of an hour, several land overnight, two
 * pairs fire in the same second from different user agents, and the agents rotate through
 * Android 7, Chrome 79 and Chrome 148. That is one crawler re-checking a link on a schedule
 * behind a rotating agent pool, which also explains why browser version turned out to carry no
 * signal: the pool is deliberately varied.
 */
function machineCadenceReason(visits) {
  const cs = [...(visits || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  if (cs.length < 3) return null;

  const shapes = new Set(cs.map(v => uaShape((v.metadata || {}).ua)));
  if (shapes.size >= MAX_UA_SHAPES) {
    return `${shapes.size} different browser builds hitting one page`;
  }

  let hourly = 0;
  for (let i = 1; i < cs.length; i++) {
    const gap = (new Date(cs[i].created_at) - new Date(cs[i - 1].created_at)) / 60000;
    if (gap >= CADENCE_LO_MIN && gap <= CADENCE_HI_MIN) hourly++;
    // Two agents in the same second is not one person with two tabs.
    if (gap < 1 && uaShape((cs[i].metadata || {}).ua) !== uaShape((cs[i - 1].metadata || {}).ua)) {
      return 'two different browsers clicked in the same second';
    }
  }
  if (hourly >= CADENCE_MIN_HITS) return `${hourly} clicks spaced about an hour apart, a polling loop`;
  return null;
}

/**
 * Classify one lead's visits.
 *
 * @param {{created_at: string, metadata?: object}[]} visits  all click events for this lead
 * @param {number[]|string[]} sendTimes  every send/delivery timestamp for this lead. Passing a
 *   single first-send timestamp still works but reintroduces the bug described above.
 * @returns {{human: boolean, reasons: string[], count: number, offWindow: number}}
 */
function classifyVisits(visits, sendTimes, batchKeys) {
  const list = Array.isArray(visits) ? visits : [];
  if (!list.length) return { human: false, reasons: [], count: 0, offWindow: 0 };

  const sends = (Array.isArray(sendTimes) ? sendTimes : [sendTimes])
    .filter(Boolean).map(s => +new Date(s));

  const uas = list.map(v => (v.metadata || {}).ua || '');
  if (uas.some(u => OBVIOUS_BOT.test(u))) {
    return { human: false, reasons: ['declared bot user agent'], count: list.length, offWindow: 0 };
  }
  // Checked before anything else, because this pattern scores as the warmest possible lead on
  // every other signal: many clicks, many days, many devices, long after the send.
  const cadence = machineCadenceReason(list);
  if (cadence) return { human: false, reasons: [cadence], count: list.length, offWindow: 0 };

  // The gate. A click a scanner cannot account for, meaning it did not follow a send closely
  // enough to be a link check. Without one of these, nothing else is evidence of a person.
  const offWindow = list.filter(v => {
    if (batchKeys && batchKeys.has(`${v.lead_id}|${v.created_at}`)) return false;
    const d = minutesSinceNearestSend(v.created_at, sends);
    return d === null || d > SCAN_WINDOW_MIN;
  });
  if (!offWindow.length) {
    return { human: false, reasons: ['every click was a link scan or part of a cross-lead burst'],
             count: list.length, offWindow: 0 };
  }

  const reasons = [];
  // Only mobile clicks OUTSIDE the window count. A scanner running a spoofed mobile agent
  // still fires immediately, so an in-window mobile click proves nothing.
  if (offWindow.some(v => MOBILE.test((v.metadata || {}).ua || ''))) reasons.push('from a phone');

  // Separate days, counted over qualifying clicks only, so a three-email sequence scanned
  // three times cannot manufacture this.
  const days = new Set(offWindow.map(v => String(v.created_at).slice(0, 10)));
  if (days.size > 1) reasons.push(`came back on ${days.size} separate days`);

  if (offWindow.length > 1) reasons.push(`${offWindow.length} clicks a scan does not explain`);

  // Distinct user agents across qualifying clicks: a second device is a second person-action.
  const shapes = new Set(offWindow.map(v => ((v.metadata || {}).ua || '').replace(/Chrome\/[\d.]+/, 'C')));
  if (shapes.size > 1) reasons.push(`${shapes.size} different browsers or devices`);

  if (!reasons.length) {
    const d = minutesSinceNearestSend(offWindow[0].created_at, sends);
    reasons.push(d === null ? 'a click with no matching send'
      : `one click ${d > 1440 ? Math.round(d / 1440) + ' days' : d > 60 ? Math.round(d / 60) + ' hours' : Math.round(d) + ' minutes'} after the send`);
  }
  return { human: true, reasons, count: list.length, offWindow: offWindow.length };
}

/**
 * Confidence tier. Single-click leads are kept but must be labelled: a lone click hours later
 * is consistent with a delayed sandbox detonation as well as with a person.
 */
function visitTier(cls) {
  if (!cls.human) return 'scanner';
  if (cls.offWindow >= 4) return 'strong';
  if (cls.offWindow >= 2) return 'probable';
  return 'weak';
}

function visitScore(cls) {
  if (!cls.human) return 0;
  return cls.offWindow * 10 + cls.reasons.length;
}

module.exports = { classifyVisits, visitScore, visitTier, batchClickKeys, machineCadenceReason,
                   SCAN_WINDOW_MIN, BATCH_WINDOW_MIN, minutesSinceNearestSend };
