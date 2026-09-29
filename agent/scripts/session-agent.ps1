<#
  session-agent.ps1 - helper run by supervisor.js

  Actions:
    -Action Enumerate -NodeExe C:\...\node.exe | C:\...\agent.exe
        -> JSON: { selfSessionId, sessions:[{sessionId,user,domain,state}],
                   agents:[{pid,sessionId,commandLine}] }

    -Action Launch -SessionId 3 -NodeExe C:\...\node.exe
                  -Arguments "...monitor.js --user jane --profile C:\Users\jane"
                             (bundled build: -Arguments "--monitor --user ...")
                  -WorkingDirectory C:\ProgramData\EasyskillMonitor
        -> starts the process INSIDE that session's desktop (WinSta0\Default)
           using the logged-on user's own token, so foreground-window polling,
           idle time, screenshots and Chrome history all work.
        -> JSON: { pid, sessionId, user }

  Requires Administrator (WTSQueryUserToken needs SeTcbPrivilege).
#>
param(
  [ValidateSet('Enumerate', 'Launch')]
  [string]$Action = 'Enumerate',

  [int]$SessionId = 0,
  [string]$NodeExe = '',
  [string]$Arguments = '',
  [string]$WorkingDirectory = '',
  [string]$Desktop = 'winsta0\default'
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class SessionAgent
{
    private const int WTSActive = 0;
    private const int WTSConnected = 1;
    private const int WTSDisconnected = 4;
    private const int WTSUserName = 5;
    private const int WTSDomain = 7;

    private const uint TOKEN_ALL_ACCESS = 0x000F01FF;
    private const int TokenPrimary = 1;
    private const int SecurityImpersonation = 2;

    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
    private const int STARTF_USESHOWWINDOW = 0x00000001;
    private const short SW_HIDE = 0;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WTS_SESSION_INFO
    {
        public int SessionId;
        public IntPtr WinStationName;
        public int State;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSEnumerateSessions(IntPtr hServer, int reserved, int version,
        out IntPtr ppSessionInfo, out int pCount);

    [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool WTSQuerySessionInformation(IntPtr hServer, int sessionId, int infoClass,
        out IntPtr ppBuffer, out int pBytesReturned);

    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSQueryUserToken(int sessionId, out IntPtr phToken);

    [DllImport("wtsapi32.dll")]
    private static extern void WTSFreeMemory(IntPtr pMemory);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool DuplicateTokenEx(IntPtr hExistingToken, uint dwDesiredAccess,
        IntPtr lpTokenAttributes, int impersonationLevel, int tokenType, out IntPtr phNewToken);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessAsUserW(IntPtr hToken, string lpApplicationName,
        System.Text.StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
        bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr hObject);

    public class SessionEntry
    {
        public int SessionId;
        public string User;
        public string Domain;
        public int State;
        public bool Interactive;
    }

    public static List<SessionEntry> ListSessions()
    {
        var result = new List<SessionEntry>();
        IntPtr buffer;
        int count;
        if (!WTSEnumerateSessions(IntPtr.Zero, 0, 1, out buffer, out count))
            return result;

        int size = Marshal.SizeOf(typeof(WTS_SESSION_INFO));
        for (int i = 0; i < count; i++)
        {
            IntPtr p = IntPtr.Add(buffer, i * size);
            var info = (WTS_SESSION_INFO)Marshal.PtrToStructure(p, typeof(WTS_SESSION_INFO));
            if (info.State != WTSActive && info.State != WTSConnected && info.State != WTSDisconnected)
                continue;

            string user = Query(info.SessionId, WTSUserName);
            if (string.IsNullOrEmpty(user)) continue;
            if (user.Equals("SYSTEM", StringComparison.OrdinalIgnoreCase)) continue;

            result.Add(new SessionEntry
            {
                SessionId = info.SessionId,
                User = user,
                Domain = Query(info.SessionId, WTSDomain) ?? "",
                State = info.State,
                Interactive = info.State == WTSActive
            });
        }
        WTSFreeMemory(buffer);
        return result;
    }

    private static string Query(int sessionId, int infoClass)
    {
        IntPtr buf;
        int bytes;
        if (!WTSQuerySessionInformation(IntPtr.Zero, sessionId, infoClass, out buf, out bytes))
            return null;
        try
        {
            return Marshal.PtrToStringUni(buf);
        }
        finally
        {
            WTSFreeMemory(buf);
        }
    }

    // Launch lpCommandLine in the desktop of sessionId using that user's token.
    public static int Launch(int sessionId, string exe, string args, string cwd, string desktop)
    {
        IntPtr token;
        if (!WTSQueryUserToken(sessionId, out token))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "WTSQueryUserToken");

        IntPtr primary;
        if (!DuplicateTokenEx(token, TOKEN_ALL_ACCESS, IntPtr.Zero,
                SecurityImpersonation, TokenPrimary, out primary))
        {
            int err = Marshal.GetLastWin32Error();
            CloseHandle(token);
            throw new Win32Exception(err, "DuplicateTokenEx");
        }
        CloseHandle(token);

        var si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.lpDesktop = desktop;
        // Never show a console on the employee's desktop. STARTF_USESHOWWINDOW
        // + SW_HIDE is honoured even if the creation flags are ignored.
        si.dwFlags = STARTF_USESHOWWINDOW;
        si.wShowWindow = SW_HIDE;

        var cmd = new System.Text.StringBuilder();
        cmd.Append('"').Append(exe).Append('"');
        if (!string.IsNullOrEmpty(args)) cmd.Append(' ').Append(args);

        // CREATE_NEW_CONSOLE and CREATE_NO_WINDOW are mutually exclusive: when
        // both are passed Windows creates a VISIBLE console. Only
        // CREATE_NO_WINDOW may be used here.
        uint flags = CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW;
        PROCESS_INFORMATION pi;

        // Service tasks are often hosted in a job object; break away when allowed.
        bool ok = CreateProcessAsUserW(primary, exe, cmd, IntPtr.Zero, IntPtr.Zero, false,
            flags | CREATE_BREAKAWAY_FROM_JOB, IntPtr.Zero, cwd, ref si, out pi);
        if (!ok && Marshal.GetLastWin32Error() == 5)
            ok = CreateProcessAsUserW(primary, exe, cmd, IntPtr.Zero, IntPtr.Zero, false,
                flags, IntPtr.Zero, cwd, ref si, out pi);

        int err2 = Marshal.GetLastWin32Error();
        CloseHandle(primary);

        if (!ok) throw new Win32Exception(err2, "CreateProcessAsUser");

        CloseHandle(pi.hThread);
        int pid = pi.dwProcessId;
        CloseHandle(pi.hProcess);
        return pid;
    }
}
'@

try {
    if ($Action -eq 'Enumerate') {
        $sessions = [SessionAgent]::ListSessions() | ForEach-Object {
            [pscustomobject]@{
                sessionId   = $_.SessionId
                user        = $_.User
                domain      = $_.Domain
                state       = $_.State
                interactive = $_.Interactive
            }
        }

        $selfPid = $PID
        $self = Get-CimInstance Win32_Process -Filter "ProcessId = $selfPid" -ErrorAction SilentlyContinue
        $selfSession = 0
        if ($self) { $selfSession = $self.SessionId }

        # processes running either the agent or the supervisor: the supervisor
        # passes its own executable (node.exe, or the bundled single-file exe)
        # so the filter stays correct in both build modes.
        $exeName = if ($NodeExe) { [System.IO.Path]::GetFileName($NodeExe) } else { 'node.exe' }
        $agents = @()
        try {
            $agents = @(Get-CimInstance Win32_Process -Filter "Name = '$exeName'" |
                Where-Object { $_.CommandLine -and ($_.CommandLine -match 'monitor\.js|supervisor\.js|--monitor\b|--supervisor\b') } |
                ForEach-Object {
                    [pscustomobject]@{
                        pid         = $_.ProcessId
                        sessionId   = $_.SessionId
                        commandLine = $_.CommandLine
                    }
                })
        } catch { }

        [pscustomobject]@{
            selfSessionId = $selfSession
            sessions      = @($sessions)
            agents        = @($agents)
        } | ConvertTo-Json -Depth 5 -Compress
    }
    else {
        $pid_ = [SessionAgent]::Launch($SessionId, $NodeExe, $Arguments, $WorkingDirectory, $Desktop)

        $user = ''
        $entry = [SessionAgent]::ListSessions() | Where-Object { $_.SessionId -eq $SessionId } | Select-Object -First 1
        if ($entry) { $user = $entry.User }

        [pscustomobject]@{
            pid       = $pid_
            sessionId = $SessionId
            user      = $user
        } | ConvertTo-Json -Compress
    }
}
catch {
    $code = -1
    if ($_.Exception -is [System.ComponentModel.Win32Exception]) {
        $code = $_.Exception.NativeErrorCode
    }
    [pscustomobject]@{
        error = $_.Exception.Message
        code  = $code
    } | ConvertTo-Json -Compress
    exit 1
}
