

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from './atomicWrite.js';
import { morikoHome } from './paths.js';

const LEDGER_FILE = path.join(morikoHome, 'usage-ledger.json');
const RETENTION_MS = 400 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10_000;
const FLUSH_DEBOUNCE_MS = 2_000;

export interface UsageEntry {
  ts: number;
  providerId: string;
  model: string;
  prompt: number;
  completion: number;
  total: number;
  cacheRead: number;
}

export interface ProviderUsage {
  providerId: string;
  requests: number;
  prompt: number;
  completion: number;
  total: number;
  cacheRead: number;
}

export interface UsageAggregate {
  windowMs: number;
  providers: ProviderUsage[];
  totals: { requests: number; prompt: number; completion: number; total: number; cacheRead: number };
}


export const USAGE_WINDOWS: Record<string, number> = {
  '1d': 1 * 86_400_000,
  '3d': 3 * 86_400_000,
  '7d': 7 * 86_400_000,
  '14d': 14 * 86_400_000,
  '30d': 30 * 86_400_000,
  '3mo': 90 * 86_400_000,
  '6mo': 180 * 86_400_000,
  '12mo': 365 * 86_400_000,
};

let entries: UsageEntry[] | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function ensureLoaded(): UsageEntry[] {
  if (entries) return entries;
  try {
    const raw = JSON.parse(readFileSync(LEDGER_FILE, 'utf-8')) as { entries?: UsageEntry[] };
    entries = Array.isArray(raw.entries) ? raw.entries.filter((entry) => entry && typeof entry.ts === 'number') : [];
  } catch {
    entries = [];
  }
  return entries;
}

function flush(): void {
  if (!entries) return;
  const cutoff = Date.now() - RETENTION_MS;
  let trimmed = entries.filter((entry) => entry.ts >= cutoff);
  if (trimmed.length > MAX_ENTRIES) trimmed = trimmed.slice(trimmed.length - MAX_ENTRIES);
  entries = trimmed;
  try {
    atomicWriteJson(LEDGER_FILE, { version: 1, entries });
  } catch {
  }
}


export function recordUsage(entry: Omit<UsageEntry, 'ts'>): void {
  try {
    const list = ensureLoaded();
    list.push({ ...entry, ts: Date.now() });
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, FLUSH_DEBOUNCE_MS);
  } catch {
  }
}


export function aggregateUsage(windowKey: string): UsageAggregate {
  const list = ensureLoaded();
  const windowMs = USAGE_WINDOWS[windowKey] ?? USAGE_WINDOWS['30d'];
  const cutoff = Date.now() - windowMs;
  const byProvider = new Map<string, ProviderUsage>();
  const totals = { requests: 0, prompt: 0, completion: 0, total: 0, cacheRead: 0 };

  for (const entry of list) {
    if (entry.ts < cutoff) continue;
    let bucket = byProvider.get(entry.providerId);
    if (!bucket) {
      bucket = { providerId: entry.providerId, requests: 0, prompt: 0, completion: 0, total: 0, cacheRead: 0 };
      byProvider.set(entry.providerId, bucket);
    }
    bucket.requests += 1;
    bucket.prompt += entry.prompt;
    bucket.completion += entry.completion;
    bucket.total += entry.total;
    bucket.cacheRead += entry.cacheRead;
    totals.requests += 1;
    totals.prompt += entry.prompt;
    totals.completion += entry.completion;
    totals.total += entry.total;
    totals.cacheRead += entry.cacheRead;
  }

  const providers = [...byProvider.values()].sort((a, b) => b.total - a.total);
  return { windowMs, providers, totals };
}

export interface DailyUsage {
  
  date: string;
  requests: number;
  prompt: number;
  completion: number;
  total: number;
  cacheRead: number;
}

function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}


export function dailyUsage(windowKey: string, providerIds?: string[]): DailyUsage[] {
  const list = ensureLoaded();
  const windowMs = USAGE_WINDOWS[windowKey] ?? USAGE_WINDOWS['30d'];
  const days = Math.max(1, Math.round(windowMs / 86_400_000));
  const byDay = new Map<string, DailyUsage>();
  const today = new Date();

  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(today);
    day.setDate(today.getDate() - i);
    const key = dayKey(day);
    byDay.set(key, { date: key, requests: 0, prompt: 0, completion: 0, total: 0, cacheRead: 0 });
  }

  for (const entry of list) {
    if (providerIds && !providerIds.includes(entry.providerId)) continue;
    const bucket = byDay.get(dayKey(new Date(entry.ts)));
    if (!bucket) continue;
    bucket.requests += 1;
    bucket.prompt += entry.prompt;
    bucket.completion += entry.completion;
    bucket.total += entry.total;
    bucket.cacheRead += entry.cacheRead;
  }

  return [...byDay.values()];
}
