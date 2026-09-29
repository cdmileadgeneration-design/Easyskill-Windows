<#
===============================================================================
  Easyskill Windows Monitoring Agent - one-shot deployer
===============================================================================

  Right-click  deploy.ps1  ->  Run with PowerShell (or run as Admin):
      powershell -ExecutionPolicy Bypass -File deploy.ps1

  What it does, in order:
    1. Elevates to Administrator (required for scheduled tasks).
    2. Installs Node.js if it is missing (portable copy, no Program Files,
       no MSI - so it works on a locked-down company image).
    3. Copies the agent to  %ProgramData%\EasyskillMonitor
    4. Writes config.json (server URL + shared agent key + machine name).
    5. Installs npm dependencies.
    6. Registers two SYSTEM scheduled tasks:
         Easyskill\AgentSupervisor  - starts at boot AND at every logon,
                                      restarts on failure every minute
         Easyskill\AgentKeeper      - fires every 60 s and restarts the
                                      supervisor if anything killed it
    7. Starts it and verifies that processes are alive + the log is flowing.

  The supervisor starts monitor.js *inside each logged-in user's desktop
  session* (not in Session 0), which is what makes window titles, idle time,
  screenshots and Chrome history actually reflect the employee.

  Other modes:
      powershell -ExecutionPolicy Bypass -File deploy.ps1 -Status
      powershell -ExecutionPolicy Bypass -File deploy.ps1 -Uninstall

  Unattended / mass deployment (no prompts):
      powershell -ExecutionPolicy Bypass -File deploy.ps1 -NonInteractive `
                  -ServerUrl "https://your-server.onrender.com" -AgentKey "XXXX"
===============================================================================
#>

[CmdletBinding()]
param(
    [string]$ServerUrl = '',
    [string]$AgentKey = '',
    [string]$InstallDir = '',
    [int]$ScreenshotIntervalSec = 300,
    [switch]$DisableScreenshots,
    [switch]$NonInteractive,
    [switch]$Status,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$TaskPath    = '\Easyskill\'
$SupTaskName = 'AgentSupervisor'
$KeepTaskName = 'AgentKeeper'
$SUPERVISOR_STARTUP_DELAY_SEC = 20

function Say($msg)  { Write-Host $msg }
function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "  [FAIL] $msg" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# elevation
# ---------------------------------------------------------------------------
function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Admin {
    if (Test-Admin) { return }
    Warn 'Administrator rights required - relaunching elevated...'
    $script = $MyInvocation.PSCommandPath
    if (-not $script) { $script = $PSCommandPath }
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$script`"")
    foreach ($a in $PSBoundParameters.GetEnumerator()) {
        if ($a.Value -is [switch]) {
            if ($a.Value) { $argList += "-$($a.Key)" }
        } else {
            $argList += "-$($a.Key)"; $argList += "`"$($a.Value)`""
        }
    }
    try {
        Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList -Wait
    } catch {
        Fail 'Could not elevate. Right-click the file and choose "Run as administrator".'
    }
    exit
}

# ---------------------------------------------------------------------------
# node.js
# ---------------------------------------------------------------------------
function Find-Node {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) {
        $v = & node -v 2>$null
        if ($v -match '^v(\d+)') { return @{ Path = $cmd.Source; Version = $v } }
    }
    foreach ($p in @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
    )) {
        if ($p -and (Test-Path $p)) {
            $v = & $p -v 2>$null
            return @{ Path = $p; Version = $v }
        }
    }
    return $null
}

function Install-NodePortable {
    param([string]$TargetDir)

    Step 'Node.js not found - installing a portable copy'
    $runtime = Join-Path $TargetDir 'runtime'
    $nodeDir = Join-Path $runtime 'node'

    $arch = 'x64'
    if ($env:PROCESSOR_ARCHITECTURE -match 'ARM64') { $arch = 'arm64' }

    $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json' -UseBasicParsing -TimeoutSec 60
    $rel = $index | Where-Object { $_.lts -and $_.lts -ne $false } | Select-Object -First 1
    if (-not $rel) { throw 'Could not determine the latest Node.js LTS release.' }
    $ver = $rel.version
    Say "  Node.js $ver (LTS) for $arch"

    $zip = Join-Path $runtime ("node-{0}-win-{1}.zip" -f $ver, $arch)
    if (-not (Test-Path $zip)) {
        New-Item -ItemType Directory -Force -Path $runtime | Out-Null
        $url = "https://nodejs.org/dist/$ver/node-$ver-win-$arch.zip"
        Say "  Downloading $url"
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 600
    }

    $tmp = Join-Path $runtime '_extract'
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force -ErrorAction SilentlyContinue }
    $src = Get-ChildItem $tmp -Directory | Select-Object -First 1
    Move-Item -Path $src.FullName -Destination $nodeDir
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

    $exe = Join-Path $nodeDir 'node.exe'
    if (-not (Test-Path $exe)) { throw 'Node.js extraction failed - node.exe missing.' }
    $v = & $exe -v
    Ok "Portable Node.js installed: $v"
    return $exe
}

# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------
function Read-Json($path) {
    try { return (Get-Content $path -Raw -ErrorAction Stop | ConvertFrom-Json) } catch { return $null }
}

function Write-AgentConfig {
    param([string]$Path, [string]$Server, [string]$Key, [int]$ShotInterval, [bool]$Shots)

    $cfg = [ordered]@{
        serverUrl            = $Server
        agentKey             = $Key
        machineName          = $env:COMPUTERNAME
        sendInterval         = 10000
        batchSize            = 50
        maxQueue             = 50000
        screenshotInterval   = ($ShotInterval * 1000)
        idleThreshold        = 300000
        enableScreenshots    = $Shots
        processPollInterval  = 300000
        networkPollInterval  = 300000
    }
    ($cfg | ConvertTo-Json) | Set-Content -Path $Path -Encoding UTF8

    # PowerShell 5.1's Set-Content -Encoding UTF8 writes a BOM, which breaks
    # JSON.parse in Node. Rewrite without one so the agentKey is actually read.
    try {
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes((Get-Content -LiteralPath $Path -Raw))
        [System.IO.File]::WriteAllBytes($Path, $bytes)
    } catch { Warn "Could not strip BOM from $Path - the agent will report a config error" }
}

# ---------------------------------------------------------------------------
# scheduled tasks
# ---------------------------------------------------------------------------
function Register-AgentTasks {
    param([string]$NodeExe, [string]$WorkDir)

    $actionSup  = New-ScheduledTaskAction -Execute $NodeExe -Argument "`"$WorkDir\supervisor.js`"" -WorkingDirectory $WorkDir
    $actionKeep = New-ScheduledTaskAction -Execute $NodeExe -Argument "`"$WorkDir\supervisor.js`" --once" -WorkingDirectory $WorkDir

    # Boot: start as soon as Windows comes up, before anyone logs on.
    $tBoot = New-ScheduledTaskTrigger -AtStartup
    $tBoot.Delay = "PT$SUPERVISOR_STARTUP_DELAY_SEC`S"
    # Logon: start again the moment a user logs in, so their session gets an agent.
    $tLogon = New-ScheduledTaskTrigger -AtLogOn
    $tLogon.Delay = 'PT10S'
    # Belt-and-braces: re-check every 15 min even if the trigger was missed.
    $tRep = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)

    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

    $settings = New-ScheduledTaskSettingsSet -Hidden `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew `
        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
        -DontStopOnIdleEnd

    Register-ScheduledTask -TaskName $SupTaskName -TaskPath $TaskPath `
        -Action $actionSup -Trigger @($tBoot, $tLogon, $tRep) `
        -Principal $principal -Settings $settings -Force | Out-Null
    Ok "Task registered: $TaskPath$SupTaskName  (boot + logon + every 15 min, restart on failure)"

    # The keeper is a short-lived one-shot that runs every minute forever.
    $tKeep = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(15) -RepetitionInterval (New-TimeSpan -Minutes 1)
    $keepSettings = New-ScheduledTaskSettingsSet -Hidden `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
        -MultipleInstances IgnoreNew `
        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)

    Register-ScheduledTask -TaskName $KeepTaskName -TaskPath $TaskPath `
        -Action $actionKeep -Trigger $tKeep `
        -Principal $principal -Settings $keepSettings -Force | Out-Null
    Ok "Task registered: $TaskPath$KeepTaskName  (every 1 min safety net)"
}

