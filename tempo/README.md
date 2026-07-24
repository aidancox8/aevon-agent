# Tempo campaign (clinic staff/room scheduling)

Separate pipeline from Aevon: own tables (`tempo_leads`, `tempo_email_events`), own scripts.
Switching back to Aevon = just don't run these. Nothing here touches `leads`.

## The pieces
| Script | What it does |
|---|---|
| `lead-finder.js` | Google Places clinic sweep. `--region bc` (default) / `canada` / `all`. Excludes Changepain + Artus, DNC-sanitizes contacts. |
| `hunt-emails.js` | Deep email dig for leads without one (Cloudflare decode, JSON-LD, wide crawl). `--dry-run` first. |
| `personalizer.js` | 3-email sequence per lead. Allied clinics get Jane-adjacent copy + allied demo; medical get on-call copy + medical demo. |
| `sender.js` | **Dry-run by default.** `--send` to go live (set pricing first). Daily cap `TEMPO_DAILY_CAP` (20). Optional dedicated Resend account via `TEMPO_RESEND_API_KEY` + `TEMPO_FROM_EMAIL` (subdomain sender). |
| `reply-processor.js` | Matches Gmail replies to `tempo_leads`, classifies, drafts responses to Gmail Drafts. Never auto-sends. |
| `dnc.js` + `do-not-contact.json` | Changepain people blocklist (they moonlight at other clinics). Hard gate in sender, sanitizer in finder, flag in reply-processor. Refresh names from changepain.ca/about-us/our-team/. |
| `enrich-list.js` + `seed-clinics.json` | Hand-fed clinic list fallback (used when Places was down). |

## Assets
- Landing page: **aevon.ca/tempo.html** (linked in the cold-email signature)
- Demos: **allied-scheduler-demo.web.app** (allied) · **clinic-scheduler-demo.web.app** (medical)
- CRM: aidancox8.github.io/aevon-agent/crm/**?campaign=tempo**

## Typical cycle
```
node tempo/lead-finder.js --region canada   # or bc
node tempo/hunt-emails.js --dry-run         # then without the flag
node tempo/personalizer.js
node tempo/sender.js                        # dry run; --send only after pricing is set
node tempo/reply-processor.js               # after sends begin
```

## Hard rules
Never contact Changepain, Artus, or anyone in do-not-contact.json. Never auto-send replies.
Quebec is excluded from the Canada sweep (Bill 96 French-language rules).
