#!/usr/bin/env node
/**
 * Seed test: is campaign mail reaching the inbox, or the spam folder?
 *
 * "Delivered" in Resend means the receiving server ACCEPTED the message. It says nothing
 * about which folder it landed in, and spam placement counts as delivered. That distinction
 * is the whole question: replies AND out-of-office autoresponders both went to zero while
 * sends continued, which is what worsening placement looks like and is not what falling
 * interest looks like.
 *
 * test-send-self.js cannot answer this. It sends to aidan@aevon.ca, the same domain the mail
 * comes from, so it never faces the external filters that matter.
 *
 * Sends through the real path: same Resend key, same from-address, same plain-text body,
 * same shared signature (lib/signature.js, cold shape: no booking link). The only thing that
 * differs is the recipient. The signature is imported, not copied, so this test cannot drift
 * out of sync with what the sender actually puts on mail.
 *
 * Seed choice matters more than anything else here. Most business buyers are on Microsoft
 * 365, and Outlook was the provider that junked the old builds. A Gmail-only seed panel
 * answers the Gmail question and nothing else. Include at least one Outlook/Hotmail seed
 * you can open, or the test is not measuring the mail the buyers actually receive.
 *
 *   node seed-placement-test.js --dry you@gmail.com you@outlook.com
 *   node seed-placement-test.js --send you@gmail.com you@outlook.com
 *   node seed-placement-test.js --send --seeds seeds.json
 *   node seed-placement-test.js --check --seeds seeds.json
 *
 * seeds.json: [{ "email": "you@gmail.com", "provider": "gmail", "label": "personal" }]
 * Never commit real seed addresses. seeds.json and seed-test-results.json are gitignored.
 *
 * --check queries the Gmail API for gmail.com seeds and reports INBOX vs SPAM plus the tab
 * category. It needs OAuth for the SEED mailbox (the recipient, not the sender):
 *   SEED_GMAIL_CLIENT_ID / SEED_GMAIL_CLIENT_SECRET / SEED_GMAIL_REFRESH_TOKEN
 * Generate the refresh token with: node get-gmail-token.js  (run it signed in as the seed
 * account). Outlook/Yahoo seeds are always manual: open the mailbox and look.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Resend } = require('resend');
const { signature } = require('./lib/signature');

const resend = null; // built lazily in sendPhase: --dry and --check must work without a key
function resendClient() {
  if (!process.env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY missing. Failing loud, not sending nothing quietly.');
    process.exit(1);
  }
  return new Resend(process.env.RESEND_API_KEY);
}
const FROM = process.env.FROM_EMAIL;
const SEND = process.argv.includes('--send');
const CHECK = process.argv.includes('--check');

const SEEDS_ARG = process.argv.indexOf('--seeds');
const RESULTS_FILE = path.join(__dirname, 'seed-test-results.json');

// Deliberately shaped like real outreach: same length, same register, same footer. A short
// "test" note would be classified differently and would prove nothing. Content is a standing
// representative sample; what is under test is the shape (plain text, no links, headers,
// signature), not the words.
const SUBJECT = 'same client details, three portals';
const BODY = `Every insurer wants the same client details in a slightly different format, so brokers end up typing the same information into three portals to place one policy.

I build small tools that do that specific job automatically. Fixed price, and I show you it working before you decide anything.

Is that actually a problem worth solving at your shop, or have you already sorted it?`;

// Cold shape, exactly as sender.js builds it: no booking link in the signature on email 1,
// because Outlook junked the build that carried the calendar URL (measured 2026-09-17).
const TEXT = BODY + signature({
  optOut: "Not interested? Just reply no and I won't email you again.",
  booking: false,
});

function loadSeeds() {
  const fromArgs = process.argv.slice(2).filter(a => a.includes('@'));
  if (SEEDS_ARG !== -1) {
    const file = process.argv[SEEDS_ARG + 1];
    if (!file) { console.error('--seeds needs a file path'); process.exit(1); }
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    return list.map(s => typeof s === 'string'
      ? { email: s, provider: /gmail|googlemail/i.test(s) ? 'gmail' : 'other', label: s }
      : { provider: /gmail|googlemail/i.test(s.email) ? 'gmail' : 'other', label: s.email, ...s });
  }
  return fromArgs.map(e => ({
    email: e,
    provider: /gmail|googlemail/i.test(e) ? 'gmail' : /outlook|hotmail|live\.|msn\./i.test(e) ? 'outlook' : 'other',
    label: e,
  }));
}

function saveResult(entry) {
  let all = [];
  try { all = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8')); } catch { /* first run */ }
  all.push({ at: new Date().toISOString(), subject: SUBJECT, ...entry });
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(all, null, 2));
}

