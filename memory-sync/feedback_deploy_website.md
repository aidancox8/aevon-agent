---
name: Always deploy Aevon website after changes
description: After any edit to the Aevon website files, commit and push to GitHub immediately
type: feedback
originSessionId: f3c995de-be61-4625-860f-2dce2c309366
---
Always commit and push to GitHub after making any changes to Aevon files. Do not wait to be asked.

**Why:** User explicitly requested this workflow so the live site stays in sync. The CRM is also served via GitHub Pages, not locally.

**How to apply:**
- Aevon website: edits to `C:\Users\Aidan\projects\aevon\website\` → push to `aidancox8/aevon-website`
- Aevon CRM/agent: edits to `C:\Users\Aidan\projects\aevon\agent\` → push to `aidancox8/aevon-agent`. CRM is live at `https://aidancox8.github.io/aevon-agent/crm/`
- Both deploy via GitHub Pages automatically on push.
