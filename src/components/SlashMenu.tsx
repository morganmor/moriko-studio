import { useEffect, useRef, useState } from 'react';

/**
 * SLASH COMMAND INPUT — ported from design/Moriko-Design2-slash-input.html.
 *
 * Typing "/" at the start of the composer opens this listbox above the input:
 * prefix filtering, ↑↓ navigation, Tab autocomplete, Enter run, Escape close,
 * pointer click. Built-in commands merge with the ones registered by addons
 * (GET /api/addons/commands); runs of addon commands go through
 * POST /api/addons/commands/run, which walks the addon "command.run" hooks.
 */

export interface SlashCommand {
  /** Canonical form, always starting with "/". */
  c: string;
  /** One-line description shown under the command name. */
  h: string;
  /** True when the command is handled locally by the app (never sent to the
   *  server); false means "addon command" — POST /api/addons/commands/run. */
  builtin: boolean;
  /** Optional [arg] hint appended to the label in the list. */
  argumentHint?: string;
}

export interface SlashMenuHandle {
  /** Filtered commands for the current draft ("/xyz" prefix), or null when the
   *  menu is closed (draft not a bare command). */
  list: SlashCommand[] | null;
  /** Highlighted row (index into `list`, clamped). */
  sel: number;
  /** ↑↓ / Tab / Enter / Escape while the menu is open — returns true when the
   *  key was consumed (the composer must then skip its own handling). */
  key: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Replace the draft with "/name " and keep the menu's state in sync. */
  tabComplete: () => void;
  /** Run the highlighted row — clears the draft (design pickSlash) and fires
   *  the command through `onRun`. */
  pick: () => void;
  /** Run a raw submitted draft ("/name arg") — returns false when it is not a
   *  slash command (the composer sends it as a normal message). */
  runText: (text: string) => boolean;
  /** Mouse click on row index (pointerdown focus prevention is internal). */
  click: (index: number) => void;
  /** Hover-select: the row under the pointer becomes the highlighted one. */
  hover: (index: number) => void;
}

interface SlashState {
  list: SlashCommand[] | null;
  sel: number;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/**
 * Shared wiring: one hook drives the open/close state and returns the handle
 * the composer proxies into its textarea events.
 */
export function useSlashMenu(
  draft: string,
  onDraftChange: (value: string) => void,
  onRun: (command: SlashCommand, args: string) => void,
  builtin: SlashCommand[],
): SlashMenuHandle {
  const [state, setState] = useState<SlashState>({ list: null, sel: 0 });
  const addonCommands = useRef<SlashCommand[]>([]);
  const [addonTick, setAddonTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const resp = await fetch('/api/addons/commands');
        if (!resp.ok) return;
        const payload = (await resp.json()) as {
          commands: Array<{ name: string; description: string; argumentHint?: string }>;
        };
        if (cancelled) return;
        addonCommands.current = payload.commands.map((cmd) => ({
          c: `/${cmd.name}`,
          h: cmd.description,
          builtin: false,
          argumentHint: cmd.argumentHint,
        }));
        setAddonTick((tick) => tick + 1);
      } catch {
      }
    };
    void load();
    const onReload = () => void load();
    window.addEventListener('moriko:addons-reloaded', onReload);
    return () => {
      cancelled = true;
      window.removeEventListener('moriko:addons-reloaded', onReload);
    };
  }, []);

  const all = useRef<SlashCommand[]>([]);
  all.current = [...builtin, ...addonCommands.current];

  useEffect(() => {
    const match = /^\/(\w*)$/.exec(draft);
    if (!match) {
      if (state.list) setState({ list: null, sel: 0 });
      return;
    }
    const prefix = match[1].toLowerCase();
    const filtered = all.current.filter((s) => s.c.slice(1).startsWith(prefix));
    if (filtered.length === 0) {
      if (state.list) setState({ list: null, sel: 0 });
      return;
    }
    setState((prev) => ({ list: filtered, sel: clamp(prev.sel, 0, filtered.length - 1) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, addonTick]);

  const close = () => setState({ list: null, sel: 0 });

  const pickIndex = (index: number) => {
    const s = state.list?.[index];
    if (!s) return;
    onDraftChange('');
    close();
    onRun(s, '');
  };

  const runText = (text: string): boolean => {
    const match = /^(\S+)\s*([\s\S]*)$/.exec(text.trim());
    if (!match || !match[1].startsWith('/')) return false;
    const name = match[1].toLowerCase();
    const s = all.current.find((x) => x.c === name);
    if (!s) return false;
    onDraftChange('');
    close();
    onRun(s, match[2].trim());
    return true;
  };

  const handle: SlashMenuHandle = {
    list: state.list,
    sel: state.sel,
    key: (event) => {
      if (!state.list || state.list.length === 0) return false;
      const list = state.list;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const sel = (state.sel + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
        setState({ list, sel });
        return true;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        onDraftChange(`${list[state.sel].c} `);
        return true;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        pickIndex(state.sel);
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        return true;
      }
      return false;
    },
    tabComplete: () => {
      if (!state.list) return;
      onDraftChange(`${state.list[state.sel].c} `);
    },
    pick: () => pickIndex(state.sel),
    runText,
    click: (index) => pickIndex(index),
    hover: (index) => {
      if (!state.list) return;
      const sel = clamp(index, 0, state.list.length - 1);
      if (sel !== state.sel) setState({ list: state.list, sel });
    },
  };

  return handle;
}

/** The listbox itself — rendered above the composer textarea, design .slash. */
export function SlashMenu({
  list,
  sel,
  onPick,
  onHover,
}: {
  list: SlashCommand[];
  sel: number;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current?.querySelector(`[data-si="${sel}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [sel, list]);

  if (list.length === 0) return null;
  return (
    <div className="slash" ref={ref} role="listbox" aria-label="Commands">
      {list.map((s, i) => (
        <button
          key={s.c}
          type="button"
          className={s.builtin ? 'si builtin' : 'si'}
          role="option"
          aria-selected={i === sel}
          data-si={i}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onPick(i)}
          onMouseEnter={() => onHover(i)}
        >
          <span className="sic" aria-hidden="true">/</span>
          <span className="min0" style={{ minWidth: 0 }}>
            <b>
              {s.c}
              {s.argumentHint ? <small className="si-arg"> {s.argumentHint}</small> : null}
            </b>
            <br />
            <small>{s.h}</small>
          </span>
        </button>
      ))}
    </div>
  );
}
