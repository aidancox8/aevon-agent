# Seed placement test

Answers one question: does the current cold email land in the inbox, or in spam/junk?

Resend "delivered" means the receiving server accepted the message. Spam placement counts
as delivered. Replies and even auto-replies both went to zero while sends continued, which
is what worsening placement looks like, not what falling interest looks like.

## When to run it

- After ANY change to the email shape: body template, signature, headers, sending domain,
  Resend settings. The 2026-08-18 HTML signature and the pre-2026-09-17 link builds both
  looked fine in Resend and both went to spam/junk. The dashboard cannot tell you this.
- When reply rate drops to zero for a week with sends continuing.

## How

1. Build a seed panel. This matters more than anything else: most business buyers are on
   Microsoft 365, and Outlook was the provider that junked the old builds. A Gmail-only
   panel answers the Gmail question and nothing else. Minimum useful panel: one Gmail,
   one Outlook/Hotmail, one Yahoo, all addresses you can open.
2. Put them in `seeds.json` (gitignored, never committed):
   `[{ "email": "you@gmail.com", "provider": "gmail", "label": "personal" }]`
3. `node seed-placement-test.js --send --seeds seeds.json`
4. Wait 10 minutes. Then `node seed-placement-test.js --check --seeds seeds.json`.
   Gmail seeds are checked automatically via the Gmail API (needs `SEED_GMAIL_*` env, one
   OAuth token per seed mailbox, minted with `node get-gmail-token.js` while signed in as
   that seed account). Outlook/Yahoo seeds are manual: open the mailbox, search for the
   subject, record inbox vs junk.

## Reading the result

- Inbox (Gmail primary-ish, Outlook inbox): the shape is fine. A zero reply rate is a
  copy/targeting problem, not a delivery problem.
- Promotions/Updates tab: soft fail. Worth fixing (simpler subject, less newsletter shape)
  but not the reply drought.
- Spam/Junk: hard fail. Stop sending the campaign shape until the cause is found. Check,
  in order: authentication (SPF/DKIM/DMARC), the signature (no masked links, no remote
  images), content (no URL shorteners, no link-heavy footer), domain reputation
  (Google Postmaster Tools, Microsoft SNDS).
- Never arrived: check the Resend dashboard for a bounce/block on that address first.

Results append to `seed-test-results.json` (gitignored). Keep them; placement history is
how you catch the next silent regression.
