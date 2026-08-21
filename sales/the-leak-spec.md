# The leak: spec

**What to change in the Cadence/Tempo app so it markets itself.** Written 2026-08-20 from a
read-only inspection. Nothing in that repo was edited; every path and line number below is a
pointer for Aidan to implement.

## Why

Jane's first twelve customers came from one visible credit line in a booking-page footer.
Trevor Johnston: *"other clinics saw her online booking, and so they were contacting my company,
because we had our little name at the bottom in the footer... maybe 10 or 12. This was our
entire market research."* No outreach, no calls.

That worked because patient booking pages are naturally public. **Staff scheduling is not.** It
lives inside one building, so the equivalent has to be built deliberately: find every artifact
the app produces that a non-customer reads, and make it say what produced it.

Right now three artifacts leave the building and none of them says anything.

---

## Surface 1: the payroll CSV — highest value

`src/views/MasterSchedule.tsx:1139` builds `scheduled-hours-<date>.csv` and the toast reads
"Scheduled hours exported, ready for payroll".

**Who sees it:** an external bookkeeper or payroll provider. They are the single best audience in
this list, because a bookkeeper serves ten or twenty clinics and is asked for software opinions
by all of them. This is the adjacent-vendor channel arriving for free.

**Change:** the file currently starts straight into data rows. Add two lines at the top of
`rows` before any data, and one at the bottom:

```
Schedule produced by Tempo, tempo-scheduler.app
<clinic name> — week of <date>
<blank line>
... existing header and data rows ...
<blank line>
Built with Tempo. Clinic staff and room scheduling. tempo-scheduler.app
```

Leading rows survive being opened in Excel and read by a human. Put the URL in a cell of its
own so it stays clickable.

## Surface 2: the calendar export — best referral audience

`src/lib/exportIcal.ts`, `downloadIcal()`, called from `src/views/MySchedule.tsx:471`.

**Who sees it:** locums and, more importantly, practitioners who work at two or three clinics.
In this market those people are the highest-leverage referral vector there is, because
practitioners are forced to collaborate and end up in the same rooms at conferences.

**The problem:** Tempo appears only in `PRODID` (line 25) and the event `UID` (line 35). Both are
invisible in every calendar client ever made. The file leaves the building and says nothing.

**Change:** put it where a human actually looks.

- Append to each event's `DESCRIPTION`: a blank line, then
  `Schedule from Tempo — tempo-scheduler.app`. `DESCRIPTION` renders in Google Calendar, Outlook
  and Apple Calendar, and `icalEscape()` already handles the newline.
- Add an `X-WR-CALNAME` line after `METHOD:PUBLISH` naming the calendar, e.g.
  `X-WR-CALNAME:<clinic> schedule (Tempo)`. Subscribed calendars display this as the calendar's
  name, permanently, in the sidebar.

`X-WR-CALNAME` is the highest-value single line in this whole document. It sits in a
practitioner's sidebar every day for as long as they keep the calendar.

## Surface 3: the printed board

`src/views/Today.tsx:1063` calls `window.print()`. Print rules are at
`src/styles/globals.css:620`.

**Who sees it:** everyone who walks past it. Reps, contractors, locums, candidates at interview,
other clinicians covering a shift.

**Gotcha:** the existing rule hides `.btn` and `.card-foot` outright, so a footer added to
existing markup will not print. It needs its own element and its own rule.

**Change:** add a print-only footer, hidden on screen and shown only when printing:

```css
.print-credit { display: none; }
@media print {
  .print-credit {
    display: block;
    position: fixed;
    bottom: 8px;
    left: 0;
    right: 0;
    text-align: center;
    font-size: 9px;
    color: #666;
  }
}
```

Text: `Scheduled with Tempo · tempo-scheduler.app`

---

## Not a leak surface

`src/views/Staff.tsx:546` is a CSV **import**, not an export. Nothing leaves the building.

## Make it a config flag

Every clinic deployment is already config-driven through the Clinic Setup page. Attribution
should be one more setting, defaulting on, so each deployment decides for itself rather than the
behaviour being hardcoded.

## How to tell whether it worked

Attribution with no measurement is decoration. Use a distinct path, not a bare domain, so the
source is unambiguous:

- CSV → `tempo-scheduler.app/p` (payroll)
- iCal → `tempo-scheduler.app/s` (schedule)
- Print → `tempo-scheduler.app/b` (board)

Each redirects to the same page. Any hit on those paths came from an artifact that left a
building, which is the only genuinely warm signal this business has produced so far. Given that
90 of 114 recorded Aevon "visitors" turned out to be mail scanners, run anything these paths
record through `lib/visit-quality.js` before believing it.

## Honest expectations

Jane's twelve came over months, not weeks, from a clinic already running the product daily with
real patients. The mechanism is slow and it compounds. It is also the only channel in the
first-customers research that produced a customer without anyone making a call.