async function sendPhase(seeds) {
  if (!FROM) {
    console.error('FROM_EMAIL must be set. Failing loud, not sending nothing quietly.');
    process.exit(1);
  }
  const client = resendClient();
  let failed = 0;
  for (const s of seeds) {
    const { data, error } = await client.emails.send({
      from: `Aidan from Aevon <${FROM}>`,
      reply_to: FROM,
      to: s.email,
      subject: SUBJECT,
      text: TEXT, // plain text only. HTML was quarantined as PHISHING by Microsoft (2026-08-18).
    });
    if (error) { console.error(`FAILED ${s.email}: ${error.message}`); failed++; continue; }
    console.log(`sent ${s.email.padEnd(34)} ${data && data.id}`);
    saveResult({ phase: 'send', seed: s.email, resend_id: data && data.id });
  }
  if (failed) { console.error(`${failed} send(s) failed. Fix before reading placement.`); process.exit(1); }
  console.log(`
Now open each mailbox and record where it landed:
  Inbox / Promotions or Updates / Spam / never arrived
Promotions is a soft fail. Spam explains the reply drought outright.
Run --check in 10 minutes for the Gmail seeds (needs SEED_GMAIL_* env).`);
}

async function checkPhase(seeds) {
  const gmailSeeds = seeds.filter(s => s.provider === 'gmail');
  const manualSeeds = seeds.filter(s => s.provider !== 'gmail');
  const canAuto = process.env.SEED_GMAIL_CLIENT_ID && process.env.SEED_GMAIL_REFRESH_TOKEN;

  if (gmailSeeds.length && !canAuto) {
    console.log('SEED_GMAIL_* not set, cannot auto-check Gmail seeds. Open them by hand:');
    for (const s of gmailSeeds) console.log(`  - ${s.label} (${s.email}): search from:${FROM} "${SUBJECT}"`);
  } else if (gmailSeeds.length) {
    const { google } = require('googleapis');
    const oauth2 = new google.auth.OAuth2(
      process.env.SEED_GMAIL_CLIENT_ID, process.env.SEED_GMAIL_CLIENT_SECRET);
    oauth2.setCredentials({ refresh_token: process.env.SEED_GMAIL_REFRESH_TOKEN });
    const gmail = google.gmail({ version: 'v1', auth: oauth2 });
    for (const s of gmailSeeds) {
      // NOTE: this checks the mailbox the OAuth token belongs to. It only answers for s
      // when the token was minted for s.email. One token per seed mailbox.
      const q = `from:${FROM} subject:"${SUBJECT}"`;
      let found = null;
      try {
        const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 5 });
        const id = list.data.messages && list.data.messages[0] && list.data.messages[0].id;
        if (id) {
          const full = await gmail.users.messages.get({ userId: 'me', id, format: 'metadata' });
          found = (full.data.labelIds || []).join(',');
        }
      } catch (e) { console.error(`check failed for ${s.email}: ${e.message}`); continue; }
      const verdict = !found ? 'NOT FOUND (still in transit, or filtered)'
        : /SPAM/.test(found) ? 'SPAM -- placement problem confirmed'
        : /INBOX/.test(found) ? `INBOX (${/CATEGORY_PROMOTIONS/.test(found) ? 'Promotions tab, soft fail' : 'primary-ish, good'})`
        : `other labels: ${found}`;
      console.log(`${s.label}: ${verdict}`);
      saveResult({ phase: 'check', seed: s.email, labels: found, verdict });
    }
  }
  if (manualSeeds.length) {
    console.log('\nManual checks (open each mailbox):');
    for (const s of manualSeeds) {
      console.log(`  - ${s.label} (${s.email}, ${s.provider}): search from:${FROM} "${SUBJECT}"`);
      console.log(`    Record: Inbox / Junk / never arrived. Outlook junk on a linkless plain-text`);
      console.log(`    mail means the problem is reputation or content, not the old link issue.`);
    }
  }
  if (!gmailSeeds.length && !manualSeeds.length) {
    console.error('No seeds given. A placement test with no mailboxes proves nothing.');
    process.exit(1);
  }
}

(async () => {
  const seeds = loadSeeds();
  if (!seeds.length && !CHECK) {
    console.error('Give at least one recipient, as args or --seeds file. Use addresses you can actually open.');
    process.exit(1);
  }
  console.log(`from: Aidan from Aevon <${FROM}>\nsubject: ${SUBJECT}\n`);
  if (CHECK) return checkPhase(seeds);
  if (!SEND) { console.log(TEXT); console.log(`\nDRY RUN. Would send to: ${seeds.map(s => s.email).join(', ')}`); return; }
  return sendPhase(seeds);
})().catch(e => { console.error('failed:', e.message); process.exit(1); });
