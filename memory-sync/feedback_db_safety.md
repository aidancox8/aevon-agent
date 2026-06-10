---
name: feedback_db_safety
description: Always snapshot the leads table before any bulk DELETE/UPDATE; user approves prompts without reading
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f3c995de-be61-4625-860f-2dce2c309366
---

Before running ANY destructive DB operation on Aevon's Supabase (bulk DELETE, bulk UPDATE, DROP), first take a same-session snapshot: `CREATE TABLE IF NOT EXISTS leads_backup_<YYYYMMDD> AS TABLE leads;` (or the relevant table). Verify row count matches live before proceeding.

**Why:** The user admits they approve permission prompts without reading them ("half the time I approve without looking"). The permission gate is therefore NOT a reliable safety net. I have also made data-corrupting mistakes (the .co TLD truncation that corrupted ~12 emails, a regex near-miss that would have nulled valid emails). The durable protection is a backup, not the prompt.

**How to apply:** Snapshot first, then run the destructive op. Keep `execute_sql` and `send-email` permission-gated (do NOT allowlist them) even though file edits are on accept-edits mode. Baseline backup `leads_backup_20260604` (4,521 rows) exists as of 2026-05-30. Related: [[project_aevon]] [[reference_supabase]].
