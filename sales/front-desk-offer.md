# The Aevon Front Desk — lead response system (rescoped 2026-09-01)

Rescoped and repriced after the first real inbound lead (Sofia Epps, solo broker near JBLM)
made the old version look thin. Aidan's words: *"i dont rly think it has enough value to be
sold for $900. drafting up emails automatically is easy work."* He was right. Drafting is a
commodity, and the old scope was a commodity priced like one.

## Why this is not the Front Desk that got retired

The 2026-08-03 retirement stands and the reasoning was correct: **a generic product with no
track record loses to cheaper products with years of one.** Nothing here reverses that.

What changed is the scope. The retired version was an inbox tool, which is exactly the kind of
thing a SaaS company sells better and cheaper. This version is wired into ONE business's actual
funnel: their ad sources, their CRM, their qualification logic, their calendar. That is the
thing Aevon's positioning says it sells and a SaaS company structurally cannot.

So this is still not the cold-email offer. It is what gets sold on a call to someone who has
already put their hand up.

## The one-liner

Every lead you pay for gets answered in under a minute, day or night, by text and email, asked
the questions you would ask, written back into your CRM so your caller works the warm ones
first, and booked into your calendar. You approve everything until you decide you do not need to.

## Scope

1. **Sub-60-second response, 24/7**, to every lead from their ad sources and landing pages.
   At the FRONT of the funnel, not after a human has already handed off.
2. **SMS and email**, not email alone. See the TCPA section: SMS is gated on consent capture
   and is quoted as contingent until their forms are checked.
3. **Qualification written for their vertical**, not a generic script. For a military
   relocation broker that means report date, orders in hand or pending, COE and entitlement
   status, BAH budget, on-base or off, target areas.
4. **Writes qualification back into their CRM**, so their existing callers dial the hot leads
   first instead of working down a cold list. This makes the people they already employ more
   effective, which is also the answer to "I already have an ISA."
5. **Books ready leads** straight onto their calendar.
6. **Multi-day follow-up across both channels**, on a schedule they set, that then stops.
7. **Weekly numbers by ad source**: leads, response time, contact rate, appointments set. Most
   owners buying Meta and Google ads cannot say which source produces closings.

Items 4 and 7 carry the most weight in a pitch, because they make money the client already
spends work harder rather than threatening anything.

## What exists today vs what is a build

Honest inventory, because "live in a week" is not true at this scope.

| Piece | State |
|---|---|
| Inbox read, classify, qualify, draft in owner's voice, booking link | **Built** (`intake-agent.js`) |
| Approve-first with a graduated auto-send dial | **Built** 2026-09-01, see below |
| Pipeline board | **Built** (`crm/index.html`) |
| SMS send/receive | **Not built.** Twilio plus consent capture and STOP handling |
| Facebook Lead Ads / Google webhook ingestion | **Not built.** Per-source integration |
| CRM write-back | **Not built.** Depends entirely which CRM |
| Weekly per-source reporting | **Partial.** The digest pattern exists (`daily-review.js`) |

**Quote three to four weeks, not one.** Only the inbox half is real today.

### The autonomy dial (built 2026-09-01)

`intake-agent.js` now has a real approve-first-then-graduate toggle, which is what the pitch
promises. `autoSend` is a per-client config field defaulting to off, and turning it on is not
sufficient on its own: the environment must also carry `INTAKE_AUTOSEND_ARMED=true`. Every
condition fails closed. Per-message, a send is demoted to a draft by an unsafe reply
(placeholder, template token, model self-reference, refusal text, too short or too long), an
automated recipient, a repeat to the same address that day, the daily cap, or a failed send.

**An `@aevon.ca` mailbox can never auto-send**, enforced in code, because CLAUDE.md rule 1
governs Aevon's own outreach and must not depend on anyone remembering it.
`node intake-agent.js --autonomy` prints the decision and the reason without touching a
mailbox. `--drafts-only` overrides everything. Regression test:
`node check-intake-autonomy.js` (23 assertions).

## Price

**USD for US clients** (the CAD default in CLAUDE.md is for BC work; the benchmarks below are
all USD and the first prospect is in Washington).

- **List price: $2,500 setup, $300/month.** This is the number the offer is worth and the
  number every prospect hears first.
