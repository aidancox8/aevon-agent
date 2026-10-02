# Warm follow-up protocol

`warm-followup.js` drafts (never sends) follow-up touches for prospects who showed real
intent. Warmth without a system behind it cools at exactly the rate you would expect:
Jean's drafts waited on a human to hit send, Vickers watched the demo twice and there
was no follow-up on record, Sofia missed her demo and went quiet after three ad-hoc
touches.

## What counts as warm

A human showed intent, not a bot:

- a reply classified interested / question / referral
- an "I'm interested" button click
- 2+ genuine site visits (bot-filtered with the same rules as signals-digest.js:
  Linux/headless/bot UAs out, Chrome <130 out, clicks within 10 min of a send out,
  sessions collapsed at 30 min, 3+ device families treated as a gateway scanner)
- a manual entry in `warm-manual.json`

What does NOT count: raw visit counts (90 of 114 "warm visitors" were mail scanners),
DMARC/TLS reports, ticket bots, auto-replies, wrong-organization addresses. Acting on
scanner traffic is how the old numbers lied, so the signal query filters before it
counts.

## The stages

Tracked as `warm_touch` events (metadata.stage) on `email_events` / `cadre_email_events`.
No schema change.

1. **Stage 1** (1-3 days after the signal, thread quiet): acknowledge the signal, one
   easy question. Copy varies by signal type (missed demo, demo watched, reply,
   interest click).
2. **Stage 2** (6-8 days after stage 1): one concrete thing the first note did not say.
3. **Stage 3** (13-15 days after stage 2): the breakup. Plain close-out, easy exit.
   Consistently the highest-replying message in a sequence because it asks for nothing.

After stage 3 the lead is marked `warm_closed` and the script never touches it again.
Email has done all it can; the run report lists these as "needs a human move"
(phone call, LinkedIn, referral path).

## Guards

- Drafts only. Nothing here sends. Ever.
- Skips dont_contact / unsubscribed / bounced / converted.
- Skips when a reply is newer than the last warm touch (the thread is alive;
  reply-processor owns it).
- Idempotent: a logged stage is never re-drafted. Manual entries are written back to
  `warm-manual.json` the moment a draft is created.
- Every draft runs through the proactive gate (handled-personally list, employer
  exclusion, forbidden claims). A failed gate is logged loudly and no draft is created.
- Missing env fails the run instead of drafting nothing quietly.

## Running it

`node warm-followup.js --dry` prints what would be drafted. `node warm-followup.js`
creates the drafts. The GitHub workflow (`warm-followup.yml`) is manual-trigger only
until a few supervised runs prove the stage logic; then enable the weekday schedule
commented inside it.

## warm-manual.json

For prospects whose state lives outside the database (demos booked by hand, old warm
threads). Copy `warm-manual.example.json`, fill in real values, keep it local
(gitignored). Fields: business_name, contact_name, email, campaign, signal_date,
signal_detail, detail (one true thing for the copy to use), problem, touches, closed.
