import { useEffect, useState } from 'react';
import { Check, Pencil, Plus, Route, Trash2 } from './icons';
import { Modal, cx } from './ui';
import { deleteWorkflow, saveWorkflow, type AgentWorkflowDTO } from '../lib/api';

/**
 * AGENT WORKFLOW EDITOR — the "book" modal behind the Edit button on the
 * Agent workflow card. Left page: the merged catalog (built-ins + the user's
 * own) plus "Add or Make Workflow". Right page: name / hint / the doctrine
 * text itself. Saving a built-in stores the user's copy as an override;
 * deleting reverts a built-in override (or removes a custom workflow).
 */

interface DraftState {
  /** null = brand-new workflow (created on save). */
  id: string | null;
  label: string;
  hint: string;
  content: string;
  builtin: boolean;
  modified: boolean;
}

interface WorkflowEditorProps {
  open: boolean;
  onClose: () => void;
  workflows: AgentWorkflowDTO[];
  /** Workflow preselected when the modal opens (falls back to the first). */
  selectedId: string;
  onSaved: (workflow: AgentWorkflowDTO) => void;
  onDeleted: (id: string) => void;
}

function draftOf(workflow: AgentWorkflowDTO | undefined): DraftState {
  if (!workflow) return { id: null, label: '', hint: '', content: '', builtin: false, modified: false };
  return {
    id: workflow.id,
    label: workflow.label,
    hint: workflow.hint,
    content: workflow.content,
    builtin: workflow.builtin,
    modified: workflow.modified,
  };
}

export function WorkflowEditor({ open, onClose, workflows, selectedId, onSaved, onDeleted }: WorkflowEditorProps) {
  const [draft, setDraft] = useState<DraftState>(() => draftOf(workflows.find((workflow) => workflow.id === selectedId) ?? workflows[0]));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  // Re-seed the draft each time the modal opens on a workflow.
  useEffect(() => {
    if (!open) return;
    setDraft(draftOf(workflows.find((workflow) => workflow.id === selectedId) ?? workflows[0]));
    setDirty(false);
  }, [open, selectedId, workflows]);

  function pick(workflow: AgentWorkflowDTO | undefined) {
    setDraft(draftOf(workflow));
    setDirty(false);
  }

  function update(patch: Partial<DraftState>) {
    setDraft((current) => ({ ...current, ...patch }));
    setDirty(true);
  }

  async function handleSave() {
    if (!draft.label.trim() || !draft.content.trim()) return;
    setBusy(true);
    try {
      const saved = await saveWorkflow({
        id: draft.id ?? undefined,
        label: draft.label,
        hint: draft.hint,
        content: draft.content,
      });
      onSaved(saved);
      setDraft(draftOf(saved));
      setDirty(false);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!draft.id) return;
    setBusy(true);
    try {
      await deleteWorkflow(draft.id);
      onDeleted(draft.id);
      setDraft(draftOf(workflows.find((workflow) => workflow.id === selectedId) ?? workflows[0]));
      setDirty(false);
    } finally {
      setBusy(false);
    }
  }

  const canSave = !busy && draft.label.trim().length > 0 && draft.content.trim().length > 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Agent workflow"
      description="The doctrine the harness injects on every agent turn. Editing a built-in saves your own copy on top of it."
      size="wide"
      footer={
        <>
          {draft.id && (draft.builtin ? draft.modified : true) ? (
            <button type="button" className="btn ghost sm" onClick={() => void handleDelete()} disabled={busy}>
              <Trash2 className="ic" aria-hidden="true" />
              {draft.builtin ? 'Reset to built-in' : 'Delete workflow'}
            </button>
          ) : null}
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn primary sm" onClick={() => void handleSave()} disabled={!canSave}>
            {busy ? 'Saving…' : 'Save workflow'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 14, padding: 16 }}>
        {/* LEFT PAGE — the catalog */}
        <div style={{ width: 210, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0 }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--faint)' }}>
            Workflows
          </span>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {workflows.map((workflow) => (
              <button
                key={workflow.id}
                type="button"
                className={cx('mi', draft.id === workflow.id && !dirty && 'active')}
                onClick={() => pick(workflow)}
                style={{ textAlign: 'left', width: '100%' }}
              >
                <Route className="ic" aria-hidden="true" />
                <span>
                  {workflow.label}
                  <small>{workflow.builtin ? (workflow.modified ? 'built-in · edited' : 'built-in') : 'custom'}</small>
                </span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn ghost sm"
            style={{ justifyContent: 'center', width: '100%' }}
            onClick={() => pick(undefined)}
          >
            <Plus className="ic" aria-hidden="true" />
            Add or Make Workflow
          </button>
        </div>

        {/* RIGHT PAGE — the doctrine text */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            className="field"
            value={draft.label}
            onChange={(event) => update({ label: event.target.value })}
            placeholder={draft.id ? undefined : 'New workflow name'}
            aria-label="Workflow name"
            style={{ fontSize: 13, fontWeight: 600 }}
          />
          <input
            className="field"
            value={draft.hint}
            onChange={(event) => update({ hint: event.target.value })}
            placeholder="One-line hint (shown in the selector)"
            aria-label="Workflow hint"
            style={{ fontSize: 12.5 }}
          />
          <textarea
            className="field"
            value={draft.content}
            onChange={(event) => update({ content: event.target.value })}
            placeholder="Write the working doctrine the agent must follow…"
            aria-label="Workflow content"
            rows={16}
            spellCheck={false}
            style={{
              flex: 1,
              minHeight: 0,
              resize: 'none',
              fontFamily: 'var(--f-mono)',
              fontSize: 12,
              lineHeight: 1.7,
              whiteSpace: 'pre-wrap',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: 'var(--faint)' }}>
            <span>{draft.content.length} chars</span>
            <span>~{Math.max(0, Math.round(draft.content.length / 4))} tokens</span>
            {draft.id ? (
              draft.builtin && !draft.modified && !dirty ? (
                <span>built-in doctrine</span>
              ) : (
                <span className="saved">
                  <Check className="ic" aria-hidden="true" />
                  {dirty ? 'Unsaved changes' : 'Saved'}
                </span>
              )
            ) : dirty ? (
              <span className="saved">
                <Check className="ic" aria-hidden="true" />
                Unsaved changes
              </span>
            ) : null}
            <span style={{ flex: 1 }} />
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Pencil className="ic" aria-hidden="true" style={{ width: 12, height: 12 }} />
              injected each agent turn
            </span>
          </div>
        </div>
      </div>
    </Modal>
  );
}
