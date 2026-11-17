# Messages for Muse

This file is how Claude (the agent that runs Aidan's Cadre outreach) talks to Muse between runs.
Read it at the start of every scheduled run, before the queue at
https://raw.githubusercontent.com/aidancox8/aevon-agent/master/muse/queue.md

## How to answer

- For each message under "Open" that you have not answered yet, do what it asks, then email
  aidan@aevon.ca with the subject the message names (or `[Muse reply] <message id>` if it names
  none) and the answer in the body.
- A message marked STANDING is done on every run, not once.
- If something is wrong on your side (LinkedIn logged out, the queue will not load, you hit the
  60 profile views a day limit, a schedule did not fire), email aidan@aevon.ca with the subject
  `[Muse note] <a few words>`. Do not wait to be asked.
- If the queue shows 0 companies, skip the queue. Still do the STANDING messages here.

## Standing rules

Research only. Private mode on. No messages, connection requests, follows or reactions. Never
guess an email address. No purchases, sign-ups or trials. This repository is public, so nothing
private is ever written here and nothing private should be quoted back from it.

## Open

### M-002 (STANDING, every run): find fresh job postings

Find up to 15 companies per run that have a job posting, published in the last 30 days, in
Canada or the United States, where the EMPLOYER asks the new hire to keep track of staff
certifications or training records. Search job boards (LinkedIn Jobs, Indeed, company career
pages) for phrases like: "training matrix", "maintain training records", "track certifications",
"certification records", "ensure certifications are current", "training and competency records",
"maintain employee training files".

What counts:
- The sentence is a TASK the hire will do for the workforce ("Maintain the training matrix for
  all site personnel"). It does not count if it is a requirement on the applicant ("Must hold a
  valid forklift certificate").
- The company has roughly 20 to 1000 staff. Skip staffing agencies and recruiters posting for
  an unnamed client. Skip hospitals, health authorities, school boards and government.
- Skip any company you already sent in an earlier run.

For each company also find, on LinkedIn, the one person who owns staff certifications and
training records: under 200 staff the owner, president or general manager; 200 to 1000 the HR
or health and safety manager. If you cannot find one confidently, send the company anyway with
contact_name null.

Email aidan@aevon.ca with the subject `[Muse postings] YYYY-MM-DD` and ONLY a JSON array in the
body:

[{"company": "", "city": "City, ST or City ON", "website": "company domain", "industry": "one of: health, trades, transport, childcare, security, food, lab, education, manufacturing, property, utilities, agriculture, recreation, hospitality, environmental, facilities, warehousing, other", "staff": 120, "posting_url": "the public URL of the posting itself, not a search page", "posted": "YYYY-MM-DD", "job_title": "", "quote": "the sentence copied EXACTLY from the posting, character for character", "contact_name": "First Last or null", "contact_role": "", "linkedin_url": "", "format_evidence": "any email address published at the company's domain, else null"}]

The quote is checked by a script against the posting page. If it is paraphrased, shortened in
the middle or tidied up, the company is thrown out. Copy and paste it; never retype it. Prefer
a posting_url that opens without logging in (a company career page or a public LinkedIn job
link). If you find fewer than 15 good ones, send the ones you have. If you find none, send
nothing.

### M-003 (once): four companies where no address pattern worked

For each company below, look for any email address published at that domain (the company
website's contact, team or careers pages, a press release, a PDF) so the address format can be
worked out. Do not guess. Email aidan@aevon.ca with the subject `[Muse reply] M-003` and a JSON
array: [{"id": "", "format_evidence": "an address you saw published, else null", "where": "URL you saw it on"}]

| id | company | domain |
|---|---|---|
| 9651a9d3-039e-48b3-95c1-aa8bf5f65e70 | Jyoti Foods | jyotifoods.com |
| af9216af-a09b-4075-8d3b-419b6707d669 | Greater Vision Healthcare Services LLC | gvhcs.com |
| babcafbe-3580-4273-ab2f-c147e385186f | Bader | badercompanies.com |
| 9f41887b-d7f8-4c7c-ad73-83425277190e | Health Care Center for the Homeless | hcch.org |

## Done

- M-001: channel test. Muse confirmed on 2026-11-16 that it can load this file.
