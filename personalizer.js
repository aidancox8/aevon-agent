/**
 * personalizer.js
 * Fetches leads with no email content, uses Gemini to write a personalized
 * cold email + follow-up, then assigns a staggered send schedule for the week.
 *
 * Usage: node personalizer.js
 */

require('dotenv').config();
const supabase = require('./lib/supabase');
const { createGenerate } = require('./lib/gemini');
const { scrapeContext } = require('./lib/contact-finder');

// Own instance — separate cooldown state from lead finders
const generate = createGenerate(process.env.GEMINI_API_KEY);

// Rich multi-page scrape (homepage + services/about) so the model gets real
// detail to personalize on, not a 900-char homepage scrap.
async function scrapeWebsite(url) {
  return scrapeContext(url);
}

// Hard cap on any async step so one slow site or a stuck API call can never
// freeze the whole run (a single hung lead once stalled a run for 90 min).
function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// Normalize a subject for duplicate detection: lowercase, strip punctuation and
// extra spaces. Used to stop a batch of same-industry leads all getting the
// identical subject line (e.g. three mortgage leads -> "who chases the docs").
function normSubject(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

// Robustly pull the first balanced JSON object out of a model response,
// tolerating markdown fences and any stray text before/after it.
function parseJsonObject(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/```json/gi, '').replace(/```/g, '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
    } }
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

// Mark a lead eligible to send from the next weekday onward. The daily cap and
// score-based ordering are enforced in sender.js at send time, so we no longer
// spread leads across future days — a high-score lead found today competes for
// tomorrow's slots instead of waiting behind a month-long backlog.
function nextEligibleAt() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(SEND_HOUR_UTC, 0, 0, 0);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

function getIndustryContext(industry) {
  const i = (industry || '').toLowerCase();
  if (/physio|chiro|kinesio|rehab|sport.*med|occupational|multidisciplin|icbc|health clinic|medical|dental|optom|mental health|veterinar/.test(i))
    return 'Clinics with multiple practitioners or service types typically deal with a high volume of manual administrative work — intake forms, insurance billing, scheduling coordination across staff, and referral tracking.';
  if (/staffing|recruit|executive search/.test(i))
    return 'Staffing and recruitment firms run large volumes of outreach, candidate screening, and client communication that repeat across every placement cycle.';
  if (/real estate/.test(i))
    return 'Real estate teams often spend significant time manually following up with leads, preparing market reports, and coordinating listings and showings across multiple clients.';
  if (/mortgage|lending/.test(i))
    return 'Mortgage brokers handle a high volume of applications, document collection, and client follow-up that repeats across every deal.';
  if (/insurance/.test(i))
    return 'Insurance brokerages process a steady stream of quote requests, policy renewals, and document routing between clients and insurers — most of it handled manually over email.';
  if (/law firm|legal/.test(i))
    return 'Law firms spend significant staff time on document drafting, client intake coordination, and research that follows a similar pattern across many matters.';
  if (/account|bookkeep/.test(i))
    return 'Accounting firms collect documents from clients, generate reports, and manage deadlines across many files simultaneously — a lot of which is manual and repetitive.';
  if (/marketing|advertising|pr |public relation|seo|content|media buy/.test(i))
    return 'Marketing and creative agencies repeatedly produce the same types of deliverables — proposals, reports, campaign briefs, client updates — across many clients at once.';
  if (/hvac|plumb|electr.*contract|general contractor|field service|inspection|mechanical/.test(i))
    return 'Trades and field service companies coordinate dispatching, job tracking, and reporting across multiple crews or jobs running simultaneously.';
  if (/logistics|freight|import|export|warehouse|distribution|courier/.test(i))
    return 'Logistics and distribution companies route a high volume of shipping documents, supplier communications, and status updates across many shipments daily.';
  if (/property manag/.test(i))
    return 'Property management companies handle recurring communication with tenants, maintenance coordination, and owner reporting across a large portfolio.';
  if (/engineer|architect|survey|environment.*consult/.test(i))
    return 'Engineering and technical consulting firms produce recurring deliverables — field reports, assessments, project updates — across many active projects at once.';
  if (/consult/.test(i))
    return 'Consulting firms repeatedly produce proposals, status reports, and client deliverables across many engagements, much of it written from scratch each time.';
  return 'Growing businesses in the Lower Mainland often reach a point where their team is spending significant time on manual, repetitive internal work that holds them back.';
}

