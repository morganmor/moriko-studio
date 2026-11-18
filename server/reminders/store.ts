import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { atomicWriteJson } from '../atomicWrite.js';
import { remindersFile } from '../paths.js';



const STORE_PATH = remindersFile;
const MAX_LABEL = 300;
const MAX_PER_SESSION = 50;
const MAX_FUTURE_DAYS = 30;

export interface Reminder {
  id: string;
  session: string;
  label: string;
  
  fireAt: number;
  createdAt: number;
  deliveredAt: number | null;
}

type Store = Record<string, Reminder[]>;

function load(): Store {
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function save(store: Store): void {
  atomicWriteJson(STORE_PATH, store);
}

export interface ReminderInput {
  label: string;
  
  fireAt?: number | string;
  inMinutes?: number;
}

export function createReminder(sessionId: string, input: ReminderInput): Reminder {
  const session = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'default';
  const label = (input.label ?? '').trim().slice(0, MAX_LABEL);
  if (!label) throw new Error('A reminder needs a label.');

  let fireAt: number;
  if (input.inMinutes !== undefined && input.inMinutes !== null) {
    const minutes = Number(input.inMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('inMinutes must be a positive number.');
    fireAt = Date.now() + minutes * 60_000;
  } else if (typeof input.fireAt === 'number' && Number.isFinite(input.fireAt)) {
    fireAt = input.fireAt;
  } else if (typeof input.fireAt === 'string' && input.fireAt.trim()) {
    const parsed = new Date(input.fireAt.trim());
    if (Number.isNaN(parsed.getTime())) throw new Error(`Could not parse the reminder time "${input.fireAt}".`);
    fireAt = parsed.getTime();
  } else {
    throw new Error('A reminder needs "inMinutes" or "at" (ISO timestamp).');
  }
  if (!Number.isFinite(fireAt)) throw new Error('Could not parse the reminder time.');
  if (fireAt < Date.now() - 60_000) throw new Error('The reminder time is in the past.');
  if (fireAt > Date.now() + MAX_FUTURE_DAYS * 24 * 60 * 60 * 1000) {
    throw new Error(`Reminders can be at most ${MAX_FUTURE_DAYS} days ahead.`);
  }

  const store = load();
  const list = store[session] ?? [];
  if (list.length >= MAX_PER_SESSION) throw new Error(`Too many reminders for this conversation (max ${MAX_PER_SESSION}).`);
  const reminder: Reminder = {
    id: randomUUID().slice(0, 8),
    session,
    label,
    fireAt,
    createdAt: Date.now(),
    deliveredAt: null,
  };
  store[session] = [...list, reminder];
  save(store);
  return reminder;
}

export function listReminders(sessionId: string, includeDelivered = true): Reminder[] {
  const session = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'default';
  const list = load()[session] ?? [];
  const filtered = includeDelivered ? list : list.filter((reminder) => reminder.deliveredAt === null);
  return filtered.sort((a, b) => a.fireAt - b.fireAt);
}


export function takeDueReminders(sessionId: string): Reminder[] {
  const session = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'default';
  const store = load();
  const list = store[session] ?? [];
  const now = Date.now();
  const due = list.filter((reminder) => reminder.deliveredAt === null && reminder.fireAt <= now);
  if (due.length === 0) return [];
  store[session] = list.map((reminder) =>
    due.some((entry) => entry.id === reminder.id) ? { ...reminder, deliveredAt: now } : reminder,
  );
  save(store);
  return due;
}

export function deleteReminder(sessionId: string, reminderId: string): boolean {
  const session = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'default';
  const store = load();
  const list = store[session] ?? [];
  const next = list.filter((reminder) => reminder.id !== reminderId);
  if (next.length === list.length) return false;
  store[session] = next;
  save(store);
  return true;
}

export function renderReminder(reminder: Reminder): string {
  const when = new Date(reminder.fireAt).toISOString().replace('T', ' ').slice(0, 16);
  const due = reminder.fireAt <= Date.now();
  return `(${reminder.id}) ${due ? 'DUE NOW' : `at ${when}`} — ${reminder.label}`;
}
