/**
 * cloudflared.ts — binary manager + Quick Tunnel lifecycle for Mobile Watching.
 *
 * Download target is ALWAYS explicit (user-picked platform/arch); host
 * detection only pre-fills the UI. A non-host binary is download-only: only a
 * host-compatible `cloudflared` may run the tunnel.
 */
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { morikoHome } from '../paths.js';
import { atomicWriteJson } from '../atomicWrite.js';

const execFileAsync = promisify(execFile);

export interface PlatformTarget {
  id: string;
  label: string;
  asset: string;
  /** File name once installed. */
  binName: string;
  kind: 'binary' | 'tgz';
  runsHere: boolean;
}

const ARCH = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? '386' : 'amd64';

export const PLATFORM_TARGETS: PlatformTarget[] = [
  { id: 'windows-amd64', label: 'Windows x64', asset: 'cloudflared-windows-amd64.exe', binName: 'cloudflared.exe', kind: 'binary', runsHere: process.platform === 'win32' && ARCH === 'amd64' },
  { id: 'windows-arm64', label: 'Windows arm64', asset: 'cloudflared-windows-arm64.exe', binName: 'cloudflared.exe', kind: 'binary', runsHere: process.platform === 'win32' && ARCH === 'arm64' },
  { id: 'linux-amd64', label: 'Linux x64', asset: 'cloudflared-linux-amd64', binName: 'cloudflared-linux-amd64', kind: 'binary', runsHere: process.platform === 'linux' && ARCH === 'amd64' },
  { id: 'linux-arm64', label: 'Linux arm64', asset: 'cloudflared-linux-arm64', binName: 'cloudflared-linux-arm64', kind: 'binary', runsHere: process.platform === 'linux' && ARCH === 'arm64' },
  { id: 'linux-arm', label: 'Linux arm', asset: 'cloudflared-linux-arm', binName: 'cloudflared-linux-arm', kind: 'binary', runsHere: process.platform === 'linux' && ARCH === '386' },
  { id: 'darwin-amd64', label: 'macOS x64', asset: 'cloudflared-darwin-amd64.tgz', binName: 'cloudflared-darwin-amd64', kind: 'tgz', runsHere: process.platform === 'darwin' && ARCH === 'amd64' },
  { id: 'darwin-arm64', label: 'macOS arm64', asset: 'cloudflared-darwin-arm64.tgz', binName: 'cloudflared-darwin-arm64', kind: 'tgz', runsHere: process.platform === 'darwin' && ARCH === 'arm64' },
];

export function hostTarget(): PlatformTarget {
  return PLATFORM_TARGETS.find((t) => t.runsHere) ?? PLATFORM_TARGETS[0];
}

function targetById(id: string | undefined): PlatformTarget {
  if (!id) return hostTarget();
  const found = PLATFORM_TARGETS.find((t) => t.id === id);
  if (!found) throw new Error(`Unknown platform target "${id}".`);
  return found;
}

const BIN_DIR = path.join(morikoHome, 'bin');
const WATCH_DIR = path.join(morikoHome, 'watch');
const STATE_FILE = path.join(WATCH_DIR, 'state.json');

const DOWNLOAD_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

function binPath(target: PlatformTarget): string {
  return path.join(BIN_DIR, target.binName);
}

interface TunnelState {
  pid?: number;
  url?: string;
  port?: number;
  startedAt?: string;
  targetId?: string;
  version?: string;
}

function readState(): TunnelState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as TunnelState;
  } catch {
    return {};
  }
}

function writeState(state: TunnelState): void {
  fs.mkdirSync(WATCH_DIR, { recursive: true });
  atomicWriteJson(STATE_FILE, state);
}

/** Download progress, readable while POST /install runs. */
export const installState: {
  phase: 'idle' | 'downloading' | 'extracting' | 'error';
  targetId: string | null;
  received: number;
  total: number;
  error?: string;
} = { phase: 'idle', targetId: null, received: 0, total: 0 };

export function isInstalled(target: PlatformTarget): boolean {
  return fs.existsSync(binPath(target));
}

async function extractTgz(archive: string, target: PlatformTarget): Promise<void> {
  // bsdtar ships with Windows 10+; POSIX has tar. Extract then rename.
  const outDir = path.join(BIN_DIR, `.extract-${target.id}`);
  fs.mkdirSync(outDir, { recursive: true });
  await execFileAsync('tar', ['-xzf', archive, '-C', outDir], { windowsHide: true });
  const extracted = path.join(outDir, 'cloudflared');
  if (!fs.existsSync(extracted)) throw new Error('cloudflared binary missing from archive.');
  fs.renameSync(extracted, binPath(target));
  fs.rmSync(outDir, { recursive: true, force: true });
}

/**
 * Download the selected asset (skipped when already installed). Streams to a
 * .partial file, then renames atomically. Never guesses the target: pass it.
 */
