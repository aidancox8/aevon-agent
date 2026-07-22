# Tempo campaign — clinic scheduling outreach

A **separate duplicate** of the Aevon outreach pipeline, pointed at multi-provider
clinics and pitching **Tempo** (Aevon's clinic staff/room scheduler). It reuses the
shared libs (`../lib/*`) and the same `.env`, but writes to its **own `tempo_leads`
table** so it never mixes with the Aevon `leads`. If Tempo doesn't work out, just
stop running these scripts — Aevon is completely untouched.

## One-time setup
Run the table SQL once against the Supabase project (qzxtfgzpyptvriorfhxw):
```
tempo/schema-tempo-leads.sql
```
(psql, the Supabase SQL editor, or the Supabase MCP — whatever you use for the other schema files.)

## Run it
From the `agent/` directory:
```
# 1. Find clinic leads (Google Places + Gemini qualify, excludes Changepain & Artus)
node tempo/lead-finder.js                       # full sweep, score 7+
node tempo/lead-finder.js --query "physiotherapy clinic" --city "Surrey BC"
node tempo/lead-finder.js --min-score 8 --pages 2

# 2. Personalize the 3-email Tempo sequence for queued clinic leads
node tempo/personalizer.js                      # all queued
node tempo/personalizer.js --limit 30           # top 30 by score
```

## What's the same / different vs Aevon
- **Same:** Gemini prompt engine, website scraping, dedup, rate limits, no-em-dash cleanup, score-then-personalize flow, `.env`, `../lib/*`.
- **Different:** targets clinics only; qualifies on staff/room scheduling complexity (not inbound knowledge work); pitches Tempo not the Front Desk agent; writes to `tempo_leads`; excludes Changepain + Artus.

## Sender
Not duplicated yet — these scripts only **find + write** the emails into `tempo_leads`.
Review them in the DB first. When you want to send, either point a copy of `../sender.js`
at `tempo_leads` (change the table name + `{{DEMO}}` handling) or review/send manually.
The demo link in email 2 is `clinic-scheduler-demo.web.app`.

## Hard rules (inherited)
- Never contact Changepain or Artus Health Centre (auto-excluded).
- No em dashes in copy (auto-stripped).
- CAD pricing. Never fabricate specifics about a clinic.
