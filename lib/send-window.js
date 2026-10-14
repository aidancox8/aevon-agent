/**
 * Business-hours guard for hand-approved outreach batches. Emails only go out on a weekday
 * that is not a Canadian statutory or BC holiday, 8:00 to 15:00 Pacific (11:00 to 18:00 Eastern). A weekend or holiday send reads as automated
 * and lands under Monday's pile. waitForWindow() sleeps until the next allowed minute.
 */
const HOLIDAYS = new Set([
  // 2026 Canada / BC
  '2026-10-12', // Thanksgiving
  '2026-11-11', // Remembrance Day
  '2026-12-25', '2026-12-26', '2026-12-28',
  // 2027
  '2027-01-01', '2027-02-15', '2027-03-26', '2027-03-29', '2027-05-24', '2027-07-01',
  '2027-08-02', '2027-09-06', '2027-09-30', '2027-10-11', '2027-11-11', '2027-12-25', '2027-12-27',
]);

function pacificParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute), weekday: p.weekday };
}

function inSendWindow(d = new Date()) {
  const p = pacificParts(d);
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false;
  if (HOLIDAYS.has(p.date)) return false;
  return p.hour >= 8 && p.hour < 15;
}

async function waitForWindow(log = console.log) {
  if (inSendWindow()) return;
  log(`outside the send window (${pacificParts().weekday} ${pacificParts().date} ${pacificParts().hour}:00 PT); waiting`);
  while (!inSendWindow()) await new Promise(r => setTimeout(r, 5 * 60 * 1000));
  log(`send window open (${pacificParts().date})`);
}

// A dropped connection (laptop Wi-Fi asleep, DNS down) must not turn into a skipped or failed
// lead. Retries fn every 5 minutes for up to 3 hours while the error looks like the network.
const NET_ERR = /ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|socket hang up|fetch failed|network/i;
async function withNetRetry(fn, label = '') {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (!NET_ERR.test(String(e && (e.message || e.code) || e)) || i >= 36) throw e;
      console.log(`${new Date().toISOString()} network down${label ? ` (${label})` : ''}: ${e.message}; retrying in 5 min`);
      await new Promise(r => setTimeout(r, 5 * 60 * 1000));
      await waitForWindow(); // an outage must not push a send past 3pm or into the weekend
    }
  }
}

module.exports = { inSendWindow, waitForWindow, pacificParts, withNetRetry, NET_ERR };