function Remove-AgentTasks {
    foreach ($t in @($SupTaskName, $KeepTaskName)) {
        try {
            Unregister-ScheduledTask -TaskName $t -TaskPath $TaskPath -Confirm:$false -ErrorAction Stop
            Ok "Task removed: $TaskPath$t"
        } catch {
            try {
                schtasks /Delete /TN "$TaskPath$t" /F 2>&1 | Out-Null
                Ok "Task removed: $TaskPath$t"
            } catch { }
        }
    }
    # legacy service from earlier installs
    foreach ($svc in @('EasyskillMonitor', 'Windows Employee Monitor')) {
        $existing = Get-Service -Name $svc -ErrorAction SilentlyContinue
        if ($existing) {
            try { Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue } catch { }
            & sc.exe delete "$svc" 2>&1 | Out-Null
            Ok "Legacy service removed: $svc"
        }
    }
}

# ---------------------------------------------------------------------------
# file copy
# ---------------------------------------------------------------------------
function Install-AgentFiles {
    param([string]$Src, [string]$Dst)

    New-Item -ItemType Directory -Force -Path $Dst | Out-Null

    $files = @('monitor.js', 'supervisor.js', 'lib.js', 'package.json')
    if (Test-Path (Join-Path $Src 'package-lock.json')) { $files += 'package-lock.json' }

    foreach ($f in $files) {
        $p = Join-Path $Src $f
        if (Test-Path $p) { Copy-Item $p $Dst -Force }
    }

    foreach ($d in @('monitors', 'scripts')) {
        $sp = Join-Path $Src $d
        if (Test-Path $sp) {
            $dp = Join-Path $Dst $d
            if (Test-Path $dp) { Remove-Item $dp -Recurse -Force -ErrorAction SilentlyContinue }
            Copy-Item $sp $dp -Recurse -Force
        }
    }

    # carry over a bundled node_modules so the target needs no npm/internet
    $srcNm = Join-Path $Src 'node_modules'
    if ((Test-Path $srcNm) -and -not (Test-Path (Join-Path $Dst 'node_modules'))) {
        Copy-Item $srcNm (Join-Path $Dst 'node_modules') -Recurse -Force
        Ok 'Reused bundled node_modules (offline install)'
    }
}

