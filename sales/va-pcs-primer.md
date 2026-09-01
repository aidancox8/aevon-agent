# VA and PCS: enough to hold a conversation with a military relocation broker

Written 2026-09-01 for the Thursday call with Sofia Epps (Skyline Properties, near JBLM).
Every figure below was checked on 2026-09-01, not recalled. Sources at the bottom.

**Why this exists.** You are selling to someone whose entire business is VA-financed military
relocation. You do not need to know more than she does, and pretending to would be fatal. You
need enough to follow her without asking her to explain her own trade, and enough to know why
the questions the agent asks are the right ones. That is all this is for.

**The one rule: never give advice.** You are not a lender, an agent, or a VA representative.
If a factual question comes up you cannot answer, "I would want to check that rather than guess"
is a perfectly good answer and costs you nothing with someone who deals with rules for a living.

---

## The vocabulary, in the order it comes up

**PCS** — Permanent Change of Station. The military moving someone to a new duty station. It is
the event that creates every one of her buyers.

**Orders** — the written assignment. "Orders in hand" versus "pending" is the single most useful
qualifier in her business, because it separates a buyer with a deadline from someone speculating.

**Report date** — when they must be at the new station. Every other date hangs off this one.
It is the reason a report-date question outranks a budget question in her intake.

**HHT, house hunting trip** — a short trip to the new area, often ten days, to find a home before
the move. If someone names an HHT window, that is a hard, dated appointment request.

**BAH** — Basic Allowance for Housing. A monthly housing allowance that varies by rank, location
and dependents. It is how a lot of buyers frame affordability. Do not quote a figure for JBLM;
you have not checked one and she knows them.

**JBLM** — Joint Base Lewis-McChord, the large joint Army and Air Force base south of Tacoma.
Her market.

---

## VA loans: the parts that decide deals

**Certificate of Eligibility (COE)** proves the borrower has the benefit and shows their
entitlement, prior VA loan usage, and funding fee exemption status. Most lenders pull it
electronically in minutes from a Social Security number. It is not usually a delay in itself,
but a buyer who has never touched it is a buyer who has not spoken to a lender yet, which is
what actually matters.

**Entitlement.** With **full entitlement** (no prior VA loan use, or fully restored) there is
**no VA-imposed loan limit** and no down payment required. With **partial entitlement** (an
existing VA loan still open, or a prior one not restored) zero-down buying power is capped at
the county conforming limit, **$832,750 in most areas for 2026**. This is why "have you used
your VA loan before" is a real qualifying question and not trivia: a second-time user with a
house still financed at their last duty station is a different buyer entirely.

**No down payment and no mortgage insurance.** The two headline benefits, and the reason nearly
everyone eligible uses it.

**Funding fee**, 2026, purchase loans:

| Down payment | First use | Subsequent use |
|---|---|---|
| None | 2.15% | 3.30% |
| 5% or more | 1.5% | 1.5% |
| 10% or more | 1.25% | 1.25% |

IRRRL refinances are 0.5%. **Exempt entirely:** veterans with a service-connected disability
rating of 10% or higher, surviving spouses receiving DIC, and Purple Heart recipients on active
duty. The exemption is worth real money (2.15% of a $500k loan is about $10,750), which is why
it appears on the COE and why lenders ask early.

**Occupancy.** The buyer must certify intent to occupy as a **primary residence within 60 days
of closing**. Two exceptions worth knowing because they are common in her world: a deployed
service member's spouse or dependent child can satisfy occupancy, and a buyer who receives PCS
orders before occupying can request a timeline extension.

---

## Assumption, the thing most worth knowing in 2026

**All VA loans are assumable**, with both servicer and VA approval, and the buyer qualifying
financially with the servicer. In a high-rate market a seller carrying a 2 or 3 percent VA loan
is holding something genuinely valuable, and military sellers are disproportionately the ones
holding them.

- The assumption funding fee is typically **0.5% of the balance assumed**, and the same
  exemptions apply.
- **No new appraisal is required** in most cases.
- **The equity gap is what kills these deals.** The buyer must cover the difference between the
  price and the remaining balance, in cash or through secondary financing. Secondary financing
  means a second underwriting track with its own appraisal and conditions, and a contract
  timeline that does not account for both approvals is the usual cause of a collapse.
- **Entitlement matters to the SELLER here.** If a non-veteran assumes the loan, the seller's
  entitlement generally stays tied up in it. That is a genuine reason a military seller might
  refuse an otherwise good assumption, and it is a thing an agent has to explain constantly.

If you want one line that shows you have done homework without pretending to be an expert, it is
this: *"With assumptions, is the equity gap the thing that usually blows them up for you?"*

---

## How this maps to what you are selling

Every fact above is a reason the qualification list in the `skyline` config is what it is:

- **report date** because it is the deadline everything else hangs off
- **orders in hand or pending** because it separates a buyer from a browser
- **VA or conventional, and COE status** because it tells her whether a lender has been spoken to
- **first use or subsequent** because partial entitlement caps zero-down buying power
- **a house to sell at the current station** because that is two transactions and possibly a
  tied-up entitlement
- **distance from the gate** because commute to the specific gate is how her market prices itself

An off-the-shelf assistant asks for budget and timeline. That is the whole argument for a build,
and it is worth saying out loud on the call in exactly those terms.

---

## Sources, checked 2026-09-01

Funding fee tables and exemptions: [Veterans United](https://www.veteransunited.com/valoans/va-funding-fee/),
[Military.com](https://www.military.com/va-loans/learn/eligibility-requirements/va-funding-fee-guide).
Entitlement, COE and the 2026 conforming limit: [VA Loan Network](https://valoannetwork.com/va-loans/va-loan-requirements/),
[NewDay](https://www.newdayusa.com/learn/eligibility-COE/va-home-loan-eligibility-guidelines).
Occupancy and its PCS exceptions: [valoans.com](https://www.valoans.com/eligibility/va-occupancy-requirements/),
[VA Loan Network](https://valoannetwork.com/va-loan-occupancy-exceptions/).
Assumption rules, fee, appraisal and the equity gap: [Veterans United](https://www.veteransunited.com/valoans/va-loan-assumption/),
[VA Loan Network](https://valoannetwork.com/va-assumptions-secondary-financing/).

These are lender and industry sources, not the VA itself. For anything you intend to state as
fact to a client rather than use as background, confirm it at **va.gov**.
