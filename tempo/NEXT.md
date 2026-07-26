# Tempo — what's left (handoff, end of 2026-07-25)

## Launch is Monday 2026-07-27
Queue: ~195 personalized leads, all scheduled for Monday. Sender identity `aidan@tempo.aevon.ca`
(verified, inbox-tested). Pricing set ($900 setup + optional $100/mo founding). Everything below is
either a pre-launch fix or a post-launch build.

---

## BLOCKING — decide before the first send

**1. 123 clinics are queued in BOTH campaigns.** 112 share an exact email address with an Aevon
`leads` row, 11 more match by name, and nearly all are still `queued` in Aevon. The Aevon sender runs
on an hourly weekday cron, so those clinics are lined up to receive an Aevon pitch from `aevon.ca`
AND a Tempo pitch from `tempo.aevon.ca`. That reads as spam and burns the new subdomain.

Decision needed: which campaign keeps them. Recommendation is Tempo (far better-matched pitch;
Aevon's generic outreach has a proven ~0% reply rate on this segment). To suppress on the Aevon side:
```
UPDATE leads SET status='dont_contact', scheduled_send_at=NULL,
  notes='Suppressed: pitched by the Tempo campaign instead'
WHERE lower(email) IN (SELECT lower(email) FROM tempo_leads WHERE status='queued' AND email IS NOT NULL);
```
Snapshot first, per the standing DB rule: `CREATE TABLE leads_backup_20260727 AS TABLE leads;`

---

## DONE today (verify, don't rebuild)
- Sender runs on the dedicated Tempo Resend account + `tempo.aevon.ca`, keys in `.env` and in GitHub
  repo secrets. Test email confirmed landing in the inbox.
- CASL opt-out line in every email (HTML + plain text).
- Demo links in email 2 now carry `?ref=<lead_id>` so a demo visit is attributable to a clinic.
- Reply-processor cron enabled (Mon-Fri hourly, offset from the Aevon processor). This is what keeps
  the reply safety net alive: without it, someone who replies "no thanks" still gets follow-ups 2 and 3.
- `tempo/check-bounces.js` written — polls Resend for delivery status and parks hard bounces.

## TOMORROW — finish these
1. **Wire `check-bounces.js` into the replies workflow** (add a second step to
   `.github/workflows/tempo-replies.yml`) so bounces get parked automatically every hour. There is no
   webhook on the Tempo Resend account, so this poll is the *only* bounce detection that exists.
2. **Make the demo record `?ref=`** — `src/lib/track.ts` in the cadence repo currently logs
   `location.pathname` but not the query string. Capture `ref` into the `usage_events` doc, then build
   and deploy. Until this ships, the `?ref=` tag in emails goes nowhere.
3. **Follow-up throughput.** 195 leads produce 390 follow-ups, but `FOLLOWUP_MAX_SHARE = 0.4` caps
   them at 8/day, which takes 49 days to clear and turns "5 days later" into three-plus weeks. Once
   the initial sends are done (~10 weekdays), raise the share to ~0.7 or lift `TEMPO_DAILY_CAP`.
4. **Optional:** add a `List-Unsubscribe` header. Not required at 20/day, but it is a free
   deliverability signal on a young domain.

---

## RESEARCH RESULT — next three modules, ranked by evidence

Deep-research run (99 agents, ~2.6M tokens, 3-vote adversarial verification). The final synthesis step
died on a session limit both times, so these are the verified claims read directly. Evidence clusters
hard on compensation.

### 1. Compensation and split reconciliation (9 independently verified claims — by far the strongest)
Jane's own documentation is the evidence. Its Compensation Report "can only calculate a set commission
on the sum of sales by a staff member", and for tiered, hourly, or flat rates those "will need to be
calculated outside of Jane". The official workaround is an Excel export. For flat-fee-per-service pay,
Jane's guide tells admins to pull a count off the Product Performance Report and multiply by hand
("9 X $50 = $450"), every staff member, every pay period. Collected-basis figures can also mismatch
actual payments, forcing a cross-check against the Transaction Report at pay time.

Real disputes follow from this. One contractor RMT calculated a 60/40 split would move ~$17,000/year
to the owner and pushed back; a split-with-cap arrangement blew up when gift certificate and package
revenue crossed the cap, which she attributed to the owner not tracking prepaid revenue, and the deal
was renegotiated three times.

Build: extend the payout report beyond flat percentage to tiered, per-service flat, and hourly; produce
a per-practitioner pay-period statement showing the hours and services behind the number; keep an
immutable snapshot per period. That last part matters — changing a rate in Jane "retroactively changes
past Compensation Reports", so having a frozen record is a genuine dispute-prevention feature Jane
cannot match.

### 2. Rotating / biweekly schedule patterns (verified 3-0)
Jane's Manage Shifts "does not have the option to specify the frequency of your shift schedule
(i.e., biweekly)" — shifts only repeat weekly, so clinics running A/B week rotations edit every shift
by hand. Tempo's Master Schedule should support rotating patterns natively. Small build, clean and
provable gap.

### 3. Shift-change notification and publishing (verified 2-1)
Jane's shift documentation describes no mechanism for notifying staff about shift changes and no batch
export, so clinics fall back to texts and group chats. Tempo already sends SMS; what's missing is a
"publish week → notify only the people whose shifts changed" flow, with a record of who was told what.

### Also verified, lower priority
Room assignment in Jane requires Advanced Scheduling to be enabled, and mismatched room assignments
render appointments in separate columns from shifts, needing manual drag-and-drop cleanup.

### Market price anchor
Generic healthcare staff scheduling (Sling) runs $2-4/user/month with a free tier up to 50 users.
Tempo cannot win on scheduling alone; the clinic-specific modules above are the differentiator, which
is what justifies a flat build fee over per-seat pricing.
