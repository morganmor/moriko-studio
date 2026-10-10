/**
 * .ENV UPDATER — the write side of the storage-location feature.
 *
 * MORIKO_HOME is read ONCE at boot (see paths.ts), so "the user picks a new
 * location in Settings" can only mean: persist the choice in the repo's .env
 * and let the harness reload pick it up. dotenv already loaded the file at
 * boot; this module edits the FILE without losing hand-written comments,
 * blank lines, or quoted values.
 *
 * Mirrors dotenv's parsing rules loosely (KEY=VALUE, optional quotes, `#`
 * comments, blank lines preserved) and never rewrites values it does not
 * touch.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The repo .env (same file dotenv loaded at boot). */
export const envFilePath = path.resolve(process.cwd(), '.env');

interface EnvLine {
  kind: 'comment' | 'blank' | 'entry';
  /** Raw text for comment/blank lines. */
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

/** Upsert one KEY=VALUE line, preserving comments, blanks and order. */
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

/** Remove a KEY line entirely (used to reset to the default home). */
export function removeEnvValue(key: string): void {
  const { lines, trailingNewline } = readLines();
  const filtered = lines.filter((line) => !(line.kind === 'entry' && line.key === key));
  if (filtered.length === lines.length) return;
  writeFileSync(envFilePath, serializeEnv(filtered, trailingNewline));
}

/** Read one value without writing (null when absent). */
export function getEnvValue(key: string): string | null {
  const { lines } = readLines();
  const entry = lines.find((line) => line.kind === 'entry' && line.key === key);
  return entry?.value ?? null;
}
