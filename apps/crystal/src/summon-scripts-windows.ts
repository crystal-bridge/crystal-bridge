import { FINISHED_LINE, FOLLOW_LINE, QUEUED_LINE, TURN_LINE, type TargetScripts } from './summon-scripts.js';

/**
 * The same job on a Windows target, in the PowerShell that comes with Windows: the same folder and the same lines as
 * the `sh` wrapper, under `%USERPROFILE%`. What differs, each found on a real machine:
 *
 * - A process started over SSH lives in the session's job object and dies with it, so the runner leaves that job with
 *   `CREATE_BREAKAWAY_FROM_JOB`. A scheduled task would survive too, but needs someone signed in.
 * - There are no process groups, and `taskkill` and WMI are refused over SSH, so the runner puts the command in a job
 *   object of its own and ends it when a `cancel` file appears.
 * - Windows has no `tail`, so a follow reads the log itself. That runs on the target and costs no model turns.
 * - A follow hears nothing when its connection ends: over SSH on Windows, neither stdin closing nor the client dying
 *   reaches it, and an idle log gives it nothing to fail on writing. So it ends itself on a timer and the Kingdom
 *   reconnects from its offset, which keeps a dead connection's follow from lasting.
 */

/** How long one follow runs. */
export const FOLLOW_SECONDS = 300;

/** Where a script ends on stdin, which stays open for a follow, as on the `sh` side. */
const SCRIPT_END = '#CRYSTAL-SUMMON-END';

const BOOTSTRAP = [
  `$ProgressPreference='SilentlyContinue';$u=New-Object Text.UTF8Encoding($false);[Console]::InputEncoding=$u;[Console]::OutputEncoding=$u;$s='';`,
  `while($true){$l=[Console]::In.ReadLine();if($null -eq $l -or $l -eq '${SCRIPT_END}'){break};$s+=$l+[char]10};`,
  `Invoke-Expression $s`,
].join('');

/** The command that runs a script from stdin. Encoded, so it comes through cmd.exe, the default shell there, intact. */
export const WINDOWS_COMMAND = [
  'powershell',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-EncodedCommand',
  Buffer.from(BOOTSTRAP, 'utf16le').toString('base64'),
].join(' ');

const COMMON = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object Text.UTF8Encoding($false)
$root = Join-Path $env:USERPROFILE '.crystal-bridge\summons'
function Start-Time($id) {
  try { (Get-Process -Id $id -ErrorAction Stop).StartTime.ToFileTimeUtc().ToString() } catch { '' }
}
function Add-Line($text) { [IO.File]::AppendAllText("$dir\log", $text + [char]10, $utf8) }
function Write-Exit($code) {
  [IO.File]::WriteAllText("$dir\exit.tmp", "$code", $utf8)
  [IO.File]::Move("$dir\exit.tmp", "$dir\exit")
  Add-Line ([string][char]10 + '${FINISHED_LINE}')
}
`;

const NATIVE = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;

public static class CrystalCast {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct StartupInfo {
    public int cb; public string reserved, desktop, title;
    public int x, y, xSize, ySize, xChars, yChars, fill, flags;
    public short show, reserved2; public IntPtr reserved3, stdIn, stdOut, stdErr;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInfo { public IntPtr process, thread; public int id, threadId; }
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits {
    public long perProcessTime, perJobTime; public uint flags;
    public UIntPtr minSet, maxSet; public uint processes; public UIntPtr affinity; public uint priority, schedule;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Counters { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits {
    public BasicLimits basic; public Counters io;
    public UIntPtr processMemory, jobMemory, peakProcess, peakJob;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string app, string command, IntPtr pa, IntPtr ta, bool inherit, uint flags,
    IntPtr env, string cwd, ref StartupInfo si, out ProcessInfo pi);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateDirectoryW(string path, IntPtr security);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObjectW(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, int size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);

  const uint NoWindow = 0x08000000, Suspended = 0x4, Breakaway = 0x01000000, NewGroup = 0x200;
  const uint Timeout = 258, KillOnClose = 0x2000;

  static ProcessInfo Spawn(string command, string cwd, uint flags) {
    StartupInfo si = new StartupInfo(); si.cb = Marshal.SizeOf(si);
    ProcessInfo pi;
    if (!CreateProcessW(null, command, IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, cwd, ref si, out pi))
      throw new System.ComponentModel.Win32Exception();
    return pi;
  }

  // Out of the SSH session's job, which ends everything in it when the session closes. A job that forbids leaving is
  // no SSH session's, as under a CI runner, so there it just starts.
  public static int Detach(string command, string cwd) {
    try { return Spawn(command, cwd, NoWindow | NewGroup | Breakaway).id; }
    catch (System.ComponentModel.Win32Exception e) {
      if (e.NativeErrorCode != 5) throw;
      return Spawn(command, cwd, NoWindow | NewGroup).id;
    }
  }

  // Atomic, unlike Directory.CreateDirectory, which succeeds when the folder is there already.
  public static bool Claim(string path) { return CreateDirectoryW(path, IntPtr.Zero); }

  // Runs the command in a job of its own, which ends with the runner, and stops it all if the cancel file appears.
  public static int Run(string command, string cwd, string cancelFile) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    ExtendedLimits limits = new ExtendedLimits();
    limits.basic.flags = KillOnClose;
    if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits)))
      throw new System.ComponentModel.Win32Exception();
    ProcessInfo pi = Spawn(command, cwd, NoWindow | Suspended);
    if (!AssignProcessToJobObject(job, pi.process)) throw new System.ComponentModel.Win32Exception();
    ResumeThread(pi.thread);
    while (WaitForSingleObject(pi.process, 500) == Timeout) {
      if (File.Exists(cancelFile)) TerminateJobObject(job, 143);
    }
    uint code; GetExitCodeProcess(pi.process, out code);
    return unchecked((int)code);
  }
}
'@
`;

