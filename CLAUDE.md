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

## Positioning and pricing (UPDATED 2026-07-05, supersedes older docs)
Offer (UPDATED 2026-08-03): **no productized flagship.** The Front Desk agent was retired as the lead offer: as a product it competed against cheaper tools with years of track record, which is a losing frame for a business with no clients. Aevon now sells what a SaaS company structurally cannot: software built around one specific business. **The lead offer is a FREE working skeleton** of one process they do by hand, theirs either way, framed honestly as limited because Aidan is early and building a track record. It ends once he has the workload. Cost ceiling: time only, no paid APIs, no metered services, no ongoing running costs (see sales/free-skeleton-offer.md). Price is never mentioned in cold email 1. The Front Desk build still exists and can be sold, it is just not the pitch.
CRITICAL: never position it as an email-writing assistant (Gmail/Copilot own that). It is a worker wired into THEIR workflow: qualify, book, send documents, file, chase. Custom builds beyond the flagship: quote per scope (sales/quote-template.md).
Strategy of record: demo-first everywhere, warm channels (referral partners, network) as the growth engine, cold email on autopilot only, dogfood case study for proof. Rationale: ~1,100 cold sends at ~0% genuine replies incl. a verified-contact A/B killed cold-as-primary-channel.

## System map
- **Pipeline:** lead-finder.js / agent-lead-finder.js (Google Places, BC-only guard) -> personalizer.js (Gemini, 3-email ask-led sequence) -> sender.js (Resend, DAILY_CAP secret=85 paced across the 8 hourly runs, --send required locally but not in CI, halts above a 5% bounce rate, named-contacts first, never status!='queued') -> landing pages with ?ref= visit tracking + interest button -> reply-processor.js (Gmail OAuth, drafts only).
- **Workflows (GitHub Actions):** send-outreach (hourly weekdays), process-replies (hourly offset), personalize (6am PT, scheduled runs capped --limit 450 so they exit cleanly instead of hitting GitHub's 6h kill), signals-digest (7:35am PT weekdays, commits signals/latest.md), enrich (manual). repeat-visitors still has a live 5:10pm PT cron despite an older note calling it disabled. daily-review (6:05pm PT) emails an end-of-day digest across both campaigns. All workflows email [Aevon ALERT] to aidan@aevon.ca on failure.
- **Cloud routine:** "Aevon morning replies briefing" (weekdays 8am PT, trig_016e43ep7bHUmvTArah9C2fc) reads inbox, drafts replies, reads warm signals from raw.githubusercontent.com/aidancox8/aevon-agent/master/signals/latest.md (its sandbox CANNOT reach supabase.co or github.io; raw.githubusercontent.com works), posts 9am calendar-event briefing.
- **CRM:** GitHub Pages at aidancox8.github.io/aevon-agent/crm/ (single-file crm/index.html).
- **Demos:** aevon.ca/agent-reel.html = Gmail-replica agent demo, preset-driven (?v=realestate|mortgage|insurance, default = Jean's broker version — do not change the default, his outreach links depend on it). Vertical landing pages (insurance/realestate/mortgage.html) embed the matching preset.
- **Supabase project:** qzxtfgzpyptvriorfhxw (leads, email_events tables; track-visit edge function).

## Current focus (June 2026)
Two warm leads, both Jean Seguin (multi-brand business broker): main thread + Restaurant Business Broker thread. Tailored demo sent. Watch for his reply/visit; do not chase more than agreed. Outbound runs at 55/day with ask-led copy; reply rate the key metric. SEO basics done (GSC verified, sitemap, GA4 G-M9R5SHY2LD, vertical pages); GBP pending verification.