function buildPrompt(lead, websiteContent) {
  const industryContext = getIndustryContext(lead.industry);
  return `You are writing a cold outreach email on behalf of Aevon, a custom software company based in the Lower Mainland, BC.

About Aevon:
- Builds custom apps and AI agents for businesses dealing with manual, repetitive internal work
- Clients pay once and own the software outright — no subscriptions, no vendor lock-in
- Target clients: 5-50 employee businesses in the Lower Mainland

Industry context (general knowledge about this type of business — use only to inform tone and question, do not repeat verbatim or state as fact about this specific business):
${industryContext}

Lead details:
- Business name: ${lead.business_name}
- Industry: ${lead.industry}
- City: ${lead.city}
- Website: ${lead.website || 'unknown'}
${lead.qualification_notes ? `- What we know about them: ${lead.qualification_notes}` : ''}
${lead.lead_insights ? `- Their likely pain points: ${lead.lead_insights}` : ''}
${websiteContent ? `- Scraped from their website: ${websiteContent}` : ''}

Write TWO emails, a lead insight, and a personalization basis.

EMAIL 1 (initial outreach):
- Goal: get a reply. The reader decides in the first line whether to keep reading or delete, so the first line must be about THEM, not about Aevon.
- Subject line: lowercase, short (2-6 words), curiosity-driven, tied to the area of work you ask about in the body. NOT "Workflows at [Company]" or "Operations at [Company]" — those read like internal memos.
  CRITICAL — vary the GRAMMATICAL FORM, do not reuse a skeleton. The pattern "the [noun] grind / chase / shuffle / loop / bottleneck" has been massively overused and now reads as templated spam. Do NOT default to "the ___ grind". Rotate across genuinely different shapes, picking whichever fits this business:
  • a plain question: "still quoting by hand?", "who chases the missing docs?"
  • a fragment of the actual task: "re-keying every renewal", "same report, every project"
  • a quiet observation: "two systems, one client", "before the analysis even starts"
  • a noun phrase (use sparingly, NOT every time): "the renewal pileup"
  Derive it from the area of work you ask about, so two different businesses naturally get two different subjects. If the subject you first think of contains the word "grind", rewrite it in a different form. The bullet examples above show FORM ONLY — NEVER output any of them word-for-word (especially "still quoting by hand?" or "re-keying every renewal"); write a fresh subject specific to THIS business.
- Body structure (under 65 words total):
  This email is an ASK, not a pitch. The ONLY approach that has earned a positive reply so far was: briefly say who we are, make one honest observation, then ask an open question about their biggest time-sink. Do exactly that here. Asking what their biggest issue is consistently beats asserting a pain and pitching a fix.
  1. ONE line of plain context: that Aevon builds custom software and AI agents that take repetitive, manual admin work off small teams. One sentence — it earns the right to ask.
  2. ONE honest, light observation about a business like theirs — something you can genuinely stand behind: a real detail from the scrape if one exists, otherwise an industry-level truth (the kind of recurring intake / paperwork / follow-up / scheduling their type of business deals with). This is an OBSERVATION, not a diagnosis you plan to fix.
  3. AN OPEN QUESTION — the heart of the email. Ask what the most manual, repetitive, or time-consuming part of [a specific, relevant area of their work] is right now. Vary the wording and the area every time. Forms (do NOT copy verbatim): "What's the most time-consuming part of how you handle [X] right now?" / "Where does your team lose the most time on [X]?" / "What part of [X] still eats the most manual hours?"
  - Do NOT propose, name, or describe a solution or tool. Do NOT assert their pain as fact. Do NOT include a link. The goal is simply to get them talking about their biggest issue.
  - No sign-off — the signature block handles that.

CRITICAL anti-fabrication rules (read carefully):
- The observation in sentence 2 may be an honest, soft, industry-level truth ("businesses like yours usually handle a steady stream of X") — that is fine and human.
- But you may ONLY state a CONCRETE, specific fact about THIS business (a named service, a recent project, a stated specialty, team size, locations, awards, named clients) if it appears verbatim in the "Scraped from their website" text above. If it is not in the scrape, you do NOT know it — do not invent it.
- Never claim to have seen something specific you did not ("I saw your award", "congrats on the expansion", a specific client count or metric). Inventing specifics reads as a bot and destroys trust.
- If you have no real scraped detail, keep the observation general and true. A plainly honest general email beats a fake-specific one.

Other rules:
- Do NOT pitch a specific solution or product category. Do NOT open with flattery. Do NOT call Aevon a "shop".
- Tone: direct, human, a little casual. Like a person who actually understands their business, not a vendor. No buzzwords, no em dashes, no filler ("leverage", "streamline", "fragmentation", "off-the-shelf", "bridges the gap", "unified solution", "take that kind of work off a team's plate", "tiny").
- Each email must feel DIFFERENT from the last one written for the same industry. Vary sentence structure, the specific sub-task you name, and the closing question. Two brokers who compare emails should not see the same template.

EMAIL 2 (follow-up, send 5 days later if no reply):
- Subject line: brief, reply-thread style.
- Body: under 45 words, question-led like email 1. A friendly bump that re-asks about their biggest time-sink from a slightly DIFFERENT angle than email 1 — do not just repeat it. If it feels natural, you MAY add at the very end that it can be easier to show than describe, with a couple of quick examples, using the exact token {{DEMO}} where the link goes (it is replaced with a real tracked link at send time). Keep it an ask first; the examples are optional and secondary. No pitch.
- Tone: same plain, human voice.

LEAD INSIGHT (2-3 sentences): why this business fits Aevon, what workflow problems they likely have, and what specifically you would propose building if they reply.

PERSONALIZATION BASIS (one short line): state exactly what the email's opening pain was based on. If it used a real detail from the scrape, name it (e.g. "site lists custom syndicated reports"). If it was industry-level only, say "industry-level, no specific scrape detail". This is for the human to audit for hallucination.

Format your response as valid JSON only, no markdown, no explanation:
{
  "email_subject": "...",
  "email_body": "...",
  "followup_subject": "...",
  "followup_body": "...",
  "lead_insights": "...",
  "personalization_basis": "..."
}`;
}

