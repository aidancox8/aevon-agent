# Overnight runner: wait for both lead finders to exit, then run the
# personalizer and follow-up regen sequentially (they share the Gemini quota,
# so never run them alongside the finders).

$ErrorActionPreference = 'Continue'
Set-Location 'C:\Users\Aidan\projects\aevon\agent'

function FindersRunning {
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'lead-finder\.js|agent-lead-finder\.js' }
  return ($procs | Measure-Object).Count -gt 0
}

"[$(Get-Date -Format HH:mm)] waiting for finders to finish..." | Tee-Object -FilePath overnight.log -Append
while (FindersRunning) { Start-Sleep -Seconds 60 }
"[$(Get-Date -Format HH:mm)] finders done. Running personalizer." | Tee-Object -FilePath overnight.log -Append

node personalizer.js *>> overnight.log
"[$(Get-Date -Format HH:mm)] personalizer exit $LASTEXITCODE. Running regen-followups." | Tee-Object -FilePath overnight.log -Append

node regen-followups.js *>> overnight.log
"[$(Get-Date -Format HH:mm)] regen-followups exit $LASTEXITCODE. Scheduling top 30 for Monday." | Tee-Object -FilePath overnight.log -Append

# Ensure ~30 go out Monday: pull the highest-score freshly-personalized leads
# forward to Monday 9am PT (16:00 UTC). The sender's daily cap (30) handles the
# rest. Idempotent and safe to run after personalizer.
node schedule-monday.js *>> overnight.log
"[$(Get-Date -Format HH:mm)] schedule-monday exit $LASTEXITCODE. All done." | Tee-Object -FilePath overnight.log -Append