- **Founding rate, first two clients: $1,000 setup, $100/month locked for twelve months**, in
  exchange for a testimonial, a case study, and one or two introductions. Deposit required.
- Client owns the software. Cancel the monthly and self-host.

**The list price must be said out loud before the founding rate, every time.** Aidan's decision
2026-09-01 was to go cheap for the first client, and that is the right call for a business with
no proof: client one is bought, not sold to, and what it buys is a testimonial, a case study,
referrals, and a real deployment to learn from. But cheap only works as a *discount*. Quoted
bare, $1,000 does not read as a favour, it reads as what the thing is worth, and it sets the
anchor for every renewal and every referral she sends. Say "it is $2,500 and $300, you are the
first so it is $1,000 and $100," and never the number alone.

**At this price the protection is scope, not margin.** A three-to-four week build for $1,000
leaves no room for anything unbudgeted, so the guardrails below are load-bearing rather than
advisory. Take a deposit, and deliver in two stages (email half first so something is live
early, SMS and CRM write-back second) so a stalled integration does not mean nothing shipped.

## The build is easy. The approvals are not.

The engineering here is genuinely light and Aidan is right about that. Twilio send and receive
is an afternoon, the classifier and drafting already exist, and the reporting follows the
`daily-review.js` pattern. What actually sets the timeline is third-party review that no amount
of coding speed shortens (verified 2026-09-01):

- **A2P 10DLC is mandatory for any US business texting at scale**, real estate lead follow-up
  explicitly included. Brand approval is 1 to 3 business days, but **campaign review is running
  10 to 15 days in mid-2026** on submission volume.
- **The opt-in URL must be live and carrier-verified before the campaign is approved.** So the
  client's consent language is a hard prerequisite that gates the whole SMS build, not a
  tidy-up at the end.
- **New in 2026: a reseller ID is mandatory when registering on behalf of another entity**, and
  the EIN must be at least 15 days old. Registering under the CLIENT's brand, with their EIN and
  their opt-in URL, is cleaner than Aevon registering as a reseller and taking on their
  compliance.
- **Skipping registration is not a shortcut.** T-Mobile charges $2,000 to $10,000 per violation
  for unregistered traffic, and AT&T and Verizon block silently, which is the worst failure mode
  available: a client paying for replies that are never delivered and no error to see.

