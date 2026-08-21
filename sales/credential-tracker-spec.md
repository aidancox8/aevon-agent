# Free credential expiry tracker — spec

**Working name: Lapse.** A free, public, single-job tool: add your staff, add their credentials
and expiry dates, get reminded before they lapse.

Specced 2026-08-21 against `Changepain/hrpulse` branch **`dev`** (read-only). This is mostly
assembly: the hard part is already built and running.

---

## Why build this and not something else

Every no-call channel we looked at needs the product to reach people who aren't customers yet.
This is the only version where the artifact *is* the product.

- **It qualifies perfectly.** The only people who sign up are people who have staff with expiring
  credentials, which is exactly who pays for HR Pulse.
- **It is inbound.** No calls, no cold email. Both of those are spent for Aevon
  (`aevon-no-offer.md`) and unproven for clinics (`first-customers-playbook.md`).
- **The pain is measured, not assumed.** A 20-clinician practice carries 60-120 expiry dates and
  spends 3-5 hours a week tracking them. A lapse means the person cannot legally work that day.
- **There is already a paid category to graduate into.** Credentialing software runs $30-100 per
  provider per month, or $200-400/mo for a small group.

Hormozi's test applies and this passes it where the old Aevon free build failed: signing up costs
a spreadsheet paste, not an explanation of how your business works plus data access plus staff
time plus dependence on an unknown vendor.

---

## The one job

Three screens. Nothing else.

1. **People** — name, email. That is the whole record.
2. **Credentials** — person, credential type, expiry date. Optionally licence number and issuer.
3. **What's expiring** — one list, sorted by date, colour-coded by how close.

Reminders go out by email at 60, 30 and 7 days, and on the day.

If a feature is not one of those three screens, it does not go in.

---

## What lifts straight out of `dev`

### `CredentialType` — take verbatim

`prisma/schema.prisma`. Already has no tenant or employee coupling, so it ports as-is:
`name`, `renewalMonths`, `link`, `reminderDaysBefore` defaulting to `[60, 30, 7]`.

### `EmployeeCredential` — take, minus two fields

Keep `name`, `licenseNumber`, `issuer`, `issuedDate`, `expiryDate`, `reminderDaysBefore`,
`notes`, `link`, `lastRenewedAt`. Drop `certificateFilePath` (file storage is support load and a
privacy surface the free tier does not need) and repoint `employeeId` at the slim `Person` below.

### `credentialHits()` — this is the product

`lib/services/reminders.ts`. The logic worth keeping, all of it already written:

- fires on the offsets stored per credential, falling back to the default set
- **always evaluates offset 0 even when a custom schedule omits it**, because expiry day is a hard
  compliance deadline
- loops the holder's manager in with a month to go *and* on the day, with the comment explaining
  exactly why the day alone was too late to be useful
- skips people who are not currently contactable rather than dispatching into an empty address and
  silently stamping it sent

That manager loop-in is the whole differentiator. The documented failure mode in small practices
is providers self-reporting renewals and telling someone too late. This is the fix, and it is
already coded.

### Reminder idempotency and the cron entrypoint

`app/api/internal/run-reminders/route.ts`: one reminder row per source item per cycle tracking
which offsets already fired, `?dryRun=1`, HMAC constant-time secret compare, and a feature flag so
the route is inert until provisioned. Take the shape of all of it.

---

## What has to change

| Concern | In `dev` | For a public tool |
|---|---|---|
| **Auth** | MSAL / Entra (`@azure/msal-browser`, `@azure/msal-react`) | Email magic link. `@supabase/ssr` is already a dependency, so this is a swap, not new infrastructure. Nobody signing up for a free tool has an Azure tenant. |
| **Person record** | `Employee`: Entra object id, ADP sync fields, banking last four, PII clearance, department vocab, manager chain | `Person`: `id`, `accountId`, `name`, `email`, `managerEmail?`. Nothing else. |
| **Tenancy** | single org | `Account` on every row, RLS by `accountId`. Do this now: retrofitting tenancy is the expensive version. |
| **Teams delivery** | Power Automate webhook, org-specific | Email only on the free tier. Teams is a paid upgrade and it is a strong one, since most of this market is Microsoft-hosted. |

---

## Seed the credential library

This is the difference between "works on day one" and "configure it for a week", and it is data,
not code. **Verify every renewal period against the issuing body before shipping** — do not ship
my numbers as fact.

- **Health, BC**: CPTBC, CCBC, CMTBC, BCCNM, CPSBC registration; BLS for healthcare providers;
  Standard First Aid with CPR C; professional liability insurance
- **Construction and trades**: gas fitter and electrical tickets, fall protection, confined space,
  WHMIS, Standard First Aid, forklift
- **Transport**: Class 1, air brake endorsement, driver medical, dangerous goods
- **Childcare**: ECE certificate, criminal record check, first aid
- **Security**: BC security worker licence, advanced security training
- **Food service**: FOODSAFE Level 1 and 2

Ship one vertical first. Health, because that is where the proof is.

---

## Scope discipline

Do not build, on the free tier: file uploads, CSV import, SMS, Teams, roles and permissions,
org charts, training, onboarding, an API, or an SLA. Every one of those is an upgrade reason.

The named risk is support load, not hosting cost. Resend and Supabase free tiers cover this at
roughly zero, which matters given the standing rule against spend.

---

## The upgrade path

Each of these is a real reason to pay, and each already exists in `dev`:

1. **Teams delivery** — the reminder arrives where they already work. Of 1,872 lead domains
   measured on 2026-08-20, 880 were Microsoft-hosted.
2. **SMS** — for deskless staff. Scope it by workforce type, not clinic size: the credentials that
   actually lapse belong to casuals, contractors and locums who do not read work email between
   shifts. Near-mandatory for trades and transport, optional in a clinic.
3. **Training tied to renewals** — a credential coming due assigns the course that renews it, and
   completion clears the reminder. The HR Pulse to Wiki webhook already does this, and the
   HRIS/LMS split is a documented industry failure: training records live apart from HR records
   and completion is invisible to whoever handles credentialing.
4. **The rest of HR Pulse.**

---

## What to measure

Not signups. **Accounts that have entered a second person**, because one person is a tyre-kick and
two is a real roster. Then: accounts still adding credentials after 30 days, and reminders that
were opened.

The first paid conversation should come from someone who already uses it, which is the entire
point of building it this way.
