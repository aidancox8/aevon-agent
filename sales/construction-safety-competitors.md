# The competitor set I missed: construction safety platforms

Found 2026-08-21 while hunting leads. This corrects the teardown in `pulse/README.md`.

## What I got wrong

I concluded that "nobody at the SMB tier ships credential management, every route is a bolt-on or
a self-build." That is true of **HR platforms** (BambooHR, Rippling, Humi, Collage) and it is what
the teardown actually tested.

It is **not** true in construction. There is a whole mature category of construction safety
software that does credential expiry properly, and I never searched for it because I was comparing
against HR tools.

Named vendors, all selling into Canadian construction: **SALUS Safety, SiteDocs, Corfix,
eCompliance / EcoOnline, Assignar, SiteMax, HammerTech, Bridgit, TrackTik, BIS, SET Safety,
Safety Evolution.**

## What SALUS actually ships

Not a thin feature. From their certificate management page:

- Expiry alerts at **30, 14, 7 and 1 day**
- Credentials on portable worker profiles that move between jobsites
- **Field renewal from mobile**, including multilingual refreshers
- **AI verification of uploaded certificates**
- Credential readiness wired into **work gating**: permits and equipment access
- Compliance reporting for GCs and owners

Mobile renewal and work gating are both ahead of what HR Pulse does today.

## What this means for the beachhead

The two findings from today point in opposite directions and have to be reconciled.

- The health agent found BC healthcare employers publish credential language as **requirements on
  the candidate**, not as an internal tracking job. So healthcare barely advertises this pain,
  which makes signal-based prospecting hard there.
- But trades advertise it constantly, and now we know why the language is so mature: **there is an
  established software category teaching them to talk that way.**

So "trades is the beachhead because the signals are loudest" is probably backwards. The signals are
loudest where the competition is strongest. Selling credential tracking to a BC construction firm
means displacing SALUS or SiteDocs with no clients and no track record, which is the same losing
frame that retired the Front Desk offer.

Where the position is defensible instead:

- **The credential piece is not the product.** Against SALUS it is a feature comparison we lose.
  Against BambooHR the whole suite is the comparison, and there we win: HR, onboarding, training,
  wiki, scheduling and credentials in one system with flat pricing.
- **The verticals with no dedicated incumbent** are healthcare, childcare and social services,
  security and food. SALUS and SiteDocs are construction-shaped and do not sell HR at all.
- **Nobody in either category joins credentials to HR.** SALUS has no onboarding, no policy
  acknowledgement, no performance reviews, no wiki. BambooHR has no credential engine. That seam is
  still open and it is still the real differentiator.

## Market evidence worth keeping

These four are **SALUS customers**, so they are not leads. They are proof that companies of this
size pay to solve exactly this problem, in their own words, describing life before they bought:

- **Mazzei Electric** (Nanaimo BC, ~280 staff): *"Certifications expired without warning.
  SharePoint couldn't push notifications or track action."*
- **Villa Roofing & Sheet Metal** (Vancouver BC, 150+ workers across 30 crews): *"Training
  certificates expired without warning, and no one had time to track them."*
- **Appia Developments** (Vancouver BC, ~20 staff, 150+ subcontractors): *"Forklift certifications
  expired without anyone noticing until an audit or incident forced the question."*
- **Stampede Electric** (Calgary AB, 50 field workers): *"Stampede was drowning in paper. Every
  form, inspection, and certificate was printed, hand-filled, collected in binders, and filed in a
  system that only technically qualified as organized."*

"Expired without warning" appears twice, independently. That is the sentence the product prevents,
and it is worth reusing in copy, as an observation about the category rather than a claim about
anyone's clients.

## Method note

Vendor case studies with a narrative "The Situation" section are the single richest source of
tool-gap evidence found so far, far better than review sites. G2, TrustRadius, Capterra and GetApp
all anonymise the reviewer's employer for HR products, and G2 and TrustRadius block fetching
outright. Vendor testimonial walls are first-name-only.

The catch is structural: anyone appearing in a case study has already bought. Mine these for
**evidence and language**, never for leads.
