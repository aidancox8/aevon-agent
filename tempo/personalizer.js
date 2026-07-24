/**
 * tempo/personalizer.js
 * Writes a personalized 3-email cold sequence pitching TEMPO — Aevon's custom
 * staff & room scheduling app for multi-provider clinics — to leads in the
 * SEPARATE `tempo_leads` table. Duplicate of the Aevon personalizer; company is
 * still Aevon (aevon.ca), the PRODUCT is Tempo.
 *
 * Usage: node tempo/personalizer.js  [--limit N]
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const supabase = require('../lib/supabase');
const { createGenerate } = require('../lib/gemini');
const { scrapeContext, classifyEmail } = require('../lib/contact-finder');

const TABLE = 'tempo_leads';
// Two demo worlds: allied clinics see the allied demo (physios/RMTs/treatment
// rooms, no on-call); medical groups see the medical demo.
const DEMO_URL_MEDICAL = 'clinic-scheduler-demo.web.app';
const DEMO_URL_ALLIED = 'allied-scheduler-demo.web.app';
function isAlliedLead(industry) {
  return /physio|rehab|sport|kinesio|occupational|chiro|massage|multidiscip|integrated|wellness|naturopath|concussion/i.test(industry || '');
}
const generate = createGenerate(process.env.GEMINI_API_KEY);

const axios = require('axios');
// Most Jane clinics link janeapp.com for online booking. Only name Jane in copy
// when we can SEE it on their site — a chain or Cliniko/Juvonno shop must never
// get 'you run Jane' copy (reads as a mail-merge error and kills trust).
async function detectJane(website) {
  if (!website) return false;
  try {
    const { data } = await axios.get(website, { timeout: 8000, maxContentLength: 3e6, responseType: 'text', headers: { 'User-Agent': 'Mozilla/5.0' } });
    return typeof data === 'string' && /janeapp.com|jane.app/i.test(data);
  } catch { return false; }
}

function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}
function normSubject(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim(); }
function parseJsonObject(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/```json/gi, '').replace(/```/g, '');
  const start = s.indexOf('{'); if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}
const GEMINI_MIN_GAP = 4200;
let lastCallAt = 0;
async function rateLimitedGenerate(prompt) {
  const gap = Date.now() - lastCallAt;
  if (gap < GEMINI_MIN_GAP) await new Promise(r => setTimeout(r, GEMINI_MIN_GAP - gap));
  lastCallAt = Date.now();
  return generate(prompt);
}
const SEND_HOUR_UTC = 16; // 9am PT
function nextEligibleAt() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(SEND_HOUR_UTC, 0, 0, 0);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

// Light per-clinic-type framing for what their scheduling pain looks like.
function clinicContext(industry) {
  const i = (industry || '').toLowerCase();
  if (/physio|rehab|sport|kinesio|occupational|chiro|multidiscip|integrated|pain/.test(i))
    return 'Multidisciplinary and rehab clinics rotate several kinds of practitioner (physio, chiro, kinesiology, massage) across a set of treatment rooms, plus part-time and locum coverage — a weekly puzzle usually solved in a spreadsheet.';
  if (/medical|family|walk-in|practice|spine|orthopedic/.test(i))
    return 'Medical groups juggle multiple physicians, rooms, and on-call coverage across changing hours — the staff/room roster is almost always built by hand each week.';
  return 'Clinics with several providers and rooms spend real time each week building the staff and room schedule, arranging cover, and reminding people of their shifts — most of it manual.';
}

function allied0(lead) { return isAlliedLead(lead.industry); }

function buildPrompt(lead, websiteContent, usesJane) {
  const allied = isAlliedLead(lead.industry);
  const ctx = clinicContext(lead.industry);

  // Allied clinics almost all run Jane for PATIENT booking. Tempo never competes
  // with Jane — it schedules the TEAM (who works, where, when), which Jane's own
  // help docs say is out of scope for admin/front-desk staff.
  const positioning = allied
    ? `${usesJane ? `Tempo is NOT a patient-booking tool and NOT a Jane replacement (their site shows they book through Jane, and that is fine — Jane books their patients; you may naturally acknowledge that they run Jane).` : `Tempo is NOT a patient-booking tool and does NOT replace their booking system (whatever they book patients with stays; NEVER name a specific booking product like Jane — we have not verified what they use).`} Tempo schedules their TEAM: it builds the weekly grid of which practitioner is in which treatment room on which day, ${usesJane ? `schedules the front desk and support staff too (something Jane does not do — Jane's own guides tell clinics to use an external calendar for admin staff)` : `schedules the front desk and support staff too (something patient-booking tools leave to a separate calendar)`}, sends automatic SMS and email shift reminders, finds cover fast when someone calls in sick (one tap texts every qualified free staff member, first yes fills the shift), syncs time off with payroll and exports payroll-ready hours, and shows room and bed utilization. Built around THEIR clinic — their disciplines, rooms, locations, hours.`
    : `Tempo is NOT a patient-booking tool or an EMR (they already have those). It schedules STAFF and ROOMS: it builds the weekly grid of which provider is in which room on which day, sends automatic SMS and email shift + on-call reminders, handles shift and on-call cover, syncs time off with payroll, and shows room-utilization stats. It is built around THEIR clinic — their rooms, their provider types, their hours — and can run inside the tools they already use (e.g. Microsoft Teams).`;

  const contract = allied
    ? `HARD CAPABILITY CONTRACT: Tempo does EXACTLY these things: (1) builds the weekly practitioner + room schedule, (2) schedules front desk and support staff (which patient-booking tools do not cover), (3) automated SMS + email shift reminders and one-tap sick-call cover (text all qualified free staff, first yes takes the shift), (4) time off that syncs with payroll + payroll-ready hours export, (5) room utilization and coverage analytics. Describe ONLY these, phrased for their clinic. NEVER invent other capabilities (patient booking, EMR, billing, charting, Jane integration).`
    : `HARD CAPABILITY CONTRACT: Tempo does EXACTLY these things: (1) builds the weekly staff + room schedule, (2) automated SMS + email shift and on-call reminders/confirmations, (3) shift and on-call cover handling, (4) time-off that syncs with payroll, (5) utilization + coverage analytics. Describe ONLY these, phrased for their clinic. NEVER invent other capabilities (patient booking, EMR, billing, charting).`;

  const email1Block = `EMAIL 1 (initial outreach, SHOW-THE-PRODUCT approach):
- Goal: get a reply by offering a short look at ONE specific product, Tempo, described in a clinic's own terms. Do NOT ask open discovery questions. Show the thing and make it concrete.
- POSITIONING: ${positioning}
- ${contract}
- The hook: ${allied ? (usesJane ? 'Jane' : 'Their booking system') + ' books their patients, but someone still builds the staff schedule by hand every week (and scrambles by text when someone calls in sick). Tempo takes that over.' : 'get their staff + room scheduling OFF spreadsheets.'}
- Subject line: lowercase, short (2-5 words), about staff scheduling / rooms / coverage / spreadsheets. Never use the word "rota" (Canadian clinics say "schedule"). Vary the grammatical form. Fresh and specific.
- Body (under 70 words), and DO NOT include any link:
  1. ONE plain line of who you are: Aevon builds Tempo, a staff and room scheduling app made for multi-provider clinics.
  2. ONE or TWO lines on what it does for a clinic like theirs, per the positioning above. If a REAL scraped detail exists (their disciplines, number of providers, locations), weave it in naturally.
  3. ONE line of concreteness: it is built around their clinic${allied ? ' and sits alongside ' + (usesJane ? 'Jane' : 'their booking system') + ', never replacing it' : ' and can live in the tools they already use'}; it gets the staff schedule off spreadsheets.
  4. The ask, low friction: do they want a 2-minute look at a version set up like a clinic? Make yes easy ("happy to send it over").
  - No link in email 1. No feature dump. Do NOT assert their pain as fact. No sign-off (the signature handles that).`;
  return `You are writing a cold outreach email on behalf of Aevon, a software company based in the Lower Mainland, BC. Aevon's product for clinics is Tempo.

About the offer:
- Product: Tempo, a custom staff and room SCHEDULING app for multi-provider clinics. It builds the weekly schedule of which provider is in which room each day, sends automated SMS + email shift and on-call reminders and confirmations, handles shift and on-call cover, syncs time off with payroll, and reports on room utilization and coverage.
- It is tailored to each clinic (their rooms, provider types, departments, hours) and can run inside the software they already use, including Microsoft Teams.
- It is NOT patient booking, an EMR, or billing. It solves the STAFF + ROOM rostering that clinics still do in spreadsheets.
- Company: Aevon (aevon.ca), Lower Mainland, BC. Aidan is the founder.
- Target clients: multi-provider clinics in the Lower Mainland (physio/chiro/multidisciplinary/rehab/sports-med and medical groups).

Clinic context (general knowledge — use only to inform tone, do not state as fact about this specific clinic):
${ctx}

Lead details:
- Clinic name: ${lead.business_name}
- Type: ${lead.industry}
- City: ${lead.city}
- Website: ${lead.website || 'unknown'}
${lead.qualification_notes ? `- What we know about them: ${lead.qualification_notes}` : ''}
${lead.lead_insights ? `- Their likely pain points: ${lead.lead_insights}` : ''}
${websiteContent ? `- Scraped from their website: ${websiteContent}` : ''}

Write THREE emails, a lead insight, and a personalization basis.

${email1Block}

CRITICAL anti-fabrication rules:
- An observation about their clinic may be an honest, soft, industry-level truth ("clinics with a few disciplines usually build the staff schedule by hand") — that is fine.
- But you may ONLY state a CONCRETE, specific fact about THIS clinic (a named discipline, provider count, a second location, specific hours, a named practitioner) if it appears verbatim in the "Scraped from their website" text. If it is not there, you do NOT know it — do not invent it.
- Never claim to have seen something specific you did not. Inventing specifics reads as a bot and destroys trust.

Other rules:
- Pitch ONLY Tempo. Do not invent other products. Do NOT open with flattery.
- Tone: direct, human, a little casual. Like a person who understands how clinics run. No buzzwords, no em dashes, no filler ("leverage", "streamline", "seamless", "unified solution", "off-the-shelf", "bridges the gap").
- Each email must feel DIFFERENT from the last one written for another clinic. Vary sentence structure and the specific pain you name.

EMAIL 2 (follow-up, send 5 days later if no reply):
- Subject line: brief, reply-thread style.
- Body: under 55 words. A friendly bump that leads with the demo so they can just watch instead of replying. Point them to the live demo at ${allied ? DEMO_URL_ALLIED : DEMO_URL_MEDICAL} (write it exactly, as plain text, no markdown link). Frame it as a version set up like a ${allied ? 'multi-practitioner allied clinic (physio, RMT, chiro)' : 'multi-provider clinic'} (this is true — the demo is a working clinic schedule). Then one plain line: it gets built around their clinic and can run in the tools they already use. Close with one easy line inviting a reply. No hard sell.
- Tone: same plain, human voice.

EMAIL 3 (final follow-up, sent 5 days after email 2 if still no reply):
- Subject line: brief, reply-thread style.
- Body: under 40 words. This is the LAST time you reach out, and you say so plainly. No guilt-trip. Acknowledge they're busy, say you'll leave it here, and leave the door open with one easy line. No pitch, no link.
- Tone: same plain, human voice.

LEAD INSIGHT (2-3 sentences): why this clinic fits Tempo, what scheduling problems they likely have (providers, rooms, cover, on-call), and what you would set up for them.

PERSONALIZATION BASIS (one short line): state exactly what the opening was based on. If it used a real scraped detail, name it. If industry-level only, say "industry-level, no specific scrape detail".

Format your response as valid JSON only, no markdown, no explanation:
{
  "email_subject": "...",
  "email_body": "...",
  "followup_subject": "...",
  "followup_body": "...",
  "followup2_subject": "...",
  "followup2_body": "...",
  "lead_insights": "...",
  "personalization_basis": "..."
}`;
}

async function run() {
  const args = process.argv.slice(2);
  let limit = null;
  for (let i = 0; i < args.length; i++) if (args[i] === '--limit') limit = parseInt(args[++i], 10);

  const { data: pool, error } = await supabase
    .from(TABLE)
    .select('id, business_name, industry, city, website, email, lead_insights, qualification_notes')
    .is('email_subject', null).not('email', 'is', null).eq('status', 'queued')
    .order('qualification_score', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Supabase fetch failed: ${error.message} (did you run tempo/schema-tempo-leads.sql?)`);
  if (!pool || pool.length === 0) { console.log('No clinic leads to personalize.'); return; }

  const isNamed = l => classifyEmail((l.email || '').split('@')[0]) === 'personal';
  const named = pool.filter(isNamed);
  const role = pool.filter(l => !isNamed(l));
  let leads = [...named, ...role];
  if (limit) leads = leads.slice(0, limit);
  console.log(`[Tempo] Personalizing ${leads.length} clinic leads (${named.length} named, ${role.length} role/generic)...\n`);

  const usedSubjects = new Set();
  const { data: existingSubs } = await supabase.from(TABLE).select('email_subject').not('email_subject', 'is', null).limit(2000);
  (existingSubs || []).forEach(r => usedSubjects.add(normSubject(r.email_subject)));

  let success = 0, failed = 0;
  for (const lead of leads) {
    process.stdout.write(`  [${lead.business_name}]... `);
    try {
      const websiteContent = await withTimeout(scrapeContext(lead.website), 15000, 'scrape').catch(() => null);
      if (websiteContent) process.stdout.write(`(scraped) `);
      const usesJane = allied0(lead) ? await detectJane(lead.website) : false;
      if (usesJane) process.stdout.write('(jane) ');
      const prompt = buildPrompt(lead, websiteContent, usesJane);
      let content = parseJsonObject(await withTimeout(rateLimitedGenerate(prompt), 60000, 'gemini'));
      if (!content || !content.email_subject || !content.email_body)
        content = parseJsonObject(await withTimeout(rateLimitedGenerate(prompt + '\n\nReturn ONLY the JSON object, nothing before or after it.'), 60000, 'gemini'));
      if (!content || !content.email_subject || !content.email_body) throw new Error('No valid JSON with required fields after retry');

      if (usedSubjects.has(normSubject(content.email_subject))) {
        const dedupPrompt = prompt + `\n\nThe subject line "${content.email_subject}" has already been used for another clinic in this batch. Write the SAME email but with a DIFFERENT subject line, in a different grammatical form. Return ONLY the JSON object.`;
        const retry = parseJsonObject(await withTimeout(rateLimitedGenerate(dedupPrompt), 60000, 'gemini'));
        if (retry && retry.email_subject && retry.email_body) content = retry;
      }
      usedSubjects.add(normSubject(content.email_subject));

      const noDash = s => (s == null ? s : String(s).replace(/\s*[—–]\s*/g, ', '));
      const sendAt = nextEligibleAt();
      const { error: updateError } = await supabase.from(TABLE).update({
        email_subject: noDash(content.email_subject), email_body: noDash(content.email_body),
        followup_subject: noDash(content.followup_subject), followup_body: noDash(content.followup_body),
        followup2_subject: noDash(content.followup2_subject) || null, followup2_body: noDash(content.followup2_body) || null,
        lead_insights: content.lead_insights || null, personalization_basis: content.personalization_basis || null,
        scheduled_send_at: sendAt,
      }).eq('id', lead.id);
      if (updateError) throw new Error(updateError.message);

      console.log(`eligible from ${new Date(sendAt).toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' })}`);
      success++;
    } catch (err) { console.log(`FAILED: ${err.message}`); failed++; }
  }
  console.log(`\nDone. Personalized: ${success} | Failed: ${failed}`);
}

run().catch(err => { console.error('Fatal error:', err.message); process.exit(1); });