async function run() {
  // --limit N personalizes only the top N (highest-score) leads — useful for a
  // small batch that won't collide with the lead finders' Gemini quota.
  const args = process.argv.slice(2);
  let limit = null;
  for (let i = 0; i < args.length; i++) if (args[i] === '--limit') limit = parseInt(args[++i], 10);

  // Fetch leads that need personalization (no email content yet, have an email address)
  let q = supabase
    .from('leads')
    .select('id, business_name, industry, city, website, email, lead_insights, qualification_notes')
    .is('email_subject', null)
    .not('email', 'is', null)
    .eq('status', 'queued')
    .order('qualification_score', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: true });
  if (limit) q = q.limit(limit);
  const { data: leads, error } = await q;

  if (error) throw new Error(`Supabase fetch failed: ${error.message}`);
  if (!leads || leads.length === 0) {
    console.log('No leads to personalize.');
    return;
  }

  console.log(`Personalizing ${leads.length} leads...\n`);

  let success = 0;
  let failed = 0;
  // Subjects already used — both ones already saved on other queued leads and
  // ones generated in THIS batch — so same-industry leads don't all land on the
  // identical subject line across runs.
  const usedSubjects = new Set();
  const { data: existingSubs } = await supabase
    .from('leads').select('email_subject').not('email_subject', 'is', null).limit(2000);
  (existingSubs || []).forEach(r => usedSubjects.add(normSubject(r.email_subject)));

  for (const lead of leads) {
    process.stdout.write(`  [${lead.business_name}]... `);

    try {
      // Scrape is best-effort: on timeout/failure, write the email without it.
      const websiteContent = await withTimeout(scrapeWebsite(lead.website), 15000, 'scrape').catch(() => null);
      if (websiteContent) process.stdout.write(`(scraped) `);
      const prompt = buildPrompt(lead, websiteContent);
      let content = parseJsonObject(await withTimeout(rateLimitedGenerate(prompt), 60000, 'gemini'));
      // One retry — richer context occasionally yields malformed JSON.
      if (!content || !content.email_subject || !content.email_body) {
        content = parseJsonObject(await withTimeout(rateLimitedGenerate(prompt + '\n\nReturn ONLY the JSON object, nothing before or after it.'), 60000, 'gemini'));
      }
      if (!content || !content.email_subject || !content.email_body) {
        throw new Error('No valid JSON with required fields after retry');
      }

      // If this subject duplicates one already used in the batch, regenerate it
      // once with an explicit instruction to pick a different form.
      if (usedSubjects.has(normSubject(content.email_subject))) {
        const dedupPrompt = prompt + `\n\nThe subject line "${content.email_subject}" has already been used for another business in this batch. Write the SAME email but with a DIFFERENT subject line, in a different grammatical form. Return ONLY the JSON object.`;
        const retry = parseJsonObject(await withTimeout(rateLimitedGenerate(dedupPrompt), 60000, 'gemini'));
        if (retry && retry.email_subject && retry.email_body) content = retry;
      }
      usedSubjects.add(normSubject(content.email_subject));

      const sendAt = nextEligibleAt();

      const { error: updateError } = await supabase
        .from('leads')
        .update({
          email_subject: content.email_subject,
          email_body: content.email_body,
          followup_subject: content.followup_subject,
          followup_body: content.followup_body,
          lead_insights: content.lead_insights || null,
          personalization_basis: content.personalization_basis || null,
          scheduled_send_at: sendAt,
        })
        .eq('id', lead.id);

      if (updateError) throw new Error(updateError.message);

      console.log(`eligible from ${new Date(sendAt).toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' })} (score-ranked at send)`);
      success++;

} catch (err) {
      console.log(`FAILED: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone. Personalized: ${success} | Failed: ${failed}`);
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
