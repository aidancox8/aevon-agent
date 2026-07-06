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
const { scrapeContext, classifyEmail } = require('./lib/contact-finder');

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

// Per-industry phrasing for what the Inbox Agent handles. The product is universal
// (every business gets inbound email); this makes the pitch land in THEIR words.
// Strategy note (2026-07): the ask-led email was retired after ~1,100 sends at ~0%
// genuine replies. Every email now shows the one productized offer, the Inbox Agent.
function inquiryProfile(industry) {
  const i = (industry || '').toLowerCase();
  if (/insurance/.test(i)) return 'quote requests and renewal emails';
  if (/mortgage|lending/.test(i)) return 'pre-approval inquiries and document chasing';
  if (/real estate|realtor|realty|real-estate/.test(i)) return 'buyer and listing inquiries';
  if (/business broker|biz broker|m&a|mergers/.test(i)) return 'buyer inquiries on listings';
  if (/account|bookkeep|tax/.test(i)) return 'client questions and document requests';
  if (/law|legal|notary/.test(i)) return 'intake requests and client follow-ups';
  if (/dental|medical|clinic|physio|chiro|vet|health|optometr|pharma|rehab|massage/.test(i)) return 'appointment requests and patient questions';
  if (/hvac|plumb|electric|roof|landscap|contract|renovat|construction|moving|clean|painting/.test(i)) return 'quote requests and job inquiries';
  if (/property manag|strata/.test(i)) return 'tenant and owner emails';
  if (/logistic|freight|courier|transport|shipping|import|export|distribut/.test(i)) return 'rate requests and shipment questions';
  if (/manufactur|machin|fabricat|industrial/.test(i)) return 'quote requests and order emails';
  if (/marketing|advertis|design|creative|media/.test(i)) return 'new-business inquiries and client requests';
  if (/immigration|consult|recruit|staffing/.test(i)) return 'consultation requests and client emails';
  if (/school|educat|tutor|academy|college/.test(i)) return 'enrollment and parent inquiries';
  if (/event|rental|catering|restaurant|venue/.test(i)) return 'booking and quote requests';
  if (/engineer|architect|survey|environment/.test(i)) return 'project inquiries and RFQs';
  return 'the inquiries and quote requests that land in their inbox';
}