const PS = '"$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"';
const PS_ARGS = '-NoProfile -NonInteractive -ExecutionPolicy Bypass';

/** The job's process: it writes `pid` first so a start can return, takes a turn, runs the command, records the end. */
const RUNNER = String.raw`param($dir)
${COMMON}
$id = $PID
[IO.File]::WriteAllText("$dir\pid.tmp", "$id $id $(Start-Time $id)", $utf8)
[IO.File]::Move("$dir\pid.tmp", "$dir\pid")
${NATIVE}
function Take-Turn {
  $slots = "$root\.slots"
  [void][IO.Directory]::CreateDirectory($slots)
  $limit = [int][IO.File]::ReadAllText("$dir\limit")
  $waiting = $false
  while ($true) {
    if (Test-Path "$dir\cancel") { return $null }
    for ($n = 1; $n -le $limit; $n++) {
      $slot = "$slots\$n"
      if ([CrystalCast]::Claim($slot)) {
        [IO.File]::WriteAllText("$slot\owner", "$PID $(Start-Time $PID)", $utf8)
        if ($waiting) { Add-Line '${TURN_LINE}' }
        return $slot
      }
      if (Test-Path "$slot\owner") {
        $owner = ([IO.File]::ReadAllText("$slot\owner")) -split ' '
        if ((Start-Time $owner[0]) -ne $owner[1]) {
          Remove-Item $slot -Recurse -Force -ErrorAction SilentlyContinue
          $n--
        }
      }
    }
    if (-not $waiting) { $waiting = $true; Add-Line '${QUEUED_LINE}' }
    Start-Sleep -Seconds 2
  }
}
$slot = Take-Turn
if ($null -eq $slot) { Write-Exit 143; exit 0 }
$cwd = $env:USERPROFILE
if (Test-Path "$dir\cwd") { $cwd = [IO.File]::ReadAllText("$dir\cwd") }
try {
  if (-not (Test-Path -LiteralPath $cwd -PathType Container)) { throw "no such folder: $cwd" }
  $line = 'cmd.exe /d /c ""' + ${PS} + '" ${PS_ARGS} -File "' + "$dir\command.ps1" + '" < NUL >> "' + "$dir\log" + '" 2>&1"'
  $code = [CrystalCast]::Run($line, $cwd, "$dir\cancel")
} catch {
  Add-Line "$_"
  $code = 127
}
Remove-Item $slot -Recurse -Force -ErrorAction SilentlyContinue
Write-Exit $code
`;

/** Around the user's command: UTF-8 in the log, and a native tool's exit code as the script's own. */
function commandFile(command: string): string {
  return [
    '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)',
    command,
    'if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }',
    '',
  ].join('\r\n');
}

