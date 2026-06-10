---
name: Aevon - Custom Business App Development
description: Aevon positioning, offerings, portfolio, pricing model, infrastructure, and next steps
type: project
originSessionId: f3c995de-be61-4625-860f-2dce2c309366
---
Business is named **Aevon** — custom business app development for Lower Mainland SMBs (5-50 employees), with optional AI capabilities.

- aevon.ca: **purchased** (Namecheap, NS1 nameservers). DNS configured and propagated. GitHub Pages verification pending but site loads.
- aevon.com is a European bike company; no conflict
- Separate brand from Tech Neighbour BC (residential IT support)
- Google Workspace set up for hello@aevon.ca ($9.20/mo CAD)

## Core Positioning

Generic SaaS tools are built for everyone, which means they're perfect for no one. Businesses end up paying for features they don't use, building workarounds for gaps, and purchasing add-ons that still don't fully solve the problem. Aevon builds apps tailored exactly to a business's workflow — nothing more, nothing less — with no per-seat pricing and no subscription lock-in.

M365 consulting is no longer the primary focus. Custom app development is the core offering.

## Target Client

- 10-50 employee SMBs in the Lower Mainland
- General SMB (not healthcare for now — PHI/PIPEDA adds complexity)
- Office managers, operations leads, business owners
- Businesses frustrated with SaaS costs or workarounds

## Portfolio (built at current job — anonymized for pitching)

- Company wiki with AI chatbot (document ingestion, Q&A, onboarding/training modules) — strongest case study. Stack: Render + Firebase + Claude API.
- IT ticketing app
- Project management system
- Document signing software (replaces DocuSign etc.)
- Medical scheduling software
- Power Automate flows (various internal automations)
- Workout/dieting app (Kinetica — separate personal project)

## Flagship App Types to Lead With

1. Internal tools (ticketing, requests, workflows)
2. Document signing (easy cost savings pitch vs DocuSign)
3. Custom scheduling
4. AI-powered knowledge base / company wiki

## Service Packages (from service-packages.md)

- **Starter** $500-800 — M365 audit + 3 Power Automate flows + basic AI + 1hr training + 30d support
- **Knowledge Base** $1,000-2,000 — SharePoint intranet + AI wiki + doc migration + 60d support
- **Full Build** $2,500-5,000 — Full intranet + AI wiki + onboarding + 5 flows + training + 90d support
- **Retainer Basic** $150/mo — 30min/mo call, 2hrs changes, 48hr email support
- **Retainer Standard** $300/mo — 1hr/mo call, 5hrs dev, 24hr support, new flows
- **Retainer Pro** $600/mo — biweekly calls, 10hrs dev, same-day support, quarterly strategy
- All packages include free 30-min discovery call. Pitch retainer after every project.
- Do NOT underprice early projects.

## Pricing Model (custom app builds)

- One-time build fee scoped upfront ($1,500-8,000 depending on complexity)
- Optional hosting + maintenance: $50-75/mo (cheaper than SaaS equivalent)
- Rent-to-own option: $X/mo for 12 months, then they own it outright
- Do NOT do "pay after satisfaction" — no leverage once delivered

## Key Pitch Angle

"You're paying $X/month for software that almost does what you need. You've built workarounds. You've bought add-ons. I'll build you exactly what your business actually needs — you own it, no subscription."

## Folder Structure

```
C:\Users\Aidan\projects\aevon\
  business-notes.md          — early positioning notes (M365 focus, now evolved)
  service-packages.md        — detailed service package pricing
  agent/                     — outreach pipeline + CRM (see Agent + CRM System below)
  website/                   — public website
    index.html               — live deployed site
    privacy.html             — privacy page
    new design/              — newer React-based design (not yet deployed)
      index (1).html
      app-showcase.jsx
      roi-calc.jsx
      tweaks-panel (1).jsx
      privacy.html
```

## Agent + CRM System

