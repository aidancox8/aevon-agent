# Runs a scanner while asking Windows not to sleep (process-scoped, ends with the process).
param([string]$Script, [string]$Args = "")
Add-Type -Name Awake -Namespace Win32 -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
[Win32.Awake]::SetThreadExecutionState(0x80000001) | Out-Null   # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
Set-Location "C:\Users\Aidan\projects\aevon\agent"
$log = "cadre/state/$($Script -replace '\.js$','').log"
& node $Script $Args.Split(' ') 2>&1 | Out-File -Encoding utf8 -Append $log
[Win32.Awake]::SetThreadExecutionState(0x80000000) | Out-Null