function folder(id: string): string {
  return `${COMMON}\n$dir = Join-Path $root '${id}'\n`;
}

/** A file's text as a script line, in base64, so nothing in it needs quoting. A BOM tells PowerShell it's UTF-8. */
function writeFile(name: string, text: string, bom = false): string {
  const data = Buffer.concat([Buffer.from(bom ? [0xef, 0xbb, 0xbf] : []), Buffer.from(text, 'utf8')]);
  return `[IO.File]::WriteAllBytes("$dir\\${name}", [Convert]::FromBase64String('${data.toString('base64')}'))\n`;
}

/** A script on stdin, with its end marked. */
export function windowsEnvelope(script: string): string {
  return `${script}\n${SCRIPT_END}\n`;
}

export const windowsScripts: TargetScripts = {
  start(id, command, cwd, limit = 1) {
    return `${folder(id)}
[void][IO.Directory]::CreateDirectory($dir)
${writeFile('command', `${command}\n`)}${writeFile('command.ps1', commandFile(command), true)}${
      cwd === undefined ? '' : writeFile('cwd', cwd)
    }${writeFile('limit', String(limit))}${writeFile('runner.ps1', RUNNER, true)}[IO.File]::WriteAllText("$dir\\log", '', $utf8)
${NATIVE}
[void][CrystalCast]::Detach(${PS.replace('"$env', '"""$env').replace('.exe"', '.exe"""')} + " ${PS_ARGS} -File """"$dir\\runner.ps1"""" """"$dir""""", $dir)
$tries = 0
while (-not (Test-Path "$dir\\pid") -and $tries -lt 150) { Start-Sleep -Milliseconds 200; $tries++ }
if (-not (Test-Path "$dir\\pid")) { exit 71 }
[Console]::Out.WriteLine('started')
`;
  },

  follow(id, offset) {
    return `${folder(id)}
$out = [Console]::OpenStandardOutput()
$line = [Text.Encoding]::UTF8.GetBytes('${FOLLOW_LINE}' + [char]10)
$out.Write($line, 0, $line.Length)
$out.Flush()
$log = New-Object IO.FileStream("$dir\\log", 'Open', 'Read', 'ReadWrite, Delete')
[void]$log.Seek(${offset}, 'Begin')
$buffer = New-Object byte[] 65536
$until = (Get-Date).AddSeconds(${FOLLOW_SECONDS})
while ((Get-Date) -lt $until) {
  $read = $log.Read($buffer, 0, $buffer.Length)
  if ($read -gt 0) { $out.Write($buffer, 0, $read); $out.Flush() } else { Start-Sleep -Milliseconds 300 }
}
`;
  },

  probe(id) {
    return `${folder(id)}
if (-not (Test-Path $dir)) { [Console]::Out.WriteLine('gone'); exit 0 }
$state = 'dead'
if (Test-Path "$dir\\pid") {
  $job = ([IO.File]::ReadAllText("$dir\\pid")) -split ' '
  if ((Start-Time $job[0]) -eq $job[2]) { $state = 'alive' }
}
# After the process check: a job ending between the two must read as ended, never as dead.
if (Test-Path "$dir\\exit") {
  $state = 'exit ' + ([IO.File]::ReadAllText("$dir\\exit")).Trim()
  if (Test-Path "$dir\\cancel") { $state += ' cancelled' }
}
[Console]::Out.WriteLine($state)
`;
  },

  cancel(id) {
    return `${folder(id)}
if (-not (Test-Path $dir) -or (Test-Path "$dir\\exit")) { exit 0 }
[IO.File]::WriteAllText("$dir\\cancel", '', $utf8)
if (-not (Test-Path "$dir\\pid")) { exit 0 }
$job = ([IO.File]::ReadAllText("$dir\\pid")) -split ' '
if ((Start-Time $job[0]) -ne $job[2]) { exit 0 }
$tries = 0
while (-not (Test-Path "$dir\\exit") -and $tries -lt 30) { Start-Sleep -Milliseconds 500; $tries++ }
if (-not (Test-Path "$dir\\exit")) {
  Stop-Process -Id $job[0] -Force -ErrorAction SilentlyContinue
  Write-Exit 137
}
`;
  },

  clean(id) {
    return `${folder(id)}
Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
`;
  },
};