Built at `C:\Users\Aidan\projects\aevon\agent\`. GitHub: `github.com/aidancox8/aevon-agent` (private).

**Scripts:**
- `node lead-finder.js` — scrapes Google Places across 17 business types + 9 cities, Gemini qualifies each lead (score 7+ saved). Test with `--query "X" --city "Y"` flags before full sweep.
- `node personalizer.js` — generates personalized cold email + follow-up per lead using Gemini (uses lead_insights + qualification_notes for personalization), assigns staggered weekday send schedule
- `node sender.js` — sends due emails via Resend (HTML), logs events to Supabase. Distinguishes permanent bounces from transient API errors.
- `node db-migrate.js` — runs all schema migrations against Supabase (safe to re-run anytime)

**17 target categories:** property management, construction, marketing agencies, law firms, engineering firms, staffing agencies, insurance brokerages, financial advisory, IT consulting, logistics, wholesale distributors, environmental consulting, architecture firms, accounting firms, manufacturing, security companies, event planning.

**9 cities:** Vancouver, Burnaby, Surrey, Richmond, Langley, Coquitlam, Abbotsford, North Vancouver, New Westminster.

**Weekend workflow:** run lead-finder → personalizer → done. GitHub Actions sends emails Mon-Fri 9am-4pm PT automatically (cron currently disabled until hello@aevon.ca verified in Resend).

**Sending address:** `aidan@aevon.ca` — verified in Resend, user confirmed they can receive email there. FROM_EMAIL GitHub secret set May 18 2026; all sends since May 19 go from this address. reply_to header also set to aidan@aevon.ca in sender.js.

**Reply detection (BUILT + LIVE 2026-05-31):** `node reply-processor.js` reads aidan@aevon.ca via the **Gmail API (OAuth refresh token)** — NOT IMAP. We tried IMAP/app-passwords first but Google removed "less secure apps" on this Workspace, and tried service-account keys but org policy `iam.disableServiceAccountKeyCreation` blocks key creation (on both work AND personal projects now). Final working approach: OAuth Desktop client created under **personal** Google account (project owner irrelevant), scope `gmail.modify`.
- Matches reply→lead by exact email, then unique normalized subject, then unique domain (subject most reliable — replies often come from a person's address, not the listed `info@`)
- Classifies intent with Gemini (interested/not_interested/referral/auto_reply/question), updates CRM status + clears queue (scheduled_send_at=null), logs `email_events` row, drafts a suggested reply into Gmail Drafts (NEVER auto-sends). Dedups on inbound Message-ID in event metadata.
- `node get-gmail-token.js` = one-time helper that prints the refresh token (runs local browser OAuth on localhost:4571).
- Env/secrets (in .env AND as GitHub repo secrets): GMAIL_USER, GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET, GMAIL_OAUTH_REFRESH_TOKEN. OAuth client ID: 571495663235-v4s1a9v0o7ban62a82l8sk8qjhpji009.apps.googleusercontent.com
- Workflow `process-replies.yml` runs hourly weekdays (cron `30 16-23 * * 1-5` UTC), offset from sender. Verified passing.
- Deps: googleapis, mailparser, nodemailer (imapflow still in package.json but unused).
- OAuth app PUBLISHED to production 2026-05-31 → refresh token no longer expires (was a 7-day testing-mode limit). Reply agent auth is now permanent. App is unverified (fine for single-user gmail.modify); re-running get-gmail-token.js would show a "not verified" warning → Advanced → Continue, but no re-run needed.

**DO NOT run `node sender.js`** until user gives explicit green light.

**DAILY_CAP** (max emails/weekday) lives in `sender.js` (env var, GitHub secret = 55 as of 2026-06-07). Resend free tier caps at ~100/day — stay under it. Two lead finders: `lead-finder.js` (custom-apps angle) and `agent-lead-finder.js` (AI-agent angle, uses GEMINI_API_KEY_AGENT). Both now reject Google Places results not clearly in BC, Canada (an Arizona vet had slipped in).

**CRM:** served via GitHub Pages at `https://aidancox8.github.io/aevon-agent/crm/` (NOT Netlify anymore). Source: `agent/crm/index.html` (single file, ~2400 lines, one inline script block). Must commit+push for changes to go live. Views: Dashboard (default home), Pipeline, Outreach, Replies, Analytics, Activity, Customers, Projects, Invoices.

