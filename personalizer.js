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

const DAILY_LIMIT = 30; // max emails per weekday (domain still young - keep conservative until ~6-8 weeks old)
const SEND_HOUR_UTC = 16; // 9am PT

// Returns the next weekday send date that hasn't hit DAILY_LIMIT yet.
// Multiple leads can share the same day — sender.js handles per-send pacing.
function nextWeekdaySendSlot(dayCounts) {
  const candidate = new Date();
  candidate.setUTCDate(candidate.getUTCDate() + 1);
  candidate.setUTCHours(SEND_HOUR_UTC, 0, 0, 0);

  for (let i = 0; i < 90; i++) {
    const dow = candidate.getUTCDay();
    if (dow >= 1 && dow <= 5) {
      const key = candidate.toISOString().slice(0, 10);
      const count = dayCounts.get(key) || 0;
      if (count < DAILY_LIMIT) {
        dayCounts.set(key, count + 1);
        return candidate.toISOString();
      }
    }
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }

  throw new Error('Could not find an open send slot in the next 90 days');
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

Write TWO emails AND a lead insight:

EMAIL 1 (initial outreach):
- Goal: get a reply where they describe their workflow problems. Do NOT pitch a specific solution — that comes after they respond.
- Subject line: short, curiosity-driven, specific to their industry or business. Not salesy.
- Body structure (under 60 words total):
  * One sentence introducing Aevon as a company that builds custom apps and AI agents for businesses dealing with manual, repetitive work — keep it broad, do not name a specific product category
  * One sentence that shows you understand their world — reference something specific about their industry or what you found on their website
  * One open question asking what the most manual or time-consuming part of their workflow is right now
  * No sign-off — the signature block handles that
- Do NOT propose any solution in this email
- Do NOT open with a compliment or flattery
- Do NOT fabricate specific details — only use what is provided above
- Do NOT describe Aevon as a "shop" or "local shop"
- Tone: direct, human, curious. Write like a person reaching out, not a vendor pitching. No buzzwords, no em dashes, no filler ("leverage", "streamline", "fragmentation", "off-the-shelf", "bridges the gap", "unified solution")

EMAIL 2 (follow-up, send 5 days later if no reply):
- Subject line: brief, reply-thread style
- Body: under 40 words. Friendly bump. Restate the question in a slightly different way. No pitch.
- Tone: same — plain, human

LEAD INSIGHT (2-3 sentences):
- Why this business is a good fit for Aevon
- What specific workflow problems they likely have based on their industry and website
- Whether a custom app or an AI agent would be the better solution, and specifically what you would propose building if they reply

Format your response as valid JSON only, no markdown, no explanation:
{
  "email_subject": "...",
  "email_body": "...",
  "followup_subject": "...",
  "followup_body": "...",
  "lead_insights": "..."
}`;
}

async function run() {
  // Fetch leads that need personalization (no email content yet, have an email address)
  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, business_name, industry, city, website, email, lead_insights, qualification_notes')
    .is('email_subject', null)
    .not('email', 'is', null)
    .eq('status', 'queued')
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Supabase fetch failed: ${error.message}`);
  if (!leads || leads.length === 0) {
    console.log('No leads to personalize.');
    return;
  }

  console.log(`Personalizing ${leads.length} leads...\n`);

  // Count existing scheduled sends per day to respect daily limit
  const { data: scheduled } = await supabase
    .from('leads')
    .select('scheduled_send_at')
    .not('scheduled_send_at', 'is', null);

  const dayCounts = new Map();
  (scheduled || []).forEach(r => {
    const key = r.scheduled_send_at.slice(0, 10);
    dayCounts.set(key, (dayCounts.get(key) || 0) + 1);
  });

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

      const sendAt = nextWeekdaySendSlot(dayCounts);

      const { error: updateError } = await supabase
        .from('leads')
        .update({
          email_subject: content.email_subject,
          email_body: content.email_body,
          followup_subject: content.followup_subject,
          followup_body: content.followup_body,
          lead_insights: content.lead_insights || null,
          scheduled_send_at: sendAt,
        })
        .eq('id', lead.id);

      if (updateError) throw new Error(updateError.message);

      console.log(`scheduled ${new Date(sendAt).toLocaleString('en-CA', { timeZone: 'America/Vancouver' })}`);
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
