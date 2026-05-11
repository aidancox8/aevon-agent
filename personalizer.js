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
const { generate } = require('./lib/gemini');

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

// Spread sends across Mon-Fri 9am-4pm PT (UTC-7 = UTC+0 offset of 16-23)
// scheduled_send_at stored in UTC
const SEND_HOURS_UTC = [16, 17, 18, 19, 20, 21, 22, 23]; // 9am-4pm PT

function nextWeekdaySendSlot(existingSlots) {
  const now = new Date();

  // Start from tomorrow
  const candidate = new Date(now);
  candidate.setUTCDate(candidate.getUTCDate() + 1);
  candidate.setUTCMinutes(0);
  candidate.setUTCSeconds(0);
  candidate.setUTCMilliseconds(0);

  // Walk forward until we land on a weekday send slot not already taken
  for (let day = 0; day < 14; day++) {
    const dow = candidate.getUTCDay(); // 0=Sun, 6=Sat
    if (dow >= 1 && dow <= 5) {
      for (const hour of SEND_HOURS_UTC) {
        candidate.setUTCHours(hour);
        const iso = candidate.toISOString();
        if (!existingSlots.has(iso)) {
          existingSlots.add(iso);
          return iso;
        }
      }
    }
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }

  throw new Error('Could not find an open send slot in the next 14 days');
}

function buildPrompt(lead, websiteContent) {
  return `You are writing a cold outreach email on behalf of Aevon, a custom business software company based in the Lower Mainland, BC.

About Aevon:
- Builds custom internal tools tailored exactly to how a business actually operates
- Replaces the patchwork of SaaS tools and manual workarounds most growing teams rely on
- Clients pay once and own the software outright — no seat-based pricing, no vendor lock-in
- Typical projects: internal workflow tools, scheduling apps, document management, AI-powered knowledge bases
- Target clients: 5-50 employee businesses in the Lower Mainland dealing with operational friction

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
- Subject line: short, specific, not salesy — reference something concrete about their business or industry
- Body: 3 sentences max per paragraph, 2 paragraphs max total. One sentence to name the operational pain point. One to two sentences introducing Aevon. One clear CTA (15-min call). Sign off as "Aidan" from Aevon.
- The whole email body should be under 80 words. Treat every word as earned.
- Do NOT open with a compliment or flattery
- Do NOT fabricate specific details (employee counts, property counts, revenue figures) — only use what is provided in the lead details above
- Do NOT focus on software costs or savings — focus on the operational problem and what having the right tool makes possible
- Do NOT describe Aevon as a "shop" or "local shop" — refer to it as "Aevon" or "we"
- Tone: direct, confident, conversational. No buzzwords, no em dashes, no filler phrases

EMAIL 2 (follow-up, send 5 days later if no reply):
- Subject line: brief, reply-thread style
- Body: 2 short paragraphs, under 60 words total. Friendly bump, one new angle or specific use case. Same CTA.
- Tone: same as above

LEAD INSIGHT (2-3 sentences):
- Why this business is a good fit for Aevon
- What specific operational pain points they likely have based on their industry and size
- What type of custom tool would most benefit them

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

  // Load existing scheduled slots to avoid collisions
  const { data: scheduled } = await supabase
    .from('leads')
    .select('scheduled_send_at')
    .not('scheduled_send_at', 'is', null);

  const existingSlots = new Set((scheduled || []).map(r => new Date(r.scheduled_send_at).toISOString()));

  let success = 0;
  let failed = 0;

  for (const lead of leads) {
    process.stdout.write(`  [${lead.business_name}]... `);

    try {
      const websiteContent = await scrapeWebsite(lead.website);
      if (websiteContent) process.stdout.write(`(scraped) `);
      const prompt = buildPrompt(lead, websiteContent);
      const raw = await generate(prompt);

      // Extract JSON - handle markdown fences and stray text
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON object found in Gemini response');
      const content = JSON.parse(jsonMatch[0]);

      if (!content.email_subject || !content.email_body) {
        throw new Error('Missing required fields in Gemini response');
      }

      const sendAt = nextWeekdaySendSlot(existingSlots);

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

      // Respect Gemini rate limit (primary model: 15 RPM)
      await new Promise(r => setTimeout(r, 4500));

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
