# Aevon — Agent Context

You are working on Aevon, Aidan Cox's custom-software/AI-agent business for Lower Mainland BC SMBs (1-99 staff). This repo is the outreach machine (lead finders, personalizer, sender, reply-processor, CRM). The website repo is `aidancox8/aevon-website` (deploys to aevon.ca via GitHub Pages, branch `main`; this repo uses `master`).

**Read `memory-sync/` in this repo first** — it holds the full working memory: business state, strategy, and standing rules. `memory-sync/project_aevon.md` is the master context file.

## Hard rules (never break these)
1. **Never send any email to a lead or prospect.** Replies are always drafted (Gmail Drafts) for Aidan's approval. The only auto-send allowed is the cold-outreach sender pipeline (already approved) and internal notifications to aidan@aevon.ca.
2. **Never auto-email Jean Seguin** (jean@vancouvercommercialbrokers.ca, info@restaurantbusinessbroker.ca, sales@restaurantbusinessbroker.ca) — active warm conversation, handled personally.
3. **Snapshot before destructive DB ops:** `CREATE TABLE IF NOT EXISTS leads_backup_<YYYYMMDD> AS TABLE leads;` before any bulk DELETE/UPDATE on Supabase.
4. **No em dashes** in any client-facing copy, email, or comment. Use commas or periods.
5. Always commit AND push after editing files in either Aevon repo — deploys happen on push.
6. CAD for all pricing. Never fabricate clients/references (zero clients so far). Cold copy must sound human-typed: ask-led, no pitch in email 1.

## Positioning and pricing
"You're paying monthly for software that almost fits. I build exactly what you need. You own it. No subscriptions, no per-seat fees." Builds $1,500-8,000 CAD scoped upfront, optional $50-75/mo hosting, deposit before build, never pay-after-satisfaction. Next step with warm leads is always: call or email questions -> plan + quote -> contract + payment -> build.

## System map
- **Pipeline:** lead-finder.js / agent-lead-finder.js (Google Places, BC-only guard) -> personalizer.js (Gemini, 3-email ask-led sequence) -> sender.js (Resend, DAILY_CAP env=55, named-contacts first, never status!='queued') -> landing pages with ?ref= visit tracking + interest button -> reply-processor.js (Gmail OAuth, drafts only).
- **Workflows (GitHub Actions):** send-outreach (hourly weekdays), process-replies (hourly offset), personalize (6am PT + manual w/ limit input), repeat-visitors (5:10pm signal email), enrich (manual). All email [Aevon ALERT] to aidan@aevon.ca on failure.
- **Cloud routine:** "Aevon morning replies briefing" (weekdays 8am PT) reads inbox, drafts replies, posts 9am calendar-event briefing.
- **CRM:** GitHub Pages at aidancox8.github.io/aevon-agent/crm/ (single-file crm/index.html).
- **Demos:** aevon.ca/agent-reel.html = Gmail-replica agent demo, preset-driven (?v=realestate|mortgage|insurance, default = Jean's broker version — do not change the default, his outreach links depend on it). Vertical landing pages (insurance/realestate/mortgage.html) embed the matching preset.
- **Supabase project:** qzxtfgzpyptvriorfhxw (leads, email_events tables; track-visit edge function).

## Current focus (June 2026)
Two warm leads, both Jean Seguin (multi-brand business broker): main thread + Restaurant Business Broker thread. Tailored demo sent. Watch for his reply/visit; do not chase more than agreed. Outbound runs at 55/day with ask-led copy; reply rate the key metric. SEO basics done (GSC verified, sitemap, GA4 G-M9R5SHY2LD, vertical pages); GBP pending verification.
