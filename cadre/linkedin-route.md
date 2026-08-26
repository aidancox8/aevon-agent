# The LinkedIn route: reaching the person who wrote the job ad

## Why this exists

The honest ledger, measured 2026-08-26, across every campaign this repo has ever run:

| | sent | genuine human replies | clients |
|---|---|---|---|
| Aevon | 3,824 | ~0 (of 44 "replies", nearly all are auto-replies; the rest are opt-outs) | 0 |
| Tempo | 358 | 0 | 0 |
| Cadre | 3 | too early | 0 |

Cold email into generic inboxes has produced zero clients in ~4,200 sends. Cadre's copy is far
better (signal-based, hand-written), but it still lands in `info@` and `hr@` inboxes on a list
that is 15-of-18 Microsoft-hosted with Defender placement never verified. Waiting on it is hope.

Meanwhile every Cadre lead exists BECAUSE a specific human wrote a job ad. That human is:
- provably feeling the pain (they are hiring someone to do it manually, at $50-70k/yr)
- identifiable by name from the posting or the company's LinkedIn page
- guaranteed to read their LinkedIn inbox this week, because they are actively recruiting

The 91 leads with no findable email are not unreachable. They are unreachable **by email**. The
job posting is itself a contact channel pointing at a named person.

## The method (10 minutes a day, Aidan does the sending)

1. Open the lead's `signal_url` (the posting). Note who posted it or search
   `"<company>" HR OR safety OR operations` on LinkedIn.
2. Send a **connection request with no note** first. Bare requests from a plausible profile
   accept at 30-40%; a pitch in the note drops that hard.
3. After acceptance, send ONE short message built from the drafts below. No follow-up sequence
   on LinkedIn; one message, then let it be.
4. Log the outcome in the CRM notes for that lead.

Rules, same as email: their own words, no invented customers, no price, one question.
Never send from any automated tool; LinkedIn bans it and the account is the asset.

## Message shape

> Saw you're hiring a [role] — the posting mentions [their words, verbatim].
> Before you fill it, might be worth seeing the software version: I build a system that runs
> onboarding by role and keeps training and certifications on one record, running daily at a
> 75-staff clinic. If the hire is the right call anyway, no harm done. Worth a look?

The "before you fill that role" frame is the whole pitch: they have already budgeted a salary
for this problem.

## Drafts for the top 10 (highest signal score first)

### 1. Empire Roofing — Georgetown ON (~80 staff, 10/10) — NO EMAIL EXISTS, LinkedIn only
Posting: https://ca.indeed.com/viewjob?jk=11ea76e6aff19308
> Saw you're hiring someone to schedule mandatory training and maintain training records, tracking
> certification expiries. Before you fill that seat, worth seeing the software version? I build a
> system that runs onboarding by role and watches every expiry itself — runs daily at a 75-staff
> operation. If the hire's the right call anyway, no harm done.

### 2. Instrata Technologies — Chandler AZ (~150 staff, 10/10) — NO EMAIL, LinkedIn only
Posting: https://www.indeed.com/viewjob?jk=272681d67174805f
> Saw the posting asking someone to maintain a comprehensive training matrix and track
> certification renewals. I build software where the matrix generates itself from what people
> have completed — the renewals chase themselves. Worth a look before that role is filled?

### 3. ATS Traffic — Edmonton AB (~500 staff, 10/10)
Posting quote: "Manage training databases and tracking spreadsheets..."
> Saw you're hiring someone to manage training databases and tracking spreadsheets, monitoring
> certification expiries. Databases and spreadsheets, plural, is usually the honest description
> of the problem. I build the system that replaces the plural. Worth ten minutes?

### 4. ODC Tooling and Molds — Waterloo ON (~100 staff, 10/10) — NO EMAIL, LinkedIn only
> Saw the posting covering SDS sheets, training logs, and employee certifications across manual
> and digital systems. "Manual and digital" is two systems disagreeing with each other. I build
> the one that replaces both. Worth a look before the role's filled?

### 5. Supreme Motors — Mississauga ON (~60 staff, 10/10) — NO EMAIL, LinkedIn only
> Saw you're hiring someone to track licensing and certification requirements, OMVIC included.
> I build software that carries each licence on the employee's record with its renewal already
> set. Worth seeing before that seat is filled?

### 6. ALMAG Aluminum — Brampton ON (~300 staff, 9/10)
> Saw the posting asking someone to maintain the training matrix and performance review matrix
> for all employees. Two matrices, both hand-kept. I build software where both are views of the
> same record, so neither needs maintaining. Worth ten minutes?

### 7. Arrow Machine and Fabrication — Stratford ON (~300 staff, 9/10) — NO EMAIL, LinkedIn only
> Saw you're hiring someone to maintain welder qualification records and monitor certification
> expiry dates. I build software that warns the welder and QC separately before anything lapses.
> Worth a look before the role is filled?

### 8. Canadian Flatbeds — Milton ON (~150 staff, 9/10) — NO EMAIL, LinkedIn only
> Saw the posting asking someone to keep all certifications, licences, and qualifications
> current across the fleet. Per-driver, that's four documents on four clocks. I build software
> that watches all of them and warns before anything expires. Worth ten minutes?

### 9. Progressive Rubber — Kamloops BC (~90 staff, 9/10) — NO EMAIL usable, LinkedIn only
> Saw you're hiring someone to maintain training matrixes and certification records for
> workforce compliance. I build software where the matrix generates itself from completions.
> Worth seeing before the seat's filled?

### 10. Superior Cabinets — Saskatoon SK (~300 staff, 9/10) — contact known: Yvonne Moasun, Director of HR
> Hi Yvonne — saw the posting asking someone to conduct internal safety training and maintain an
> accurate safety training record. Running the training and recording it are two jobs, and the
> second is where gaps open at 300 people. I build software where finishing the session closes
> the record itself. Worth ten minutes?

## What this does NOT replace

The email sequence keeps running (72 scheduled, 12/day). This is the parallel channel for the
same leads' actual decision-makers, and the only channel at all for the 91 without an address.
If a lead replies on either channel, cadre/reply-scan.js stops the email sequence; tell Claude
about LinkedIn replies so the lead gets marked there too.
