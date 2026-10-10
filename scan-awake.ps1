# Runs a node script while asking Windows not to sleep (process-scoped, ends with the process).
# $ScriptArgs, not $Args: $Args is a PowerShell automatic variable, and naming a parameter that
# silently dropped every argument (a --send never arrived, 2026-10-10).
param([string]$Script, [string]$ScriptArgs = "")
Add-Type -Name Awake -Namespace Win32 -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
[Win32.Awake]::SetThreadExecutionState(0x80000001) | Out-Null   # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
Set-Location "C:\Users\Aidan\projects\aevon\agent"
$log = "cadre/state/$($Script -replace '\.js$','').log"
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
$argList = @($Script) + @($ScriptArgs.Split(' ', [System.StringSplitOptions]::RemoveEmptyEntries))
& node @argList 2>&1 | Out-File -Encoding utf8 -Append $log
[Win32.Awake]::SetThreadExecutionState(0x80000000) | Out-Null