function Invoke-NpmInstall {
    param([string]$WorkDir, [string]$NodeExe)

    $nm = Join-Path $WorkDir 'node_modules'
    if ((Test-Path (Join-Path $nm 'chokidar')) -and (Test-Path (Join-Path $nm 'sql.js'))) {
        Ok 'Dependencies already present'
        return
    }

    Step 'Installing npm dependencies'
    $npm = Join-Path (Split-Path $NodeExe) 'npm.cmd'
    if (-not (Test-Path $npm)) { $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source }
    if (-not $npm) {
        Warn 'npm not found - agent will fail if node_modules is missing'
        return
    }

    Push-Location $WorkDir
    try {
        & $npm install --omit=dev --no-audit --no-fund --loglevel=error 2>&1 |
            ForEach-Object { "$_" } | Select-Object -Last 15 |
            ForEach-Object { Say "    $_" }
        if ($LASTEXITCODE -eq 0) {
            Ok 'Dependencies installed'
        } else {
            Warn "npm exited with code $LASTEXITCODE - check the output above"
        }
    } finally { Pop-Location }
}

# ---------------------------------------------------------------------------
# verification
# ---------------------------------------------------------------------------
function Get-AgentProcesses {
    $list = @()
    try {
        $list = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
            Where-Object { $_.CommandLine -and ($_.CommandLine -match 'monitor\.js|supervisor\.js') })
    } catch { }
    return $list
}