**CRM revamp 2026-05-31 (Opus 4.8):**
- Analytics rebuilt with SVG chart toolkit: `kpiCard`, `miniStat`, `donut`, `lineArea`, `histogram`, `funnelBars`, `rankTable` (old colChart/funnelStep/rankRows removed). Stats: KPI row, conversion funnel, reply-intent donut + avg response time, 30-day sends/replies area chart, pipeline-status donut, score histogram, top industries/cities WITH reply rate, clients/revenue strip.
- **Replies inbox** (`renderReplies`) surfaces reply-agent output (intent, reason, suggested reply, Copy-reply, Open-in-Gmail). Sidebar badge counts actionable replies. Lead profile has a "Reply Agent" card too.
- **Dashboard** (`renderHome`, default landing): replies-to-answer, due-to-send, runway, 7d sent/replies, active clients, action lists, "what needs doing" tiles.
- **Toast** system (`toast(msg,type)`) replaced raw alerts. `copyReply` uses clipboard.
- When editing this file: it's one big script block — validate by extracting `<script>` and `new Function()`-ing it. Splicing big blocks via an anchored node script is safer than huge Edits (parallel Edits on it caused duplicate-button bugs earlier this session).

**package-lock.json IS committed** (both workflows use `npm ci` which requires it). Do not re-add to .gitignore.

## Key facts / gotchas (verified 2026-05-31)
- Resend open/click tracking is BROKEN and unfixable without paying/support — domain toggle is ON, webhook subscribed to email.opened, emails have HTML, but 0 opens/clicks EVER recorded across 300+ sends. Confirmed via test email to aidankwcox@gmail.com (opened + clicked, still no event; links not rewritten). Resend isn't injecting tracking on these API sends. Per their docs all requirements are met → it's account/plan-side. User won't pay. DO NOT rely on Resend open rate.
- **Replacement: self-hosted VISIT tracking (built 2026-06-03), deliverability-safe.** Edge function `track-visit` (public, verify_jwt false, CORS) logs a 'clicked' email_event (metadata.source='site-visit') when a lead hits aevon.ca with `?ref=<leadId>`. Website index.html (repo aidancox8/aevon-website, branch **main** not master) sendBeacons the function on load then strips ?ref. sender.js toHtml(text, leadId) adds a clean `aevon.ca/?ref=<leadId>` link in the signature. NO pixel, NO redirect/masked links — just a real-domain link with a query param, so zero spam risk. This is the intended engagement metric now: replies > site visits/clicks > (ignore opens).
- Cold email sent from PRIMARY domain aidan@aevon.ca — deliverability risk; recommended fix is a dedicated cold-email domain forwarding to inbox (NOT done yet).
- `source` column: lead finders NOW populate it (= search query) as of 2026-05-31. Old ~3,292 leads still null.
- **Contact strategy (2026-05-31):** generic info@ inboxes proved dead (0 replies / 82 contacted). `lib/contact-finder.js` now scrapes homepage + contact/about/team pages, prefers a named decision-maker's personal email over role/generic, classifies `email_quality` (personal|role|generic), and pulls `contact_name`/`contact_role`. No email guessing (bounces hurt the young domain). Limitation: JS-rendered sites (e.g. Jean's vancouvercommercialbrokers.ca) return nothing to axios+cheerio — would need a headless browser (deliberately not built).
- **Target range widened to ~1-99 staff** (was 10-50). User's argument: many mid-size firms have general IT/helpdesk but NOT software developers, and general IT ≠ building custom apps. Qualifier disqualifier changed from "100+ employees" to "has in-house software/dev team" (helpdesk/sysadmin does NOT count). Sales motion still harder at the larger end; first closes likely from smaller firms — watch conversion-by-size.
- Conversion rate now in analytics (KPI: % of contacted won + % of replies). Contact Quality panel shows reply rate by inbox type to validate the named-contact thesis as data accrues.
- Stats: ~3,292 leads, only ~1,749 have email (~47% uncontactable). Scores cluster 7-9 (qualifier barely discriminates). ~243 sends, 2 human replies (Jean=interested, Teresa=not interested). ~1.2% reply rate but sample far too small to tune copy.
- Jean = Vancouver Business Brokers (jean@vancouvercommercialbrokers.ca), the one live interested lead. Multi-brand commercial broker.
- Site-visit tracking is now the key engagement signal (replies > visits > ignore opens). track-visit edge fn v2 dedups repeat hits within 30min (email security scanners pre-fetch the link and were doubling visit counts — Linux UA right before the human Windows one is the tell).
- First real visits (2026-06-03): JJB Insurance (info@jjbinsurance.ca, Surrey) and InsureBC Abbotsford (contact@insurebc.ca) both clicked the demo from their "the quote grind" cold email same day. Warm leads. NOTE: outreach sends via Resend/SES, so sent copies are NOT in Gmail — can't thread a Gmail reply to them; follow-ups must go via Resend (threads) or as a fresh Gmail email.
- Outreach copy lessons (see feedback_writing_style): casual/human, no call-ask until they show interest, no fabricated references (zero clients yet), don't presume their workflow.
- DMARC is p=none, SPF present (Google). Fine for now.

