# Cadre: key features

Read off the source on 2026-08-24, not from memory. `Changepain/hrpulse` branch `dev` (21 app
sections, 38 API modules, 39 Prisma models) and `Changepain/company-wiki`. Both repos read-only.

Ordered by how much they matter to a sale, not by how much code they are.

---

## 1. Credential and licence tracking

The differentiator. Credentials are a **first-class record**, not a text field on the employee.

- Credential **types** are defined once (name, renewal period, verification link, default reminder
  schedule) and issued to people
- Per credential: licence number, issuer, issue date, expiry date, verification link, uploaded
  certificate, and a self-confirm date for renewals
- Per-credential reminder schedule, defaulting to **60, 30 and 7 days**
- A dedicated **Renewals** view, plus **Reminders** and **Annual reminders**

## 2. The reminder engine

The part that does the work while nobody is watching. Runs daily from a secured cron endpoint,
with a dry-run mode and a feature flag.

- Watches **three date sources**: credential expiry, training and certification expiry, and HR
  calendar events
- Delivers across **three channels**: in-app notification, email, and **Microsoft Teams** via
  Power Automate
- Escalating tone as the date closes
- **The manager is copied a month out and again on the day.** Expiry day alone was too late to be
  useful, because a supervisor hearing on the day a licence lapses has no runway to chase it
- **Expiry day is always evaluated**, even if a custom schedule omits it
- **People who cannot act are skipped**: on leave, or already terminated
- Idempotent per offset, so nobody is reminded twice for the same milestone

## 3. Training that closes the loop

- Courses with a **renewal period**, so a certification regenerates on schedule
- Training records carrying **issue and expiry dates** and the certificate itself
- Assignment by department and by role
- **Completing the course clears the credential.** No re-keying, and no gap between the LMS
  saying done and HR still showing overdue

## 4. Onboarding

- A **staged onboarding engine** with per-step progress
- Steps can be training modules that live in the knowledge base, and completion flows back
  automatically to close the step
- Role-based paths, so a new physiotherapist and a new receptionist get different journeys
- Onboarding drafts, invitations, and document collection

## 5. Employee records

- Full record with employment history, department, division, group, manager chain
- **Org chart**
- Document storage per employee
- Microsoft **Entra ID** identity, and an **ADP** payroll integration
- Audit log on changes

## 6. Policies

- Policy records with versions
- **Per-employee acknowledgement**, which is the part auditors ask for
- Announcements and read tracking

## 7. Performance and conduct

- Review templates, review cycles, contributions from multiple people, and access control on who
  can see what
- Performance reports
- **Incident reports** and disciplinary actions
- **Probation** tracking with dates

## 8. Recruitment

- Job postings and public sharing
- Applications and candidate pipeline
- Straight into onboarding on hire, so nothing is re-entered

## 9. Offboarding

- Offboarding records and checklists
- Equipment return
- **PII clearance** on termination

## 10. Operations

- Tasks
- **Equipment records** issued to people
- Calendar with categories
- **Flow engine**: templates, steps and runs, for repeatable multi-step processes
- Roles and granular permissions
- Reports and a dashboard
- Access requests, verification letters, tax forms

---

## The knowledge and training half

## 11. AI assistant over your own documents

- Staff ask a question and get an answer grounded in the company's own content
- **PHI is scrubbed before anything reaches the model**
- Full-text search plus AI-assisted search
- **Conflict detection**: flags where two documents disagree, which is the thing nobody catches by
  hand

## 12. Document management

- Automatic categorisation of uploads
- Bundles: curated sets of documents for a role or a task
- Acknowledgements, favourites, view analytics and search history

## 13. Course builder

- **AI-generated courses and quizzes** from existing material
- Enrolment tracking
- **Completion certificates**

## 14. Accreditation

- Accreditation **cycles**, standards, and checklist items
- **Evidence tracking** against each standard

## 15. Volunteers, not just employees

A person who needs a credential is not always on payroll. Nonprofits, societies, recreation
centres, sports organisations and social services agencies run on volunteers who carry exactly
the same expiring documents as staff: criminal record and vulnerable sector checks, first aid and
CPR, non-violent crisis intervention, food safe, driver abstracts.

Volunteers are in some ways the harder half of the problem:

- **Higher churn.** A volunteer roster turns over faster than a staff roster, so the records go
  stale faster.
- **Nobody owns them.** Staff credentials sit with HR. Volunteer credentials usually sit with a
  program coordinator, in a separate spreadsheet, because the HR system has no place to put a
  person who is not an employee.
- **The consequence is identical.** An expired record check on a volunteer working with children
  is the same regulatory failure as one on an employee, and the organisation carries it either
  way.

So a person record must support a **type** (employee, volunteer, contractor, student placement,
locum) that changes what is required of them and how they are reported, without forcing them into
a payroll record they do not belong in. Credentials, training assignment, onboarding, policy
acknowledgement and the reminder engine should all work identically for a volunteer. Payroll,
performance reviews, probation and offboarding should not apply.

**Why this matters commercially.** Social services and nonprofits were identified as the vertical
with no dedicated incumbent: safety platforms are construction-shaped and HR platforms assume
everyone is on payroll. Several leads already in the list are exactly this shape, including
Choices For Youth, Spirit of the Children Society, Vivo, Trellis and Union Gospel Mission. A
volunteer-capable person record is what makes the product fit a sector nobody else is serving,
and it is a small change compared to multi-tenancy.

**Status: not built.** This is a requirement, not a feature.

---

## What is not built

Say this plainly rather than let it be discovered:

- **Multi-tenancy.** It assumes one organisation: Entra tenant, SharePoint libraries, domain
  gating, a fixed department vocabulary. This is the work between a demo and a second customer.
- **Mobile field renewal.** Competing safety platforms let a worker renew a ticket from a phone on
  site. Cadre does not yet.
- **Credential-gated equipment or site access.** Same, that is a safety-platform feature.
- **Not genericised.** Names, branding and clinic-specific vocabulary still assume the origin
  deployment.

The first is the only one that blocks a sale. The middle two are worth conceding openly, because
against a dedicated safety platform the argument is not feature parity, it is that they sell no
HR at all.