function buildPrompt(lead, websiteContent) {
  const industryContext = getIndustryContext(lead.industry);
  const what = inquiryProfile(lead.industry);
  const email1Block = `EMAIL 1 (initial outreach, SHOW-THE-PRODUCT approach):
- Goal: get a reply by offering a 90-second demo of ONE specific product, the Aevon Front Desk agent, described in THEIR terms. Do NOT ask open discovery questions (tested for months, near-zero replies). Show the thing and make it concrete.
- CRITICAL POSITIONING: this is NOT an email-writing assistant. Gmail and Outlook already ship AI that helps write replies, so NEVER describe it in those terms ("reads your email", "drafts replies for you" as the headline). Sell the WORKER: it runs their intake end to end. It answers and qualifies ${what}, books the appointment or showing, files every lead into a simple pipeline, and follows up with the ones that go quiet. The owner just approves.
- HARD CAPABILITY CONTRACT: the agent does EXACTLY five things: (1) answers and qualifies inbound inquiries, (2) drafts the replies in the owner's voice, (3) books appointments/showings/calls, (4) files every lead into a pipeline board, (5) follows up with leads that go quiet. Describe ONLY these, phrased for their business. NEVER invent other capabilities (writing reports, checking application status, processing paperwork, integrations you have not been told about). Describe it handling ${what} specifically, do not substitute a different task or a different industry's inquiries.
- Price in email 1: you may say "$1,500 flat setup, live inside a week, you own it". Do NOT mention the monthly fee in email 1 (the follow-up covers full terms).
- Subject line: lowercase, short (2-5 words), about their inquiries / front desk / intake. Vary the grammatical form (a plain question, a fragment, a quiet observation). NEVER reuse a skeleton, never the word "grind". Fresh and specific to this business.
- Body (under 70 words), and DO NOT include any link:
  1. ONE plain line of who you are: Aevon builds AI front desk agents for Lower Mainland businesses.
  2. ONE or TWO lines on what it does for a business like theirs, per the positioning above. If a REAL scraped detail exists, weave it in naturally instead of generic phrasing.
  3. ONE line of productized concreteness: flat setup fee, live inside a week, and they own it.
  4. The ask, low friction: do they want the 90 second demo? Make yes easy ("happy to send it over").
  - No link in email 1 (it goes out when they say yes, or in the follow-up). No feature dump. Do NOT assert their pain as fact. No sign-off (the signature handles that).`;
  return `You are writing a cold outreach email on behalf of Aevon, a software company based in the Lower Mainland, BC.

About Aevon:
- Flagship product: the Aevon Front Desk agent. It runs a business's inbound intake end to end: answers and qualifies every inquiry, drafts replies in the owner's voice, books appointments, files every lead into a simple pipeline board, and follows up with leads that go quiet. Nothing sends without the owner's approval.
- It is NOT a generic email assistant (Gmail/Outlook already have those). It is wired into how the specific business works: their services, their booking rules, their documents, their pipeline.
- Productized: $1,500 flat setup, live inside a week, then $150/month to run, monitor, and tune it. The client owns the software.
- Also builds fully custom apps and AI agents for businesses that need more than the flagship.
- Target clients: 1-50 employee businesses in the Lower Mainland

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

Write THREE emails, a lead insight, and a personalization basis.

${email1Block}

CRITICAL anti-fabrication rules (read carefully):
- Any observation about their business may be an honest, soft, industry-level truth ("businesses like yours usually handle a steady stream of X") — that is fine and human.
- But you may ONLY state a CONCRETE, specific fact about THIS business (a named service, a recent project, a stated specialty, team size, locations, awards, named clients) if it appears verbatim in the "Scraped from their website" text above. If it is not in the scrape, you do NOT know it — do not invent it.
- Never claim to have seen something specific you did not ("I saw your award", "congrats on the expansion", a specific client count or metric). Inventing specifics reads as a bot and destroys trust.
- If you have no real scraped detail, keep the observation general and true. A plainly honest general email beats a fake-specific one.

Other rules:
- Pitch ONLY the Inbox Agent. Do not invent other products or promise custom scopes. Do NOT open with flattery. Do NOT call Aevon a "shop".
- Tone: direct, human, a little casual. Like a person who actually understands their business, not a vendor. No buzzwords, no em dashes, no filler ("leverage", "streamline", "fragmentation", "off-the-shelf", "bridges the gap", "unified solution", "take that kind of work off a team's plate", "tiny").
- Each email must feel DIFFERENT from the last one written for the same industry. Vary sentence structure, the specific inquiry type you name, and the closing ask. Two brokers who compare emails should not see the same template.

EMAIL 2 (follow-up, send 5 days later if no reply):
- Subject line: brief, reply-thread style.
- Body: under 55 words. A friendly bump that leads with the demo so they can just watch instead of replying: include the exact token {{DEMO}} (replaced with a real tracked link at send time), e.g. "here it is if it's easier to just watch: {{DEMO}}". Then name the terms in one plain line: $1,500 flat setup, live in about a week, $150 a month to run and tune it, and they own it. Close with one easy line inviting a reply. No hard sell.
- Tone: same plain, human voice.

EMAIL 3 (final follow-up, sent 5 days after email 2 if still no reply):
- Subject line: brief, reply-thread style.
- Body: under 40 words. This is the LAST time you'll reach out, and you say so plainly — that honesty creates a little gentle urgency for anyone with even slight interest. No guilt-trip, no pressure. Acknowledge they're busy, say you'll leave it here, and leave the door open with one easy-to-answer line. Shape (do NOT copy verbatim): "I'll leave it here so I'm not cluttering your inbox. If handing off [their inquiry type] is ever worth a look, just reply and I'll pick it back up. Either way, all the best." No pitch, no link.
- Tone: same plain, human voice.

LEAD INSIGHT (2-3 sentences): why this business fits Aevon, what workflow problems they likely have, and what specifically you would propose building if they reply.

PERSONALIZATION BASIS (one short line): state exactly what the email's opening pain was based on. If it used a real detail from the scrape, name it (e.g. "site lists custom syndicated reports"). If it was industry-level only, say "industry-level, no specific scrape detail". This is for the human to audit for hallucination.

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
  // --limit N personalizes only the top N (highest-score) leads — useful for a
  // small batch that won't collide with the lead finders' Gemini quota.
  const args = process.argv.slice(2);
  let limit = null;
  for (let i = 0; i < args.length; i++) if (args[i] === '--limit') limit = parseInt(args[++i], 10);

  // Fetch leads that need personalization (no email content yet, have an email
  // address), score-ordered. We pull the FULL pool (not the DB --limit) so we can
  // re-tier named contacts ahead of role inboxes before applying the limit — that
  // way the scarce Gemini quota goes to the leads most likely to send AND convert.
  const { data: pool, error } = await supabase
    .from('leads')
    .select('id, business_name, industry, city, website, email, lead_insights, qualification_notes')
    .is('email_subject', null)
    .not('email', 'is', null)
    .eq('status', 'queued')
    .order('qualification_score', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Supabase fetch failed: ${error.message}`);
  if (!pool || pool.length === 0) {
    console.log('No leads to personalize.');
    return;
  }

  // Named contacts first (a decision-maker's personal inbox beats info@/sales@ for
  // both reachability and reply rate), preserving score order within each tier.
  const isNamed = l => classifyEmail((l.email || '').split('@')[0]) === 'personal';
  const named = pool.filter(isNamed);
  const role = pool.filter(l => !isNamed(l));
  let leads = [...named, ...role];
  if (limit) leads = leads.slice(0, limit);

  console.log(`Personalizing ${leads.length} leads (${named.length} named, ${role.length} role/generic in pool)...\n`);

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

      // Gemini ignores the no-em-dash instruction often, so strip em/en dashes from
      // every generated field. A dash used as a break becomes a comma; this is the
      // single biggest "this was written by AI" tell, so it must never ship.
      const noDash = s => (s == null ? s : String(s).replace(/\s*[—–]\s*/g, ', '));

      const { error: updateError } = await supabase
        .from('leads')
        .update({
          email_subject: noDash(content.email_subject),
          email_body: noDash(content.email_body),
          followup_subject: noDash(content.followup_subject),
          followup_body: noDash(content.followup_body),
          followup2_subject: noDash(content.followup2_subject) || null,
          followup2_body: noDash(content.followup2_body) || null,
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
