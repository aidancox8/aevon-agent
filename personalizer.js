/**
 * personalizer.js
 * Fetches leads with no email content, uses Gemini to write a personalized
 * cold email + follow-up, then assigns a staggered send schedule for the week.
 *
 * Usage: node personalizer.js
 */

require('dotenv').config();
const supabase = require('./lib/supabase');
const { generate } = require('./lib/gemini');

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

function buildPrompt(lead) {
  return `You are writing a cold outreach email on behalf of Aevon, a custom business app development company based in the Lower Mainland, BC.

About Aevon:
- Builds custom internal software tailored exactly to a business's workflow
- No per-seat pricing, no subscription lock-in — clients pay once and own the software
- Typical projects: internal tools, document signing, scheduling apps, AI-powered knowledge bases
- Price range: $1,500-$8,000 one-time build fee, optional $50-75/mo hosting + maintenance
- Target clients: 5-50 employee businesses in the Lower Mainland frustrated with SaaS costs or workarounds

Lead details:
- Business name: ${lead.business_name}
- Industry: ${lead.industry}
- City: ${lead.city}
- Website: ${lead.website || 'unknown'}

Write TWO emails AND a lead insight:

EMAIL 1 (initial outreach):
- Subject line: short, specific, not salesy
- Body: 3-4 short paragraphs. Open with a specific observation about their industry's common software pain point. Pitch Aevon briefly. One clear CTA (15-min call). Sign off as "Aidan" from Aevon.
- Tone: direct, human, no buzzwords, no em dashes

EMAIL 2 (follow-up, send 5 days later if no reply):
- Subject line: brief reply thread style (e.g. "Re: [original subject]" or a new short line)
- Body: 2 short paragraphs. Friendly bump, add one new angle or specific example relevant to their industry. Same CTA.
- Tone: same as above

LEAD INSIGHT (2-3 sentences):
- Why this business is a good fit for Aevon
- What specific software pain points they likely have based on their industry and size
- What type of custom app would most benefit them

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
    .select('id, business_name, industry, city, website, email')
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
      const prompt = buildPrompt(lead);
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
