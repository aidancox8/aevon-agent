---
name: feedback-remember-context
description: User expects established facts to be remembered and not re-asked or re-verified mid-conversation
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f3c995de-be61-4625-860f-2dce2c309366
---

Do not re-ask or re-verify facts the user has already stated. If the user says something works (e.g. "I can receive email at X"), treat that as settled and move on. Do not ask the user to leave the terminal unless absolutely necessary — find a way to do it programmatically.

**Why:** User explicitly called this out — re-asking wastes time, and sending them to a UI when the terminal works is unnecessary friction.

**How to apply:** Before asking a clarifying question, check whether it was already answered earlier in the conversation or in memory. For config/setup tasks, look for config files I can edit directly rather than directing the user to a UI.
