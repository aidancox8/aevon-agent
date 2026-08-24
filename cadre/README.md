# Cadre — the HR / credentials campaign

Third campaign, third lead table. `leads` is Aevon, `tempo_leads` is clinic scheduling,
`cadre_leads` is this one. They never mix, and stopping one is just not running its scripts.

## What is being sold

HR Cadre plus the Company Wiki, sold whole and priced flat, to organisations whose staff hold
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

A row in `cadre_leads` requires a signal: something the company published showing it has this
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
node cadre/ingest.js cadre/batches/<date>-<source>.json --dry
node cadre/ingest.js cadre/batches/<date>-<source>.json
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


## Sourcing notes, learned the hard way

**Where the signal exists at all.** The method finds nothing in healthcare or property management.
Two separate agents swept both and returned almost nothing, for the same structural reason:
individuals hold their own licences there, so employers publish them as a REQUIREMENT ON THE
APPLICANT, never as internal tracking work. The signal only appears where the EMPLOYER is
accountable for the workforce's tickets. That means trades, manufacturing, transport, security,
social services, food processing and aviation maintenance.

**The highest-yield phrase is "training matrix".** By a wide margin, across every province and the
US. It is an artifact with a name inside these companies, and someone is paid to keep it current.
Runners-up: "certification tracking", "certification expiry", "recertification tracking",
"maintain training records", "employee certifications", "driver qualification files".

**Indeed caps results.** It blocks pagination past page one without a login, so every query only
ever surfaced ~15 results. That is a ceiling on the search, not on the market.
**SimplyHired.ca honours exact-phrase search AND paginates**, so it reaches deeper.

**Indeed job ids are verifiable.** An agent claimed a fabricated `viewjob?jk=` id returns plausible
content rather than a 404, which would have made 28 leads uncheckable. Tested: two invented ids
both returned a clean 404, and re-fetching real ones returned the exact quoted sentences. The
claim was wrong. Cite `viewjob` links freely, but only ones actually fetched.

## Where published personal emails actually come from

Four found across roughly 35 companies researched. Not one came from an About or Team page.

| Source | Find |
|---|---|
| Industry association member directory | `nathan@mjroofing.net` (Canadian Roofing Contractors Association) |
| Industry association directory **PDF** | `gabe@northmountainconstruction.ca` (Roofing Contractors Association of BC, stable across three annual editions) |
| Industry association member directory | `tkeith@heartlandcoatings.ca` (Canadian Council for Indigenous Business) |
| **Parliamentary committee brief** | `yeti@advancepaperbox.ca` (signature block on a House of Commons trade submission) |
| Company contact page with per-person mailtos | `laura.kleiner@agwest.com` (rare) |

So: **search association directories and government submissions, not company websites.**

**Never construct an address from an observed pattern.** Several companies publish
firstname.lastname or first-initial-surname openly, which makes guessing tempting. A guessed
address that bounces costs sending-domain reputation this campaign has none of to spare.

## Verify the human, not just the company

Three findings that would each have produced a bad send:

- An earlier draft was addressed to `aliiqbal@ebco.com`. That address is published nowhere and
  **Ali Iqbal has left the company.**
- **Garibaldi Glass's owner and President died in January 2026.** Their Director of People and
  Culture seat is also vacant or newly filled.
- AgWest's contact was stale; their published CEO is someone else entirely.

Check that the person still holds the role before writing to them, especially where the source is
an aggregator rather than the company's own current page.

## Disqualify on parent company

Four leads died on this and every one looked fine on the list. Guardteck sits under a 3,500-staff
parent already running Dayforce. Hansen Industries and Alliance Maintenance are both Exchange
Income Corporation. Five Corners centralises HR at Donald's Fine Foods. If HR is decided upstairs,
the person named in the job ad cannot buy.


## How big is this actually? (measured 2026-08-21)

SimplyHired.ca reports true result totals for exact-phrase queries, so the pool can be measured
rather than guessed. For the single phrase `"training matrix"`:

| Scope | Live postings |
|---|---|
| Ontario | 59 |
| British Columbia | 13 |
| **Canada-wide** | **156** |

That is ONE phrase, at ONE moment, and postings expire and refresh continuously. Across the ten
or so productive phrases the live Canadian pool is plausibly several hundred at any time, and it
replenishes. This is not a list that gets exhausted; it is a standing stream.

**Channel notes:**
- **SimplyHired.ca** honours `?q=%22phrase%22&l=ontario` and reports totals. Its `&pn=2` parameter
  does NOT advance the page, so each query still caps at ~20 visible. Get past that by slicing on
  location (`l=ontario`, `l=british+columbia`, `l=canada` return different sets) and by using many
  distinct phrases rather than paginating one.
- **Eluta.ca** honours phrases and indexes employer career pages directly, so it is a second,
  non-overlapping corpus.
- **Dead:** DuckDuckGo, Mojeek and Bing are CAPTCHA-blocked to automated fetching. Job Bank and
  Talent.com ignore quotes entirely and are not worth further effort.

**Phrases that produced qualifying employers:** "training matrix", "maintain training records",
"employee training records", "certification expiries", "competency tracking", "certifications are
up to date", "staff certifications", "driver qualification files".

**Dead-end phrases, do not repeat:** "expiring certifications" (0 results), "certificates and
tickets" (0), "certifications on file" (2, both personal trainers), "training tracker" (3),
"licenses and certifications" + track (54 but nearly all IT consultancy roles).

**A trap worth naming.** Several strong-looking hits are about *product or vehicle* certification,
not employee credentials. DECAST, Storkcraft, The North Transportation and Trans-Northern
Pipelines all read as qualifying from the search snippet and fail once the posting is opened.
Every hit needs the individual posting fetched before it counts.

## Tested: can the existing Aevon and Tempo lists be reused? No.

The idea was reasonable. There are 688 clinics in `tempo_leads` with verified addresses, all
healthcare, all with credentialed staff, so all with the problem. Importing them would have
produced 688 sendable leads instantly.

`cadre/signal-check.js` tested it properly rather than assuming either way: take a company we
already know, search for its own postings, and see whether it has published the signal.

**Result: 0 of 27.** Twelve Tempo clinics, fifteen Aevon businesses, no signal anywhere.

The reason is visible in the names. Both lists are small businesses: realtors, mortgage brokers,
marketing agencies, single-site physio clinics. Two things follow.

- **Most have no credentialed workforce at all.** A realtor or a marketing agency has nothing
  that expires.
- **The ones that do are too small to delegate it.** A five-person clinic does not hire someone
  to track certifications, the owner does it between patients. Nobody publishes a job ad for
  work they do themselves, which is exactly why the signal is invisible below a certain size.

This is the same structural finding as healthcare and property management, arriving from a
different direction: **the signal appears when a company is large enough that credential tracking
becomes somebody's named job.** Below that it is real but silent.

It also explains why Cadre's lead profile looks nothing like the other two campaigns:
manufacturing 56, trades 51, transport 27. Those industries barely appear in the Aevon or Tempo
lists, and the overlap between Cadre and both existing tables is 5 companies out of 171.

**The tool is kept**, because checking a specific known company for a signal is still the right
move when one turns up from a referral or a conversation. It just does not work as a bulk
conversion of an old list.