Sources: [Conduit 2026 guide](https://www.conduit.ai/blog/a2p-10dlc-registration-step-by-step-for-2026),
[TxtImpact](https://www.txtimpact.com/blog/a2p-10dlc-registration-guide),
[Quo](https://www.quo.com/blog/what-is-a2p-10dlc/).

**Two gates worth designing around rather than through.** Read leads from the client's CRM and
their own landing page posts rather than integrating Meta directly, which avoids Facebook App
Review entirely. And ship the email half in week one while 10DLC is in the queue, so the client
has something working long before the long pole clears.

### What the category charges (verified 2026-09-01)

- **Structurely** (the closest direct competitor, AI that texts and qualifies real estate
  leads): **$499/month plus $0.12 per action credit, on top of a $2,500 setup fee.** Raised
  prices 25% in April 2026. Entry tiers from $179.
- **Ylopo**: roughly **$395 to $945/month**, pricing hidden behind a demo call.
- **Full platforms** (Ylopo, CINC): **$600 to $2,000+/month before ad spend.**
- **A human ISA**: US average **$69,398/year (about $33/hour)**, typical base **$35,000 to
  $50,000**, plus 5 to 15% of GCI or $500 to $1,000 per appointment held.

Sources: [SuperDupr comparison](https://superdupr.com/blog/structurely-vs-ylopo-vs-roof-ai),
[NurtureOS on ISA cost](https://www.nurtureos.io/blog/isa-cost-2026/),
[ZipRecruiter ISA salary](https://www.ziprecruiter.com/Salaries/Real-Estate-Inside-Sales-Agent-Salary).

**Structurely's setup fee alone is $2,500.** $2,500 plus $300 undercuts them on both axes while
doing more, and is a rounding error against an ISA. The old $900 was not a discount, it was a
signal that the thing was not worth much.

## TCPA, and why SMS is quoted as contingent

Verified 2026-09-01. **Not legal advice, and Aidan is not a lawyer. This is enough to scope and
price honestly, not enough to indemnify anyone.**

- **Marketing SMS requires prior express written consent.** Statutory damages are **$500 to
  $1,500 per message**, with class action exposure. The obligation attaches to whoever sends
  the message, not to whoever generated the lead, so buying a lead transfers the data and not
  the consent ([ActiveProspect](https://activeprospect.com/blog/tcpa-text-messages/),
  [iSpeedToLead](https://ispeedtolead.com/blog/tcpa-rules-for-buying-real-estate-leads-in-2026/)).
- **The FCC's one-to-one consent rule is NOT in force.** The Eleventh Circuit vacated it on
  **24 January 2025** in *Insurance Marketing Coalition v. FCC*, holding the FCC exceeded its
  statutory authority, and the FCC said in April 2025 it would not challenge the ruling. The
  pre-2023 prior express written consent standard governs
  ([Kelley Drye](https://www.kelleydrye.com/viewpoints/blogs/ad-law-access/eleventh-circuit-vacates-tcpa-11-consent-rule),
  [Venable](https://www.venable.com/insights/publications/2025/01/eleventh-circuit-overrules-fccs-one-to-one),
  [Debevoise](https://www.debevoise.com/insights/publications/2025/01/the-eleventh-circuit-invalidates-tcpa-rules)).
  **Note:** at least one vendor blog still describes a "January 2026 one-to-one rule" as live.
  It is wrong, and the law firm consensus above is what to rely on.
- **Revocation rules took effect 11 April 2025.** A simple opt-out such as replying STOP must
  be offered and honoured promptly.
- **Telemarketing and informational messages still carry different consent standards.** The
  Eleventh Circuit expressly declined to reach the challenge to that distinction, so the 2012
  heightened standard for telemarketing remains. A reply to someone's own inbound inquiry about
  a specific property sits closer to informational than to telemarketing, which puts a client
  answering their OWN form fills in a much better position than a list buyer. It is a genuinely
  grey area and not a licence to skip consent.

**What this means operationally.** Before quoting SMS, look at the client's own lead forms. They
need an unchecked consent checkbox, a clear disclosure, a statement that consent is not a
condition of purchase, and timestamped consent records retained as the defence. If their forms
lack this, that is an existing exposure they already have, and fixing it is a reason to be in
the room. If they will not fix it, sell the email half and drop SMS from the scope.

## Scope guardrails

Included: one inbox, one calendar, one pipeline, up to three document templates, one voice, and
up to two lead sources. Additional ad sources, a second CRM, multiple brands or offices, or any
telephony beyond SMS is a separate quote (`quote-template.md`). At $1,500 founding you cannot
absorb an unbudgeted CRM integration, and agreeing to one on the call is how this goes bad.

## How to sell it

The playbook rules from `first-five-calls.md` all still apply, and the important one most of
all: **quote a real price mid-conversation and then stop talking.**

1. Open by making them describe their own funnel. Do not pitch until they have finished.
2. Say the gap back to them in their words, and get THEM to say the wait time out loud.
3. Name the scope narrowly, and say what you are not touching.
4. Price, then silence.
5. Close on "who else should I be talking to?"

Disclose that they would be the first client, unprompted, tied to the founding rate. Aevon has
zero clients and fudging that is the one thing that cannot be recovered
(CLAUDE.md: never fabricate clients or references).

---

## History

**2026-07-05, original productized offer.** One product, one price, one week: $1,500 setup and
an optional $150/month, founding rate $900 setup and $100/month for the first two clients. The
Gemini/Copilot objection was answered by insisting it is a worker wired into their workflow
rather than an email-writing aid, which is still the right frame and is why scope items 4 and 7
matter more than the drafting does.

**2026-08-03, retired as the lead offer.** Aidan: *"get rid of the whole Front Desk thing. i can
still build it, but its not rly that strong of a sell imo."* A productized flagship and a
bespoke-build pitch contradicted each other in the same email. Outreach stopped naming it,
`frontdesk.html` stayed live but noindex so existing links did not break. Current cold-email
position remains no offer at all (`aevon-no-offer.md`).

**2026-09-01, rescoped and repriced.** This document. Triggered by a live prospect and by
checking what the category actually charges instead of guessing.