**Website:** `C:\Users\Aidan\projects\aevon\website\` — GitHub repo `aidancox8/aevon-website` (public), deployed via GitHub Pages at `aevon.ca`. HTTPS enabled. Microsoft Clarity analytics active (project: wlp1u8mlgj). Always commit and push after edits.

**Website status:** App gallery has light-themed UI previews, mobile hamburger nav, How It Works section, ROI calculator, contact form (Formspree ID needs replacing — waiting for hello@aevon.ca). No social proof section yet.
- Site is React compiled IN-BROWSER via @babel/standalone (slow, caused a FOUC flash of the crawler-fallback HTML). Fixed 2026-06-03 with a branded #boot-splash overlay (logo.svg, removed on React mount, 6s failsafe). Proper long-term fix = a real build step, deferred. Repo branch is **main** not master.
- `insurance.html` (2026-06-03, vertical landing page): broker-specific — quote-intake/renewal/missing-info pains, before/after handling, demo link, "you own it/no per-seat", book-a-call. Linked in main nav (desktop+mobile). Sender's `landingFor(industry, leadId)` routes insurance-brokerage leads here (`/insurance.html?ref=`), everyone else to `/demo.html?ref=`. Pattern to replicate: build a vertical page per high-volume industry (real estate, mortgage, property mgmt) and extend landingFor.
- `demo.html` (rebuilt 2026-06-03, standalone vanilla-JS, no react/babel): impressive interactive showcase with an **Apps | Agents top-level toggle**. APPS (made property-management-specific, NOT generic, 2026-06-03): "Property Turn Tracker" = vacancy-loss PMS (live $/day-lost, turnover board where units advance through a 6-stage make-ready track, occupancy donut, recovered-rent projection) + "Make-Ready Scheduler" = dispatch that shows WHY each job got its slot and reroutes around a conflict live. AGENTS = Inquiry Triage (live agent console: scans inbox, classifies, types drafts) + Document Pipeline (invoice OCR→extract→validate→route). Each animates like real software. Sender's signature aevon.ca link → `/demo.html?ref=<leadId>` and follow-ups link it via {{DEMO}}. To preview/QA the site visually: headless Chrome at "/c/Program Files/Google/Chrome/Application/chrome.exe" --headless --screenshot=ABS_PATH --virtual-time-budget=Nms (use abs paths; temp auto-run copies to capture mid-animation). GOTCHA: SVG SMIL/CSS-transform bar animations render unreliably headless — bar chart uses plain CSS-height divs instead. Still TODO: a real tailored demo to send when a lead asks.
- Sender reply safety-net (2026-06-03): before sending, skips any due lead with a logged real-intent 'replied' event (excludes auto_reply), independent of status, closing the timing gap between hourly reply-processor and hourly sender. So a reply removes a lead from ALL future sends even if reply-processor mis/uncaught it.

**Keys in** `C:\Users\Aidan\projects\aevon\agent\.env`:
- `GOOGLE_MAPS_API_KEY`, `GEMINI_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SECRET_KEY`, `RESEND_API_KEY`, `SUPABASE_DB_PASSWORD`, `SUPABASE_DB_URL`

**To enable sending:** verify hello@aevon.ca in Resend → update `FROM_EMAIL` GitHub secret → uncomment cron in `.github/workflows/send-outreach.yml` → push.

**Gemini models:** `gemini-3.1-flash-lite-preview` (primary), `gemini-2.5-flash` (fallback).

## North-star (stated 2026-05-31)
User's goal: **Aevon should run as automated and agent-led as possible.** He does NOT have time to monitor day-to-day, but WILL monitor in early stages until the systems/structure are proven. Build with this lens on every change: (1) does it remove a manual human step? (2) is it safe to run unwatched YET? Automate mechanical steps aggressively (lead-find, personalize, schedule, send) but keep human approval on anything leaving the building (esp. auto-sending replies) until the track record earns trust. Auto-send replies is the LAST thing to hand over.
- Currently autonomous: sender (hourly cron), reply-agent drafting (hourly cron).
- Still manual (gaps to close): running lead-finders, running personalizer, hitting send on reply drafts, hallucination/quality review.
- Path: cron the finders + personalizer weekly; build a weekly digest the agent emails Aidan (sent / replies / needs-a-call) so he monitors in 2 min not by logging in; only enable reply auto-send after draft quality is proven.
- Helper scripts added 2026-05-31: `personalizer.js --limit N` (score-ordered batch), `schedule-monday.js` (pull top-score leads forward to fill a send day), `regen-followups.js` (rewrite pending follow-ups), `enrich-emails.js` (re-scrape no-email leads). NOTE schedule-monday/nextEligibleAt use UTC "next weekday" — on Sunday-night PT this skips Monday (lands Tuesday); verify against Vancouver day when scheduling.

## Current state (2026-06-09, supersedes stale bits above)

- **Email strategy = ASK-LED** (pivoted 2026-06-06 after Jean's reply proved it): email 1 is one line of context + one honest observation + an open question about their biggest time-sink. NO pitch, NO link, NO asserted pain. Email 2 re-asks from a new angle, may add {{DEMO}}. **Email 3 (new)** = final touch, "I'll leave it here" plain-honesty urgency, no link. Sequence is 3 steps; sender ends leads at step 3 (dont_contact).
- **Subject lines:** banned "the ___ grind" skeleton + banned copying prompt examples verbatim; cross-batch dedup seeded from existing subjects (normSubject strips unicode hyphens). Personalizer has withTimeout (15s scrape / 60s Gemini) after a hang froze a run 90 min; --limit N input on the workflow for bounded runs.
- **Sender:** named-contact priority (role inboxes only backfill), emailRisk guard (digit-prefix, concatenated-word, glued role-word like ushello@/ninfo@), reply safety-net, landingFor routes insurance→insurance.html else demo.html. CRITICAL bug fixed 2026-06-09: leftover `isFollowup` refs threw after every send → no 'sent' events logged → cap saw 0 → over-sent past Resend's 100/day. 162 mis-marked leads recovered. ALWAYS grep for stale variable refs after refactoring sender.js.
- **Interest button (2026-06-07):** demo.html + insurance.html + vbb.html have one-click "I'm interested → have Aidan reach out" with optional note ("What problems would you like Aevon to solve?"). Hits track-visit?ref=X&i=1&note=..., logs 'interested' event, flips queued→interested (pulls from cold sequence). track-visit edge fn v3.
- **Signal loop:** repeat-visitors.js (~5:10pm PT weekdays) emails [Aevon SIGNAL] listing interested clicks (with notes, first) + genuine repeat visitors (bot UAs filtered, 30-min session collapse). [Aevon ALERT] on any workflow failure (all 5 workflows have the curl step). Cloud routine "Aevon morning replies briefing" (trig_016e43ep7bHUmvTArah9C2fc, weekdays 8am PT, Sonnet, Gmail+Calendar connectors) reads inbox, drafts replies (NEVER sends), checks ALERT/SIGNAL mails, posts 9am calendar-event briefing. GitHub cron can silently SKIP under load (not a failure, no alert) — caught one 2026-06-08.
- **Demos (2026-06-09):** demo.html is enterprise-grade — all 4 panels wrapped in an app shell (sidebar nav: Dashboard/Leads/Pipeline/Inbox/Documents/Reports + user, topbar with search/live/bell), auto-play on load AND tab switch, dense data. Apps = Lead Command Center + Deal Pipeline (kanban, KPI header, risk scan). Agents = Inquiry Triage + Document Pipeline. User bar: "has to look like a real enterprise level app."
- **vbb.html:** tailored auto-playing walkthrough for Jean (his 4 real brands, NDA-gated financials, qualify chips, booked showing). Ref-tagged + interest button.
- **Warm leads:** (1) Jean Seguin / Vancouver Business Brokers — draft w/ vbb link ready in Gmail; (2) Restaurant Business Broker (info@restaurantbusinessbroker.ca, one of Jean's sister brands btw) — said "yes, please do" to a demo recording 2026-06-05; complete draft w/ ref-tagged demo link in Gmail Drafts. Both waiting on Aidan to hit send.
- **Reply-processor:** Gmail token died (invalid_grant) ~2026-06-08, re-authed + secret updated + re-enabled 2026-06-09. Drafts only, never sends (verified: only gmail.users.drafts.create).
- **Enrichment dead end:** re-scraping no-email leads yields ~0.5% (2/400). Don't re-run. Real decision-maker enrichment needs a paid finder (Hunter/Apollo ~$30-50/mo CAD) — flagged, user said no spending for now.
- **DB safety:** snapshot before any bulk DELETE/UPDATE (backups: leads_backup_20260604, _preask, _20260606, _20260609). User approves prompts without reading; backups are the real safety net.
- **Stats (2026-06-08):** ~440+ sent, 2 interested replies + 1 not-interested, ~1.4% reply rate on recent named-contact sends, bounce ~2.6%, queue ~4,100 (843 named-ready). Deliverability confirmed fine (visits prove inbox placement; Resend tracking still broken, ignore opens).

## Next Steps (as of 2026-05-05)

1. Run `node lead-finder.js --query "property management company" --city "Vancouver BC"` then `node personalizer.js` to test pipeline and review lead + email quality in CRM
2. Friday/weekend: verify hello@aevon.ca in Resend, set FROM_EMAIL secret, uncomment cron, build IMAP reply detection
3. Replace Formspree ID in website once hello@aevon.ca is live
4. Add Calendly link to "Book a Free Call" buttons once Google Workspace is set up
5. Add social proof / case studies section to website (need content from user)
6. New logo in development (user is designing via Claude design tool)
7. Build one polished demo app to show prospects during discovery calls
