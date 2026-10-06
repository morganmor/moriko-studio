import { spawn } from 'node:child_process';

/**
 * NATIVE folder picker — the DEVICE'S OWN dialog, always in FRONT and
 * comfortably sized.
 *
 * Primary path (pwsh 7 / .NET 8+): Microsoft.Win32.OpenFolderDialog — the
 * modern Vista-style folder dialog: large, user-resizable (Windows remembers
 * the size), with search and the Explorer left pane. An invisible TOPMOST
 * host window owns the dialog, so it can never open behind other windows.
 *
 * Fallback (powershell.exe 5.1, when pwsh is unavailable or too old): the
 * classic FolderBrowserDialog, also owned by an invisible TopMost form.
 *
 * Resolves the absolute path, or null when the user cancels. The dialog
 * belongs to the server process (the local proxy on the user's machine), so
 * the selected path is directly usable as an agent workspace. A 5-minute cap
 * only guards against a zombie dialog.
 */

const MODERN_EXIT_UNAVAILABLE = 3;

function modernScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  Add-Type -AssemblyName PresentationFramework',
    '  $owner = New-Object System.Windows.Window',
    '  $owner.Width = 0; $owner.Height = 0',
    "  $owner.WindowStyle = 'None'",
    '  $owner.ShowInTaskbar = $false',
    '  $owner.ShowActivated = $false',
    '  $owner.Opacity = 0',
    '  $owner.Left = -32000; $owner.Top = -32000',
    '  $owner.Topmost = $true',
    '  $owner.Show()',
    '  $dialog = New-Object Microsoft.Win32.OpenFolderDialog',
    "  $dialog.Title = 'Choose a workspace folder for the Moriko Agent'",
    '  $dialog.InitialDirectory = $env:USERPROFILE',
    '  $picked = $dialog.ShowDialog($owner)',
    '  $owner.Close()',
    "  if ($picked -eq $true) { Write-Output $dialog.FolderName }",
    '} catch {',
    `  exit ${MODERN_EXIT_UNAVAILABLE}`,
    '}',
  ].join('\n');
}

function legacyScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$owner.ShowInTaskbar = $false',
    '$owner.Size = New-Object System.Drawing.Size(1, 1)',
    " $owner.StartPosition = 'Manual'",
    '$owner.Location = New-Object System.Drawing.Point(-32000, -32000)',
    '$owner.Show()',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    " $d.Description = 'Choose a workspace folder for the Moriko Agent'",
    '$d.ShowNewFolderButton = $true',
    'if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }',
    '$owner.Close()',
  ].join('\n');
}

/** UTF-16LE base64 for PowerShell's -EncodedCommand (no quoting hell). */
function encoded(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

interface PickerOutcome {
  /** Picked path; null on cancel or when nothing was output. */
  path: string | null;
  /** Process exit code — lets the caller detect a missing modern dialog. */
  code: number | null;
}

function runPicker(command: string, args: string[], timeoutMs: number): Promise<PickerOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let out = '';
    let settled = false;
    const finish = (outcome: PickerOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ path: null, code: null });
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer | string) => {
      out += String(chunk);
    });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      const picked = out.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
      finish({ path: picked || null, code });
    });
  });
}

const LEGACY_ARGS = [
  '-NoProfile',
  '-STA',
  '-NonInteractive',
  '-EncodedCommand',
  encoded(legacyScript()),
];

export function pickNativeFolder(description = 'Choose a workspace folder for the Moriko Agent'): Promise<string | null> {
  void description;
  return runPicker(
    'pwsh.exe',
    ['-NoProfile', '-Sta', '-NonInteractive', '-EncodedCommand', encoded(modernScript())],
    300_000,
  ).then((outcome) => {
    if (outcome.code === MODERN_EXIT_UNAVAILABLE) {
      return runPicker('powershell.exe', LEGACY_ARGS, 300_000).then((legacy) => legacy.path);
    }
    return outcome.path;
  }).catch(() =>
    runPicker('powershell.exe', LEGACY_ARGS, 300_000).then((legacy) => legacy.path),
  );
}
