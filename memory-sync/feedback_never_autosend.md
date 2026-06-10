---
name: feedback_never_autosend
description: Never auto-send reply emails to Aevon leads; always draft for human approval first
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f3c995de-be61-4625-860f-2dce2c309366
---

Never send a reply/response email to an Aevon lead or prospect automatically. Always leave it as a Gmail Draft (or equivalent) for the user to read, edit, and send himself. This applies to every agent, routine, script, and session.

**Why:** The user is explicit: "I still never want response emails sent before I approve or edit it myself." He wants final control over anything a prospect sees.

**How to apply:** Reply-drafting automation (reply-processor, the cloud "Aevon morning replies briefing" routine trig_016e43ep7bHUmvTArah9C2fc, any future agent) must DRAFT only, never send to the lead. The ONLY auto-send allowed is internal self-notification (e.g. the briefing email aidan@aevon.ca -> aidan@aevon.ca). Cold/initial outreach via the sender pipeline is separately approved; this rule is about replies/responses to people who wrote back. Related: [[project_aevon]] [[feedback_be_a_driver]].
