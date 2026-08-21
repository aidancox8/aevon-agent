# Pulse — the HR / credentials campaign

Third campaign, third lead table. `leads` is Aevon, `tempo_leads` is clinic scheduling,
`pulse_leads` is this one. They never mix, and stopping one is just not running its scripts.

## What is being sold

HR Pulse plus the Company Wiki, sold whole and priced flat, to organisations whose staff hold
credentials that expire. Not "HR software for SMBs" — that is a demographic, and a demographic is
what killed Aevon.

The teardown that justifies it (2026-08-21, `sales/` has the sources):

| Vendor | Credential expiry, natively? | What you actually do |
|---|---|---|
| BambooHR | No credentialing module | Custom fields plus alerts, and custom fields cannot trigger workflow automations. Or install a third-party app. |
| Rippling | Not native | Athena, 330 staff, built their own in App Studio. Took an HR Director who builds apps. |
| Humi (CA) | Training module has no expiry | Third-party integration |
| Expiration Reminder | Yes, it is the whole product | $49-399/mo per workspace, priced by number of expiry items |

Nobody at the SMB tier ships this. Every route is a bolt-on or a self-build. Meanwhile the market
has already priced a standalone reminder tool at $49-99/mo, which is why a reminder app is not the
offer. The offer is credentials joined to HR, training, onboarding and Teams in one system.

## Why there is no scraper in this directory

`leads` and `tempo_leads` were both filled by querying Google Places for a business type and
assuming the pain. Between them: **3,808 sends, 12 human replies, zero meetings.**

A row in `pulse_leads` requires a signal: something the company published showing it has this
problem. A job ad for someone to "track certifications". A safety coordinator role listing three
training programs with three renewal cycles. A review saying their HR tool cannot do expiry.

`signal_quote` holds their own words and `signal_url` says where it came from. This is enforced by
a CHECK constraint, not a convention, because convention is exactly what eroded on the other two
campaigns: rows arrived with no evidence and nobody noticed until thousands of emails had gone.

The sources carrying these signals block programmatic access (Job Bank resets the connection,
Indeed needs a real browser), so collection happens in-session and lands here as JSON. That is a
feature. The first-customers research is blunt that nobody got customer #1 from a list larger than
about 100, and a hand-built 40 beats a scraped 3,400.

## Usage

```bash
node pulse/ingest.js pulse/batches/<date>-<source>.json --dry
node pulse/ingest.js pulse/batches/<date>-<source>.json
```

Scoring rewards how directly the company admitted the problem, not how big it is. Hiring someone
specifically to chase credentials scores highest, because the pain and an approved budget are both
already there. Under ~15 staff scores down: below that nobody is accountable for renewals, which is
the same reason a solo tier was wrong for every other product in this research.

## What the quote is for

It is the personalization. Every previous campaign opened by inferring a prospect's pain from their
business type. Here the first line can reference something they wrote themselves, which is the
difference between "I noticed you're a physiotherapy clinic" and quoting their own job ad back to
them.

## Searches that worked

Indeed, BC-wide, phrase-quoted:
- `"track certifications" OR "certification tracking" OR "tracking certifications"`
- `"track licences" OR "expiry dates" OR "renewal dates"` plus safety / compliance / HR

Avoid searching "credentialing" on its own: it returns regulators and staffing agencies whose
*business* is credentialing, not employers who struggle with it.

## Status

8 leads ingested 2026-08-21. No copy written, nothing sent. Addresses still needed.
