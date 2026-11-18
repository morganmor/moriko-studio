
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ListeningPort {
  port: number;
  label?: string;
  pid?: number;
}


const KNOWN: Record<number, string> = {
  5588: 'Moriko web (Vite)',
  5178: 'Moriko web (Vite, legacy)',
  8791: 'Moriko proxy (legacy)',
  8826: 'Moriko proxy (internal)',
};


const EXCLUDED = new Set([8826, 8791]);


export const PREFERRED_PORT = 5588;

async function listRaw(): Promise<{ port: number; pid?: number }[]> {
  const out: { port: number; pid?: number }[] = [];
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp'], {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (!m) continue;
      out.push({ port: Number(m[2]), pid: Number(m[3]) });
    }
    return out;
  }
  const { stdout } = await execFileAsync('ss', ['-ltn'], { maxBuffer: 4 * 1024 * 1024 }).catch(() =>
    execFileAsync('netstat', ['-ltn'], { maxBuffer: 4 * 1024 * 1024 }),
  );
  for (const line of stdout.split(/\r?\n/)) {
    if (!/LISTEN/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    const addr = cols[3] ?? cols[1] ?? '';
    const port = Number(addr.slice(addr.lastIndexOf(':') + 1));
    if (Number.isInteger(port) && port > 0) out.push({ port });
  }
  return out;
}


export async function listListeningPorts(): Promise<ListeningPort[]> {
  const raw = await listRaw();
  const byPort = new Map<number, ListeningPort>();
  for (const entry of raw) {
    if (EXCLUDED.has(entry.port)) continue;
    if (byPort.has(entry.port)) continue;
    byPort.set(entry.port, {
      port: entry.port,
      label: KNOWN[entry.port],
      pid: entry.pid,
    });
  }
  const list = [...byPort.values()];
  list.sort((a, b) => {
    const ap = a.port === PREFERRED_PORT ? 0 : 1;
    const bp = b.port === PREFERRED_PORT ? 0 : 1;
    return ap - bp || a.port - b.port;
  });
  return list;
}
