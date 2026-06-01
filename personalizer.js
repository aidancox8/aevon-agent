/**
 * personalizer.js
 * Fetches leads with no email content, uses Gemini to write a personalized
 * cold email + follow-up, then assigns a staggered send schedule for the week.
 *
 * Usage: node personalizer.js
 */

require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const supabase = require('./lib/supabase');
const { createGenerate } = require('./lib/gemini');

// Own instance — separate cooldown state from lead finders
const generate = createGenerate(process.env.GEMINI_API_KEY);

async function scrapeWebsite(url) {
  if (!url) return null;
  try {
    const { data } = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
    });
    const $ = cheerio.load(data);
    $('script, style, nav, footer, noscript, iframe').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 900);
    return text || null;
  } catch {
    return null;
  }
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
- Subject line: lowercase, short (2-5 words), curiosity-driven, hints at a specific pain. NOT "Workflows at [Company]" or "Operations at [Company]" — those read like internal memos. Good examples: "the report grind", "the part that doesn't scale", "before the analysis even starts".
- Body structure (under 65 words total):
  1. FIRST sentence: name a specific, repetitive operational pain that a business like theirs realistically lives with. Describe the grind concretely (the manual re-keying, the rebuilding-the-same-thing, the chasing). Make them think "that's me." Do NOT mention Aevon yet.
  2. SECOND sentence: one short clause on what you do, framed as relief for THAT pain ("I build small tools that take that kind of work off a team's plate"). Aevon as a verb for them, not a company intro.
  3. THIRD: a specific yes/no-style hypothesis question that is easy to answer in 5 seconds — "Is that a real time-sink for you, or something you've already handled?" NOT the open-ended "what is the most time-consuming part of your workflow" (that asks them to do unpaid homework).
  - No sign-off — the signature block handles that.

CRITICAL anti-fabrication rules (read carefully):
- You may ONLY state a concrete fact about THIS specific business (a named service, a recent project, a stated specialty, team size, locations, awards) if it appears verbatim in the "Scraped from their website" text above. If it is not in the scrape, you do NOT know it.
- NEVER write "I noticed...", "I saw...", "Given your high volume of...", "congrats on..." about something you cannot see in the scrape. That fake-specificity reads as a bot and destroys trust.
- If you have no real scraped detail, describe the pain at the INDUSTRY level honestly (no false "I noticed"). A plainly true general email beats a fake-specific one.
- Never invent metrics, client names, contract wins, headcounts, or events.

Other rules:
- Do NOT pitch a specific solution or product category. Do NOT open with flattery. Do NOT call Aevon a "shop".
- Tone: direct, human, a little casual. Like a person who actually understands their business, not a vendor. No buzzwords, no em dashes, no filler ("leverage", "streamline", "fragmentation", "off-the-shelf", "bridges the gap", "unified solution", "high volume of").

EMAIL 2 (follow-up, send 5 days later if no reply):
- Subject line: brief, reply-thread style.
- Body: under 40 words. Friendly bump from a different angle than email 1 — do not just repeat it. Offer something small ("want me to send a 2-minute example of what I mean?") rather than re-asking the same question. No pitch.
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

  for (const lead of leads) {
    process.stdout.write(`  [${lead.business_name}]... `);

    try {
      const websiteContent = await scrapeWebsite(lead.website);
      if (websiteContent) process.stdout.write(`(scraped) `);
      const prompt = buildPrompt(lead, websiteContent);
      const raw = await rateLimitedGenerate(prompt);

      // Extract JSON - handle markdown fences and stray text
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON object found in Gemini response');
      const content = JSON.parse(jsonMatch[0]);

      if (!content.email_subject || !content.email_body) {
        throw new Error('Missing required fields in Gemini response');
      }

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
