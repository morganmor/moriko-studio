import { useEffect, useMemo, useRef, useState } from 'react';

import { Check, RotateCcw, Search } from './icons';
import { Tip, cx } from './ui';
import {
  formatContextSize,
  parseContextSize,
  resolveModelCapability,
  sourceLabel,
} from '../lib/modelCapability';
import { lookupModelMeta } from '../lib/modelMeta';
import {
  MODEL_CAPABILITY_COLUMNS,
  type ModelCapabilityFlags,
  type ModelCapabilitySource,
  type ModelMeta,
  type ProviderModelConfig,
  type ProviderModelHint,
} from '../types';


export interface ModelCapabilityTableProps {
  
  models: string[];
  
  configs: Record<string, ProviderModelConfig>;
  
  hints: Record<string, ProviderModelHint>;
  
  catalog: Record<string, ModelMeta>;
  
  onChange: (next: Record<string, ProviderModelConfig>) => void;
  
  onRemoveModel?: (modelId: string) => void;
  
  activeModel?: string;
  
  onSelectModel?: (modelId: string) => void;
  
  maxHeight?: number;
  
  disabled?: boolean;
}


const COLUMNS: Array<{ key: keyof ModelCapabilityFlags; label: string }> = [
  { key: 'imageIn', label: 'Vision' },
  { key: 'audioIn', label: 'Audio' },
  { key: 'videoIn', label: 'Video' },
  { key: 'pdfIn', label: 'PDF' },
  { key: 'tools', label: 'Tools' },
  { key: 'reasoning', label: 'Reasoning' },
];

