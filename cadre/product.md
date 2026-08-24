# Cadre: what the product actually is

Written 2026-08-24 from the source, not from memory. Read off `Changepain/hrpulse` branch `dev`
(39 Prisma models, 545 PRs, live at hrpulse-cpc.web.app) and `Changepain/company-wiki`
(21 models, ~111 TS files, live on Firebase and Render). Both repos are read-only.

Cadre is the sellable version of those two apps, the way Tempo is the sellable version of Cadence.

---

## One line

**Cadre is the HR system for companies whose people need tickets to work.**

## One paragraph

Cadre holds the employee record, the onboarding, the training and the credential in one place,
so a certification that is about to lapse triggers the course that renews it, and completing that
course closes the credential without anyone re-keying anything. It reminds the person, escalates
to their manager before the expiry rather than after, and delivers into Teams and email rather
than a portal nobody logs into. HR platforms treat certifications as a text field. Safety
platforms track certifications but know nothing about hiring, policies or reviews. Cadre is the
one system that does both, priced flat per clinic or site instead of per employee.

## The sentence that earns the meeting

Most companies at this size are paying per seat for an HR tool that cannot tell them who is about
to fall out of compliance, and are running the actual answer on a spreadsheet somebody maintains
by hand.

---

## What is actually built

### Credentials and renewals, the differentiator

- `CredentialType` and `EmployeeCredential` are **first-class models**, separate from courses.
  Licence number, issuer, issue and expiry date, verification link, certificate file, and a
  per-credential reminder schedule.
- Default lead times of **60, 30 and 7 days**, overridable per credential.
- A dedicated **renewals** view, plus **reminders** and **annual reminders**.
- `/api/internal/run-reminders` is a daily cron entry point, secret-guarded with a constant-time
  compare, feature-flagged, with a dry-run mode.

The reminder engine is the part competitors do not have in this shape. It scans three date
sources (credential expiry, training and certification expiry, and HR calendar events), finds
what is due today against each item's own offsets, and fans out across **three channels**:
in-app notification, email, and **Teams via Power Automate**.

Three details in it that matter, all of them decisions rather than defaults:

- **Expiry day is always evaluated**, even when a custom schedule omits it, because it is a hard
  compliance deadline.
- **The manager is looped in with a month to go and again on the day.** Expiry day alone was too
  late to be useful: a supervisor hearing on the day a licence lapses has no runway to chase it.
- **Nobody who cannot act is chased.** People on leave or already terminated are skipped, rather
  than dispatching into a cleared address and silently stamping it sent.

### Everything else in the HR app

Employee records with employment history. Recruitment: job postings, applications, sharing,
candidates. A staged **onboarding** engine. **Training**: courses with renewal periods, training
records with expiry. **Performance**: review templates, contributions, access control, reports.
**Incidents** and disciplinary actions. **Probation** and **offboarding**. **Policies** with
per-employee acknowledgement. Tasks. Equipment records. Org chart with departments, divisions and
groups. Roles and granular permissions. A **flow engine** (templates, steps, runs) for repeatable
processes. Audit logs. Document storage. Microsoft Entra ID identity and an ADP integration.

### The knowledge and training half

An AI assistant answering staff questions grounded in the company's own documents, with **PHI
scrubbed before anything reaches the model**. Automatic categorisation of uploaded documents.
Full-text and AI-assisted search with **conflict detection across documents**. Role-based
onboarding paths. **AI-generated courses and quizzes** with enrolment tracking and completion
certificates. Document bundles. **Accreditation cycles**: standards, checklist items, and
evidence tracking. Announcements, acknowledgements, notifications, and analytics on what is
actually read.

### The seam between them

The two apps are joined by a webhook contract. The wiki owns training content and completion
logic; the HR app owns onboarding steps. When someone finishes a course, the wiki reports it and
the HR app **auto-completes the matching onboarding step**. It is idempotent and retries, and it
fails soft rather than breaking a completion.

That seam is the whole argument. The HRIS/LMS split is a documented industry failure: training
records live in one system, HR records in another, and completion is invisible to whoever handles
credentialing. Cadre closes it.

---

## Why this wins, stated honestly

**Against HR platforms** (BambooHR, Rippling, Humi, Collage): none of them ships credential
management. BambooHR has no credentialing module at all and its custom fields cannot trigger
workflow automations. Rippling's own published customer story is a 330-person company that
**built their own** licence tracker in App Studio, which took an HR Director who can build apps.
Humi's training module has no expiry, so customers bolt on a third-party tool.

**Against safety platforms** (SALUS, SiteDocs, eCompliance, Assignar): these are real competitors
and they do credentials well, in some ways better, including mobile field renewal and
credential-gated equipment access. But they are construction-shaped and sell no HR at all: no
onboarding, no policy acknowledgement, no performance reviews, no recruitment. Do not fight them
on credential features. Fight on the fact that a company needs both and is currently buying two
things.

**Against a spreadsheet**, which is the real incumbent almost everywhere. A 20-clinician practice
carries 60 to 120 expiry dates. Tracking them by hand runs 3 to 5 hours a week. A lapse means the
person cannot legally work that day.

## Pricing shape

Flat monthly, banded by headcount, flat within a band. The line is: **per-user pricing means your
software gets a raise every time you hire.**

The knowledge and training half belongs in a higher tier, because it is the only component with
real per-use cost (model tokens per question and per document ingested). Everything else is fixed
cost to serve. That cost is measurable from the live deployment rather than guessed.

Anchor against the whole stack a buyer already pays for, not one line item. BambooHR is about
$10/employee/month on Core and $17 on Pro, with a flat $250/month floor under 25 employees.
Credentialing tools sold separately run $30-100 per provider per month, or $200-400/month for a
small group. A 75-person organisation doing this properly is paying $1,200-1,700 a month across
two products.

## What to be careful about

- **Zero customers.** The only honest reference is "a 75 staff multidisciplinary clinic in BC",
  with nothing added. No room counts, no discipline counts, no claimed NDA, and never the
  employer's name.
- **Not yet genericised.** Tempo went through that before it could be sold; this has not, and the
  wiki holds clinical documents.
- **Multi-tenancy does not exist.** Entra tenant assumptions, SharePoint libraries, domain gating
  and a hardcoded department vocabulary all assume one organisation. That is the work between a
  demo and a second customer, and it should be done when someone says yes, not before.
