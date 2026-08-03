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
    ? `HARD CAPABILITY CONTRACT: Tempo does EXACTLY these things: (1) builds the weekly practitioner + room schedule, (2) schedules front desk and support staff (which patient-booking tools do not cover), (3) automated SMS + email shift reminders and one-tap sick-call cover (text all qualified free staff, first yes takes the shift), (4) time off that syncs with payroll + payroll-ready hours export, (5) room utilization and coverage analytics. This bounds what you may CLAIM; it is NOT a list to recite. Name ONE of them, the one that matters most to THIS clinic, phrased in their words. NEVER invent other capabilities (patient booking, EMR, billing, charting, Jane integration).`
    : `HARD CAPABILITY CONTRACT: Tempo does EXACTLY these things: (1) builds the weekly staff + room schedule, (2) automated SMS + email shift and on-call reminders/confirmations, (3) shift and on-call cover handling, (4) time-off that syncs with payroll, (5) utilization + coverage analytics. This bounds what you may CLAIM; it is NOT a list to recite. Name ONE of them, the one that matters most to THIS clinic, phrased in their words. NEVER invent other capabilities (patient booking, EMR, billing, charting).`;

  const email1Block = `EMAIL 1 (initial outreach, BUILT-AROUND-YOU approach):
- THE CORE ARGUMENT, and the spine of this email. Follow this arc:
    Clinics go looking for scheduling software that fits how they actually run, and never find it, because no two clinics run the same way. So it ends up back in a spreadsheet, which is not efficient and not reliable, and things slip through. Instead of making a clinic reshape its operations around a piece of software, we build the software around the clinic's operations.
  That inversion IS the pitch. Every competing product is something they must conform to. Tempo is the opposite, and that is the one thing none of the alternatives can claim.
- Goal: get a reply. Do NOT ask open discovery questions and do NOT dump features. Land the argument above, made specific to THIS clinic.
- POSITIONING (background, for accuracy — do not recite it as a feature list): ${positioning}
- ${contract}
- Subject line: lowercase, short (2-5 words). It should hint at the fit problem or the spreadsheet, not at a feature list. Never use the word "rota" (Canadian clinics say "schedule"). Vary the grammatical form. Fresh and specific.
- HOW IT MUST SOUND. This matters more than any beat below. Read it back and ask whether a
  busy clinic owner would believe a person typed it in ninety seconds. If it reads like a
  landing page paragraph it has failed, and dense corporate register is the usual cause:
  * Under 55 words total. No sentence longer than 20 words. Most should be much shorter.
  * The reason it is free should be a clause, not a sentence. Four or five words folded into
    the offer ("while I am building a track record", "I am early and taking on a few") does
    the job. It must be present, but it must not cost you the whole word budget.
  * Use contractions. "cannot" is "can't", "it is" is "it's". Always.
  * Write as I, not as Aevon or we. One person emailing another.
  * Concrete over abstract. "someone rebuilds the grid every Friday" beats "the weekly time
    cost of rebuilding the schedule is a cycle that never ends".
  * BANNED, these are the exact tells that make it sound generated: "often find", "rather
    than", "remains", "it usually ends up", "the nuance of", "streamline", "leverage",
    "solution", "seamless", "robust", "in today's", "we understand", "reach out",
    "I hope this finds you", "cutting-edge", "tailored solutions", "pain points".
  * Never open with "Hi there" or any greeting to nobody. Open in their world.
  * INTRIGUE, not explanation. The goal is that they want to know more, which means
    leaving something unsaid. Two things create it: a detail specific enough that they
    wonder how you knew, and brevity. An email that explains the whole product answers
    every question and there is no reason to reply. Say less than feels comfortable.
  * The FIRST sentence must contain something true about THEIR business that you could only
    know by looking: their disciplines, locations, services, the mix they run. A sentence
    that would fit any business in their industry is a wasted opening.
  * Do NOT use the same shape every time. If the last email opened with a fact and closed
    with a question, this one should not. Uniform structure across a batch is itself the
    tell, even when every individual email reads fine.
  * A fragment is fine. Perfect grammar is not the goal.

- WORKED EXAMPLES. These are the standard. Study the register, the rhythm and the restraint,
  then write something completely different. Copying a phrase, a structure or a closing
  question from these is a failure: they exist to show what "a person typed this" sounds
  like, not to be recombined.

  Allied Physiotherapy Health Group, North Vancouver, five disciplines, several sites
  SUBJECT: five disciplines, one grid
  Physio, kinesiology, massage, chiro and acupuncture, across more than one site. Whoever
  builds that weekly grid is solving a puzzle every Friday.
  I'd set up scheduling around your rooms and disciplines, free for two weeks. I'm early
  enough that I need the reference more than the money.
  Who builds yours, and how long does it take them?

  Revive Rehab, Surrey, six services across three cities
  SUBJECT: surrey, langley, abbotsford
  Six services across three cities. Counselling and IV therapy don't share room types with
  physio, so it isn't one grid, it's three.
  I'd build your staff and room schedule around that, free for two weeks. I'm early and need
  the case study more than the fee.
  What happens now when someone calls in sick in Abbotsford?

  What makes those work, and what you must reproduce:
  * The opening is a fact about THEM, stated flatly, no preamble and no greeting.
  * The second line finds the consequence hiding in that fact, and it is specific enough
    that a generic clinic could not receive the same sentence.
  * The reason it is free is one honest clause. It admits a real position rather than
    manufacturing urgency, which is what makes it land.
  * The close is a genuine question about how they operate. It is interesting to answer,
    costs one line, and is nothing like "just reply yes".
  * Nothing explains the product. The reader is left with something to ask about.
- Body (under 55 words), and DO NOT include any link:
  1. OPEN IN THEIR WORLD, never with who you are. First sentence is about how a clinic like
     theirs actually runs. If a REAL scraped detail exists (their disciplines, provider
     count, locations), use it HERE so it is obvious a generic tool would not fit THEM.
     NEVER begin with "Aevon", "I'm Aidan", "We build", "Hi there", or any variant leading
     with the sender.
  2. WHAT YOU DO ABOUT IT, one plain sentence, as a person not a company: it gets built
     around their clinic instead of the other way around${allied ? ', and it sits alongside ' + (usesJane ? 'Jane' : 'their booking system') + ' rather than replacing it' : ''}. Name Tempo here, briefly and
     subordinate to the point. Name ONE thing it does, the one that matters most to THIS
     clinic, never a list. A comma-separated run of capabilities is the clearest signal to a
     reader that software wrote the email.
  3. THE OFFER, and it is the whole point of the email: you will set Tempo up around THEIR
     clinic, their rooms, their disciplines, their hours, and they run it free for two weeks
     before deciding anything. Say it plainly and briefly.
     Call it a pilot, NEVER a "free trial". A trial sounds like self-serve signup for generic
     software; this is someone building it for them, which is the entire difference and the
     one thing a booking platform cannot answer.
     SAY WHY IT IS FREE, in a handful of words, and treat this as mandatory. Free setup from
     a stranger reads as a scam, and the reason is what makes it credible. The true reason:
     he is early, building a track record with the first few clinics, and it is limited
     rather than a standing offer. Never invent a client count, a deadline, or a numbered
     spot ("2 places left") — there are no clinics on it yet and fake scarcity is exactly
     what a scam sounds like.
     Do NOT mention price, any dollar figure, or what happens after the two weeks. That is a
     conversation for after they reply.
     HOW TO CLOSE. The reply has to be cheap, but the close must not sound like a template.
     BANNED outright, these are the most recognisable machine-written closes in existence:
     "just reply yes", "reply yes and I'll send it", "one word back is plenty", "a one word
     reply is plenty", "sound good?", "worth a look?", "let me know if you're interested",
     "would you be open to", "no pressure", "happy to share more", "thoughts?".
     Write a close a clinic owner would believe a person typed. A real question about how
     they run, or a plain concrete offer with a timeframe. Good shapes, do NOT copy verbatim:
       "Want me to set it up for your rooms and see?"
       "Who builds the grid at your place, and how long does it take them?"
       "Say the word and I'll have your first week built by Friday."
     Vary the SHAPE, not just the words. If several emails in a row end the same way, the
     wording is not the problem, the formula is.
  - No link in email 1. Do NOT assert their pain as fact. No sign-off (the signature handles that).
  - The consequence beat was folded into beat 1. Do NOT also add a separate cost-of-doing-nothing line, and never say anything like "every unstaffed shift is a lost day of billings" — the spreadsheet consequence already carries the weight.
  - BEAT 3 IS MANDATORY. The email is broken without it. Every single email must end on the offer, phrased as a question: two weeks free, set up around their clinic. If you find yourself running out of room, cut from beat 1, never from beat 3.

WHY-IT-MATTERS ARGUMENTS (use exactly one in beat 3, vary which one across emails):
  a) SELF-EVIDENT ARITHMETIC, framed with THEIR numbers, never ours: an unfilled sick day is that room empty for a full day, so the cost of finding cover fast is measured in one practitioner's day of billings. Say it as a plain observation they can check against their own rates. NEVER state a dollar figure, percentage, or hours-saved number.
  b) THE RECURRING TIME COST: rebuilding the weekly grid by hand is not a one-time cost, it repeats every week for as long as the clinic exists, and it always lands on the person with the least time.
  ${usesJane ? 'c) THE DOCUMENTED GAP (strongest, only for Jane clinics — this is verifiable from the published Jane guides, so it is safe to state): Jane does not put admin and front-desk staff on the schedule (their guide recommends an external calendar for that), Manage Shifts cannot do biweekly or rotating patterns, and non-percentage pay splits have to be calculated outside Jane in a spreadsheet. Reference at most ONE of these, plainly, as something they have probably run into rather than as a criticism of Jane.' : 'c) THE TWO-SYSTEM PROBLEM: the practitioner schedule and the front-desk/support schedule end up living in different places, so the two drift apart and someone reconciles them by hand.'}

CRITICAL — NO BORROWED STATISTICS: never cite a survey, study, benchmark, industry average, percentage, dollar amount, or "clinics typically save X hours". Industry statistics in cold email are unverifiable, and if the reader challenges one we cannot defend it. Every claim must be either self-evident arithmetic the reader can check against their own clinic, or a fact about their own software's published documentation. This rule outranks persuasiveness.`;
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
- Body: under 55 words. A friendly bump that leads with the demo so they can just watch instead of replying. Point them to the live demo at ${allied ? DEMO_URL_ALLIED : DEMO_URL_MEDICAL} (write it exactly, as plain text, no markdown link). Frame it as a version set up like a ${allied ? 'multi-practitioner allied clinic (physio, RMT, chiro)' : 'multi-provider clinic'} (this is true — the demo is a working clinic schedule). Then one plain line: it gets built around their clinic and can run in the tools they already use. Close by making a reply cost almost nothing: invite a single word back rather than a written response (vary the wording, never repeat a phrasing). No hard sell.
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

// Only run when invoked directly, so copy can be previewed without the module writing
// generated content to the database as a side effect of require().
if (require.main === module) {
  run().catch(err => { console.error('Fatal error:', err.message); process.exit(1); });
}

module.exports = { buildPrompt };