function Test-Deployment {
    param([string]$WorkDir)

    Step 'Verifying deployment'
    $procs = @(Get-AgentProcesses)
    if ($procs.Count -gt 0) {
        Ok "$($procs.Count) agent process(es) running"
        foreach ($p in $procs) {
            $kind = if ($p.CommandLine -match 'supervisor\.js') { 'supervisor' } else { 'agent    ' }
            Say "        $kind  pid=$($p.ProcessId)  session=$($p.SessionId)"
        }
    } else {
        Warn 'No agent process seen yet (may still be starting up)'
    }

    $log = Join-Path $WorkDir 'supervisor.log'
    if (Test-Path $log) {
        Ok 'supervisor.log:'
        Get-Content $log -Tail 6 -ErrorAction SilentlyContinue | ForEach-Object { Say "        $_" }
    }

    try {
        $health = Invoke-RestMethod -Uri "$ServerUrl/api/health" -TimeoutSec 15
        Ok "Dashboard reachable: $($health.status)"
    } catch {
        Warn "Dashboard not reachable from here: $($_.Exception.Message)"
        Say '        (the agent keeps retrying with backoff, so a temporary outage is fine)'
    }

    $agentLog = Get-ChildItem (Join-Path $WorkDir 'agent-*.log') -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($agentLog) {
        Ok "Latest agent log: $($agentLog.Name)"
        Get-Content $agentLog.FullName -Tail 4 -ErrorAction SilentlyContinue | ForEach-Object { Say "        $_" }
    }
}

function Show-Status {
    Step 'Deployment status'
    if (-not $InstallDir -or -not (Test-Path $InstallDir)) {
        Warn "Agent not installed ($InstallDir)"
        return
    }
    Say "  Install dir : $InstallDir"
    $cfg = Read-Json (Join-Path $InstallDir 'config.json')
    if ($cfg) {
        Say "  Server URL  : $($cfg.serverUrl)"
        Say "  Machine name: $($cfg.machineName)"
        Say "  Screenshots : $($cfg.enableScreenshots) every $($cfg.screenshotInterval / 1000)s"
    }
    foreach ($t in @($SupTaskName, $KeepTaskName)) {
        $task = Get-ScheduledTask -TaskName $t -TaskPath $TaskPath -ErrorAction SilentlyContinue
        if ($task) {
            $info = $task | Get-ScheduledTaskInfo
            $state = if ($task.State) { "$($task.State)" } else { 'Unknown' }
            Say "  Task $t : $state  (last run $($info.LastRunTime))"
        } else {
            Warn "Task $t not registered"
        }
    }
    $procs = @(Get-AgentProcesses)
    if ($procs.Count) {
        Ok "$($procs.Count) agent process(es) running"
    } else {
        Warn 'No agent process running'
    }
    $log = Join-Path $InstallDir 'supervisor.log'
    if (Test-Path $log) {
        Say '  --- last supervisor lines ---'
        Get-Content $log -Tail 8 -ErrorAction SilentlyContinue | ForEach-Object { Say "    $_" }
    }
}

# ===========================================================================
# main
# ===========================================================================

if (-not $InstallDir) { $InstallDir = Join-Path $env:ProgramData 'EasyskillMonitor' }
$SourceDir = Split-Path -Parent $PSCommandPath
$SrcConfig = Join-Path $SourceDir 'config.json'

if ($Uninstall) {
    Assert-Admin
    Step 'Uninstalling monitoring agent'
    try { Stop-ScheduledTask -TaskName $SupTaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue } catch { }
    try { Stop-ScheduledTask -TaskName $KeepTaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue } catch { }
    Get-AgentProcesses | ForEach-Object {
        try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch { }
    }
    Start-Sleep -Seconds 2
    Remove-AgentTasks
    Remove-Item (Join-Path $env:APPDATA 'Microsoft\Windows\Startup\SysMonAgent.vbs') -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Startup\SysMonAgent.vbs') -Force -ErrorAction SilentlyContinue
    Remove-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
    Remove-Item 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run' -Force -ErrorAction SilentlyContinue
    if (Test-Path $InstallDir) {
        Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path $InstallDir) { Warn "Could not fully remove $InstallDir" }
        else { Ok "Removed $InstallDir" }
    }
    Say ''
    Say 'Agent uninstalled. No further data is collected from this machine.'
    exit 0
}

if ($Status) {
    Show-Status
    exit 0
}

Assert-Admin

Say '========================================================'
Say '  Easyskill Windows Monitoring Agent - Deploy'
Say '========================================================'
Say ''

# --- 1. node ----------------------------------------------------------------
Step 'Checking Node.js'
$node = Find-Node
$nodeExe = $null
if ($node) {
    $nodeExe = $node.Path
    Ok "Found $($node.Version) -> $nodeExe"
} else {
    $nodeExe = Install-NodePortable -TargetDir $InstallDir
}