export async function ensureInstalled(targetId?: string, force = false): Promise<{ skipped: boolean; path: string }> {
  const target = targetById(targetId);
  const dest = binPath(target);
  if (!force && isInstalled(target)) return { skipped: true, path: dest };

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const partial = `${dest}.partial`;
  installState.phase = 'downloading';
  installState.targetId = target.id;
  installState.received = 0;
  installState.total = 0;
  delete installState.error;

  try {
    const res = await fetch(`${DOWNLOAD_BASE}/${target.asset}`, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length') ?? 0);
    installState.total = total;

    const body = res.body as unknown as AsyncIterable<Uint8Array>;
    const out = fs.createWriteStream(partial);
    try {
      for await (const chunk of body) {
        installState.received += chunk.length;
        if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', resolve));
      }
    } finally {
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    }

    if (target.kind === 'tgz') {
      installState.phase = 'extracting';
      await extractTgz(partial, target);
      fs.rmSync(partial, { force: true });
    } else {
      fs.renameSync(partial, dest);
    }
    if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
    installState.phase = 'idle';
    return { skipped: false, path: dest };
  } catch (error) {
    installState.phase = 'error';
    installState.error = error instanceof Error ? error.message : String(error);
    fs.rmSync(partial, { force: true });
    throw error;
  }
}

/** `cloudflared version …` (cached in state once known). */
export async function readVersion(target?: PlatformTarget): Promise<string | null> {
  const t = target ?? hostTarget();
  if (!isInstalled(t)) return null;
  try {
    const { stdout } = await execFileAsync(binPath(t), ['--version'], { windowsHide: true, timeout: 10_000 });
    const line = (stdout || '').trim().split(/\r?\n/)[0] ?? '';
    return line || null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface LiveTunnel {
  child: ReturnType<typeof spawn> | null;
  url: string | null;
  port: number | null;
  startedAt: string | null;
  pid: number | null;
  /** True when adopted from a previous server run (no child handle). */
  adopted: boolean;
}

const live: LiveTunnel = { child: null, url: null, port: null, startedAt: null, pid: null, adopted: false };

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** Start a Quick Tunnel against `port`. Resolves once the public URL appears. */
export async function startTunnel(port: number, targetId?: string): Promise<{ url: string }> {
  const target = targetById(targetId);
  if (!target.runsHere) {
    throw new Error(
      `${target.label} cloudflared cannot run on this machine — download it for another device, or pick ${hostTarget().label}.`,
    );
  }
  if (live.child || (live.adopted && live.pid && isPidAlive(live.pid))) {
    throw new Error('A tunnel is already running — stop it first.');
  }
  await ensureInstalled(target.id);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port ${port}.`);

  const child = spawn(binPath(target), ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const startedAt = new Date().toISOString();
  live.child = child;
  live.pid = child.pid ?? null;
  live.url = null;
  live.port = port;
  live.startedAt = startedAt;
  live.adopted = false;

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stopTunnel().catch(() => undefined);
      reject(new Error('Timed out waiting for the tunnel URL (60s).'));
    }, 60_000);

    const onData = (buf: Buffer) => {
      const match = URL_RE.exec(buf.toString());
      if (!match || settled) return;
      settled = true;
      clearTimeout(timer);
      live.url = match[0];
      writeState({ pid: live.pid ?? undefined, url: live.url, port, startedAt, targetId: target.id });
      resolve({ url: live.url });
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      live.child = null;
      reject(error);
    });
    child.on('exit', (code) => {
      const wasLive = live.child === child;
      live.child = null;
      live.adopted = false;
      if (wasLive) writeState({});
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`cloudflared exited early (code ${code ?? 'signal'}).`));
    });
  });
}

export async function stopTunnel(): Promise<void> {
  if (live.child?.pid) {
    live.child.kill();
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(live.child.pid), '/T', '/F'], { windowsHide: true }, () => undefined);
    }
    live.child = null;
  } else if (live.adopted && live.pid && isPidAlive(live.pid)) {
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/PID', String(live.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined);
    } else {
      try { process.kill(live.pid); } catch { /* already gone */ }
    }
  }
  live.child = null;
  live.url = null;
  live.port = null;
  live.startedAt = null;
  live.pid = null;
  live.adopted = false;
  writeState({});
}

/**
 * Boot recovery: the supervisor reloads the server (exit 75) without killing
 * the tunnel child. Re-adopt the recorded pid so status/stop keep working.
 */
export function recoverTunnel(): void {
  const state = readState();
  if (!state.pid || !state.url) return;
  if (isPidAlive(state.pid)) {
    live.adopted = true;
    live.pid = state.pid;
    live.url = state.url;
    live.port = state.port ?? null;
    live.startedAt = state.startedAt ?? null;
  } else {
    writeState({});
  }
}

export interface WatchStatus {
  installed: boolean;
  hostTarget: string;
  version: string | null;
  tunnel: { running: boolean; url: string | null; port: number | null; pid: number | null; startedAt: string | null; adopted: boolean };
  install: typeof installState;
  targets: { id: string; label: string; installed: boolean; runsHere: boolean }[];
}

export async function watchStatus(): Promise<WatchStatus> {
  const host = hostTarget();
  const state = readState();
  const running = Boolean(live.child) || Boolean(live.adopted && live.pid && isPidAlive(live.pid));
  if (!running && (live.adopted || state.pid)) {
    live.adopted = false;
    writeState({});
  }
  return {
    installed: isInstalled(host),
    hostTarget: host.id,
    version: await readVersion(host),
    tunnel: {
      running,
      url: live.url ?? (running ? state.url ?? null : null),
      port: live.port ?? (running ? state.port ?? null : null),
      pid: live.pid ?? null,
      startedAt: live.startedAt ?? (running ? state.startedAt ?? null : null),
      adopted: live.adopted,
    },
    install: { ...installState },
    targets: PLATFORM_TARGETS.map((t) => ({
      id: t.id,
      label: t.label,
      installed: isInstalled(t),
      runsHere: t.runsHere,
    })),
  };
}