export function ModelCapabilityTable({
  models,
  configs,
  hints,
  catalog,
  onChange,
  onRemoveModel,
  activeModel,
  onSelectModel,
  maxHeight = 320,
  disabled = false,
}: ModelCapabilityTableProps) {
  const [query, setQuery] = useState('');

  
  const rows = useMemo(() => {
    return models.map((id) => {
      const hint = hints[id];
      const catalogEntry = catalog[id] ?? lookupModelMeta(catalog, id);
      const stored = configs[id];
      const resolved = resolveModelCapability(id, stored, hint, catalogEntry);
      return { id, resolved, stored, hint, catalogEntry };
    });
  }, [models, configs, hints, catalog]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => row.id.toLowerCase().includes(needle));
  }, [rows, query]);

  
  const commitFlag = (id: string, key: keyof ModelCapabilityFlags, value: boolean): void => {
    const row = rows.find((entry) => entry.id === id);
    if (!row) return;
    const base = row.stored ?? row.resolved;
    const pinned = new Set(base.pinned ?? []);
    pinned.add(key);
    onChange({
      ...configs,
      [id]: {
        ...base,
        id,
        [key]: value,
        pinned: [...pinned],
        source: 'user',
      },
    });
  };

  
  const commitContext = (id: string, raw: string): void => {
    const row = rows.find((entry) => entry.id === id);
    if (!row) return;
    const base = row.stored ?? row.resolved;
    const pinned = new Set(base.pinned ?? []);

    if (raw.trim() === '') {
      pinned.delete('context');
      onChange({
        ...configs,
        [id]: {
          ...base,
          id,
          context: row.hint?.context ?? row.catalogEntry?.context ?? null,
          pinned: [...pinned],
          source: ([...pinned].length > 0 ? 'user' : 'provider') as ModelCapabilitySource,
        },
      });
      return;
    }

    const parsed = parseContextSize(raw);
    if (parsed === null) return;
    pinned.add('context');
    onChange({
      ...configs,
      [id]: { ...base, id, context: parsed, pinned: [...pinned], source: 'user' },
    });
  };

  
  const resetRow = (id: string): void => {
    const next = { ...configs };
    delete next[id];
    onChange(next);
  };

  if (models.length === 0) {
    return (
      <p style={{ margin: '8px 0 0', fontSize: 11.5, color: 'var(--faint)' }}>
        No models yet. Add ids manually, or save and fetch them from the provider.
      </p>
    );
  }

  return (
    <div className="mcap">
      <div className="mcap-bar">
        <label className="mcap-search">
          <Search className="ic" aria-hidden="true" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter models"
            aria-label="Filter models"
          />
        </label>
        <span className="mcap-count">
          {visible.length === rows.length
            ? `${rows.length} model${rows.length === 1 ? '' : 's'}`
            : `${visible.length} of ${rows.length}`}
        </span>
      </div>

      <div className="mcap-scroll" style={{ maxHeight }}>
        <table className="mcap-table">
          <thead>
            <tr>
              <th scope="col" className="mcap-name-h">Models</th>
              {COLUMNS.map((column) => (
                <th scope="col" key={column.key} className="mcap-flag-h">
                  {column.label}
                </th>
              ))}
              <th scope="col" className="mcap-ctx-h">Context Size</th>
              <th scope="col" className="mcap-act-h">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const { id, resolved } = row;
              const hasPins = (row.stored?.pinned?.length ?? 0) > 0;
              return (
                <tr key={id}>
                  <th scope="row" className="mcap-name">
                    {}
                    <Tip label={id} side="top" align="start">
                      <span className="mcap-id">{id}</span>
                    </Tip>
                    <span className="mcap-badges">
                      <span className={cx('mcap-badge', `src-${resolved.source.replace('.', '-')}`)}>
                        {sourceLabel(resolved.source)}
                      </span>
                      {row.catalogEntry ? (
                        <Tip
                          label={`models.dev hint: Vision ${row.catalogEntry.imageIn ? '✓' : '✗'}, Context ${
                            row.catalogEntry.context ? formatContextSize(row.catalogEntry.context) : 'unknown'
                          }`}
                        >
                          <span className="mcap-badge ghost">hint</span>
                        </Tip>
                      ) : (
                        <span className="mcap-badge ghost">not in models.dev</span>
                      )}
                    </span>
                  </th>

                  {COLUMNS.map((column) => (
                    <td key={column.key} className="mcap-flag">
                      <input
                        type="checkbox"
                        className="mcap-check"
                        checked={resolved[column.key]}
                        disabled={disabled}
                        aria-label={`${id} ${column.label}`}
                        onChange={(event) => commitFlag(id, column.key, event.target.checked)}
                      />
                    </td>
                  ))}

                  <td className="mcap-ctx">
                    <ContextCell
                      value={resolved.context}
                      pinned={row.stored?.pinned?.includes('context') === true}
                      disabled={disabled}
                      onCommit={(raw) => commitContext(id, raw)}
                    />
                  </td>

                  <td className="mcap-act">
                    <div className="mcap-act-inner">
                    {onSelectModel ? (
                      <Tip
                        label={
                          id === activeModel ? 'Active model' : 'Use as the active model'
                        }
                      >
                        <button
                          type="button"
                          className="mcap-icon-btn"
                          onClick={() => onSelectModel(id)}
                          disabled={disabled}
                          aria-pressed={id === activeModel}
                          aria-label={
                            id === activeModel ? `${id} is the active model` : `Use ${id} as the active model`
                          }
                          style={id === activeModel ? { color: 'rgb(var(--c-accent))' } : undefined}
                        >
                          <Check className="ic" aria-hidden="true" />
                        </button>
                      </Tip>
                    ) : null}
                    {hasPins ? (
                      <Tip label="Reset to provider / models.dev values">
                        <button
                          type="button"
                          className="mcap-icon-btn"
                          onClick={() => resetRow(id)}
                          disabled={disabled}
                          aria-label={`Reset ${id} to defaults`}
                        >
                          <RotateCcw className="ic" aria-hidden="true" />
                        </button>
                      </Tip>
                    ) : null}
                    {onRemoveModel ? (
                      <Tip label={`Remove ${id}`}>
                        <button
                          type="button"
                          className="mcap-icon-btn remove"
                          onClick={() => onRemoveModel(id)}
                          disabled={disabled}
                          aria-label={`Remove ${id}`}
                        >
                          ×
                        </button>
                      </Tip>
                    ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 ? (
              <tr>
                <td colSpan={MODEL_CAPABILITY_COLUMNS.length + 3} className="mcap-empty">
                  No model matches “{query}”.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}


function ContextCell({
  value,
  pinned,
  disabled,
  onCommit,
}: {
  value: number | null;
  pinned: boolean;
  disabled: boolean;
  onCommit: (raw: string) => void;
}) {
  const [draftText, setDraftText] = useState<string | null>(null);
  const display = draftText ?? (value === null ? '' : formatContextSize(value));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraftText(null);
  }, [value, pinned]);

  const commit = (): void => {
    if (draftText === null) return;
    onCommit(draftText);
    setDraftText(null);
  };

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="decimal"
      className={cx('mcap-ctx-input', pinned && 'pinned')}
      value={display}
      placeholder="—"
      disabled={disabled}
      aria-label="Context size in tokens"
      onChange={(event) => setDraftText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
          inputRef.current?.blur();
        } else if (event.key === 'Escape') {
          setDraftText(null);
          inputRef.current?.blur();
        }
      }}
    />
  );
}
