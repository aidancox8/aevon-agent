# The Aevon cold email has no offer

**Replaces "name one job your team does by hand and I'll build a working version of it, free."**
Decided 2026-08-19. Same three practitioners, same verdict as the Tempo side
(`tempo-diagnostic-offer.md`), different conclusion about what replaces it.

## Why the free skeleton had to go

**Hormozi.** *"If you struggle to give your stuff away for free, it means either people don't
want it, they don't believe you, or the hidden costs are too high. In short, your 'free' stuff
is too expensive."* A free custom build is not free to accept. It costs the owner an
explanation of how their process actually works, access to their data, staff time to test it,
and the risk of depending on one unknown person. Roughly 1,100 cold sends at about 0% genuine
replies is that diagnostic returning a result, not a copywriting problem.

**Enns.** A first step should be *"a first step and not a sample twenty-fifth step."* Building a
working version of a process means first understanding the process, which is the actual work,
done without their involvement and without being paid for it.

**Stark** prices his diagnosis at $1,295. The person who teaches value pricing productized his
rather than giving it away.

There is a fourth reason specific to cold email. A stranger offering free custom software has
to survive the question of why it is free, and the honest answer, that there is no track record
yet, is the part that does the damage. The offer advertises the weakness.

## What replaces it: nothing

Not a cheaper offer. No offer.

A cold first email cannot sell a paid diagnostic either, and should not try. The paid version of
this already exists and belongs on a call: the CA$1,500 clinic assessment
(`clinic-assessment.md`). The email's job is to earn one reply.

So the body states a fact about how that business works, says in one plain sentence what gets
built, and stops. The closing `{{ASK}}` is a question a busy person can answer from their phone
in one line, including "no". Nothing is offered, so there is nothing to weigh up, and a reply
commits them to nothing.

Taking no as a real answer is deliberate. At ~0% reply rates the scarce thing is information
about whether the guess was right, and an ask that only accepts yes never returns any.

## What this does not change

Aevon is no longer developed as a client-seeking business (`project_aevon_decision.md`). No
channel exists at zero clients. Fixing the offer does not fix that, and this should not be read
as reopening it. It was worth doing because the `{{ASK}}` token made it a one-file edit, and
because the queue was going to keep sending the retired offer either way.

## What actually shipped on 2026-08-19

The offer rewrite was the small half. The queue was in worse shape than the offer:

- `applyAsk` appended the ask whenever the `{{ASK}}` token was missing. Zero of 5,470 third
  emails carried the token, and every one is a breakup note ending "Either way, all the best."
  Every one had a fresh pitch stapled on after the sign-off. 2,180 second emails already ended
  in a question and were going out asking two different things at once. It no longer appends to
  follow-ups, or to any body that already ends in a question.
- 1,987 queued bodies still quoted the $1,500 setup fee retired on 3 August. `strip-price.js`
  had been filtering on `last_sent_at IS NULL`, which skipped every lead past email 1, meaning
  the follow-ups still due to send were the exact population it never touched. Both strippers
  are now step-aware: they clean only the fields that have not been sent, so the stored record
  of what actually went out is preserved.
- 2,308 bodies argued the free build outside the token. `strip-free-build.js` removes the
  promise as a clause rather than deleting the sentence, so the capability line survives.

Due to send afterwards: 38 stale prices and 79 free promises, down from about 2,000 each, and
those are held rather than sent (below).

## The safeguard, so this is the last time

This is the third offer to outlive its retirement in the queue. `lib/copy-guard.js` runs on
every send and holds anything quoting a retired price or promising the retired free build. The
lead stays queued, regen-copy rewrites it on its normal run, and it sends the next day. A hold
costs a day, not a lead. When an offer is retired, add its pattern there.
