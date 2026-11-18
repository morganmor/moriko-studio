

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';


export const envFilePath = path.resolve(process.cwd(), '.env');

interface EnvLine {
  kind: 'comment' | 'blank' | 'entry';
  
  raw?: string;
  key?: string;
  value?: string;
}

function parseEnv(text: string): EnvLine[] {
  const lines: EnvLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed === '') {
      lines.push({ kind: 'blank', raw });
      continue;
    }
    if (trimmed.startsWith('#')) {
      lines.push({ kind: 'comment', raw });
      continue;
    }
    const eq = raw.indexOf('=');
    if (eq <= 0) {
      lines.push({ kind: 'comment', raw });
      continue;
    }
    const key = raw.slice(0, eq).trim();
    let value = raw.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    lines.push({ kind: 'entry', key, value });
  }
  return lines;
}

function serializeEnv(lines: EnvLine[], trailingNewline: boolean): string {
  const body = lines
    .map((line) => {
      if (line.kind === 'entry') return `${line.key}=${line.value}`;
      return line.raw ?? '';
    })
    .join('\n');
  return trailingNewline ? `${body}\n` : body;
}

function readLines(): { lines: EnvLine[]; trailingNewline: boolean } {
  if (!existsSync(envFilePath)) return { lines: [], trailingNewline: true };
  const text = readFileSync(envFilePath, 'utf8');
  return { lines: parseEnv(text), trailingNewline: text.endsWith('\n') || text === '' };
}


export function setEnvValue(key: string, value: string): void {
  const { lines, trailingNewline } = readLines();
  const entry = lines.find((line) => line.kind === 'entry' && line.key === key);
  if (entry) {
    entry.value = value;
  } else {
    let insertAt = lines.length;
    while (insertAt > 0 && lines[insertAt - 1].kind === 'comment') insertAt -= 1;
    lines.splice(insertAt, 0, { kind: 'entry', key, value });
  }
  writeFileSync(envFilePath, serializeEnv(lines, trailingNewline));
}


export function removeEnvValue(key: string): void {
  const { lines, trailingNewline } = readLines();
  const filtered = lines.filter((line) => !(line.kind === 'entry' && line.key === key));
  if (filtered.length === lines.length) return;
  writeFileSync(envFilePath, serializeEnv(filtered, trailingNewline));
}


export function getEnvValue(key: string): string | null {
  const { lines } = readLines();
  const entry = lines.find((line) => line.kind === 'entry' && line.key === key);
  return entry?.value ?? null;
}
