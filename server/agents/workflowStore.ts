import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { atomicWriteJson } from '../atomicWrite.js';
import { workflowsFile } from '../paths.js';
import { AGENT_WORKFLOWS, type AgentWorkflow } from './workflows.js';

/**
 * USER WORKFLOW STORE — user-authored and user-customized agent workflows.
 *
 * The BUILT-IN catalog lives in workflows.ts (read-only doctrine). This store
 * holds everything the USER shapes:
 *   • overrides   — entries whose id matches a built-in: they replace the
 *                   built-in's label/hint/content (this is how editing
 *                   Frontend-First works) — deleting the override restores it.
 *   • customs     — brand-new workflows created from the editor ("Add or Make
 *                   Workflow") with their own generated id.
 *
 * One JSON file at ~/.moriko-studio/workflows.json, written atomically.
 * The harness's workflow injection resolves through the MERGED catalog, so an
 * edited doctrine takes effect on the very next agent turn.
 */

export interface StoredWorkflow extends AgentWorkflow {
  /** True when this id belongs to the read-only built-in catalog. */
  builtin: boolean;
  /** True when a user override replaces a built-in's content. */
  modified: boolean;
  updatedAt: number;
}

interface UserWorkflowRecord {
  id: string;
  label: string;
  hint: string;
  content: string;
  updatedAt: number;
}

const MAX_LABEL = 80;
const MAX_HINT = 120;
const MAX_CONTENT = 40_000;
const MAX_WORKFLOWS = 30;

function loadUserRecords(): UserWorkflowRecord[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(workflowsFile, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is UserWorkflowRecord =>
        !!entry && typeof entry === 'object' &&
        typeof (entry as UserWorkflowRecord).id === 'string' &&
        typeof (entry as UserWorkflowRecord).content === 'string',
    );
  } catch {
    return [];
  }
}

function persistUserRecords(records: UserWorkflowRecord[]): void {
  atomicWriteJson(workflowsFile, records);
}

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** The merged catalog: built-ins (possibly overridden) + user customs. */
export function listStoredWorkflows(): StoredWorkflow[] {
  const userRecords = loadUserRecords();
  const byId = new Map(userRecords.map((record) => [record.id, record]));
  const merged: StoredWorkflow[] = AGENT_WORKFLOWS.map((builtin) => {
    const override = byId.get(builtin.id);
    byId.delete(builtin.id);
    return {
      ...(override ?? builtin),
      id: builtin.id,
      builtin: true,
      modified: Boolean(override),
      updatedAt: override?.updatedAt ?? 0,
    };
  });
  for (const record of userRecords.values()) {
    if (record.id === AGENT_WORKFLOWS[0].id) continue;
    merged.push({ ...record, builtin: false, modified: false });
  }
  return merged;
}

/** Create or update. A known built-in id updates its override; new ids are customs. */
export function upsertWorkflow(input: { id?: unknown; label?: unknown; hint?: unknown; content?: unknown }): StoredWorkflow {
  const label = clean(input.label, MAX_LABEL);
  const hint = clean(input.hint, MAX_HINT);
  const content = typeof input.content === 'string' ? input.content.slice(0, MAX_CONTENT) : '';
  if (!label) throw new Error('A workflow needs a name.');
  if (!content.trim()) throw new Error('A workflow needs non-empty content.');

  const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : `wf-${randomUUID().slice(0, 8)}`;
  const records = loadUserRecords();
  const now = Date.now();
  const existing = records.findIndex((record) => record.id === id);
  if (existing >= 0) {
    records[existing] = { id, label, hint, content, updatedAt: now };
  } else {
    if (records.length >= MAX_WORKFLOWS) {
      throw new Error(`Workflow limit reached (${MAX_WORKFLOWS}) — delete one first.`);
    }
    records.push({ id, label, hint, content, updatedAt: now });
  }
  persistUserRecords(records);

  const builtin = AGENT_WORKFLOWS.some((entry) => entry.id === id);
  return { id, label, hint, content, builtin, modified: builtin, updatedAt: now };
}

/**
 * Delete a user workflow; deleting a customized built-in REMOVES the override
 * (the built-in reverts to its original doctrine).
 */
export function deleteWorkflow(id: string): void {
  const records = loadUserRecords();
  const next = records.filter((record) => record.id !== id);
  if (next.length === records.length) throw new Error('Unknown workflow.');
  persistUserRecords(next);
}

/** Resolve a settings value against the MERGED catalog; unknown/empty → default. */
export async function resolveStoredWorkflow(id: string | undefined | null): Promise<AgentWorkflow> {
  const merged = listStoredWorkflows();
  return merged.find((workflow) => workflow.id === id) ?? merged[0];
}