# --- 2. config inputs -------------------------------------------------------
if (-not $ServerUrl -or -not $AgentKey) {
    $srcCfg = Read-Json $SrcConfig
    $dstCfg = Read-Json (Join-Path $InstallDir 'config.json')
    if (-not $ServerUrl) {
        $ServerUrl = if ($dstCfg -and $dstCfg.serverUrl) { $dstCfg.serverUrl }
                     elseif ($srcCfg -and $srcCfg.serverUrl) { $srcCfg.serverUrl }
                     else { 'https://easyskill-windows.onrender.com' }
    }
    if (-not $AgentKey) {
        $AgentKey = if ($dstCfg -and $dstCfg.agentKey) { $dstCfg.agentKey }
                    elseif ($srcCfg -and $srcCfg.agentKey) { $srcCfg.agentKey }
                    else { '' }
    }

    if (-not $NonInteractive) {
        Say ''
        Say 'Press Enter to accept the value shown in [brackets].'
        $i = Read-Host " Dashboard server URL [$ServerUrl]"
        if ($i) { $ServerUrl = $i }
        $k = Read-Host " Agent key [$AgentKey]"
        if ($k) { $AgentKey = $k }
        Say ''
    }
}
if (-not $AgentKey) {
    Fail 'No agent key provided. Pass -AgentKey "..." or edit agent\config.json first.'
    exit 1
}

# --- 3. files ---------------------------------------------------------------
Step "Installing agent to $InstallDir"
Install-AgentFiles -Src $SourceDir -Dst $InstallDir
Ok 'Agent files copied'

# --- 4. config --------------------------------------------------------------
Step 'Writing configuration'
$shots = -not $DisableScreenshots
Write-AgentConfig -Path (Join-Path $InstallDir 'config.json') `
    -Server $ServerUrl -Key $AgentKey -ShotInterval $ScreenshotIntervalSec -Shots $shots
Ok "Server:  $ServerUrl"
Ok "Machine: $env:COMPUTERNAME"
Ok "Screenshots: $(if ($shots) { "every ${ScreenshotIntervalSec}s" } else { 'disabled' })"

# --- 5. dependencies --------------------------------------------------------
Invoke-NpmInstall -WorkDir $InstallDir -NodeExe $nodeExe

# --- 6. tasks ---------------------------------------------------------------
Step 'Registering startup + watchdog tasks'
Register-AgentTasks -NodeExe $nodeExe -WorkDir $InstallDir

# --- 7. start ---------------------------------------------------------------
Step 'Starting agent'
try {
    Stop-ScheduledTask -TaskName $SupTaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
} catch { }
try {
    Start-ScheduledTask -TaskName $SupTaskName -TaskPath $TaskPath -ErrorAction Stop
    Ok 'Supervisor task started'
} catch {
    Warn "Start-ScheduledTask failed: $($_.Exception.Message) - falling back to direct launch"
    Start-Process -FilePath $nodeExe -ArgumentList "`"$InstallDir\supervisor.js`"" `
        -WorkingDirectory $InstallDir -WindowStyle Hidden
}

Say '  Waiting a few seconds for the supervisor to reconcile sessions...'
Start-Sleep -Seconds 6

Test-Deployment -WorkDir $InstallDir

Say ''
Say '========================================================'
Say '  DEPLOYMENT COMPLETE'
Say '========================================================'
Say "  Agent folder : $InstallDir"
Say "  Dashboard    : $ServerUrl"
Say "  Machine name : $env:COMPUTERNAME"
Say ''
Say '  Behaviour:'
Say '   - runs at PC startup (before logon) and at every user logon'
Say '   - hidden background process, no visible window'
Say '   - restarts within 1 minute if it is killed or crashes'
Say '   - streams activity to the dashboard every 10 s'
Say '   - buffers offline - events queue to disk until the server is back'
Say ''
Say '  Check anytime:   powershell -ExecutionPolicy Bypass -File deploy.ps1 -Status'
Say '  Remove anytime:  powershell -ExecutionPolicy Bypass -File deploy.ps1 -Uninstall'
Say '========================================================'
exit 0
