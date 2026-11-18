import { useEffect, useRef, useState } from 'react';



export interface SlashCommand {
  
  c: string;
  
  h: string;
  
  builtin: boolean;
  
  argumentHint?: string;
  
  skill?: boolean;
}

export interface SlashMenuHandle {
  
  list: SlashCommand[] | null;
  
  sel: number;
  
  key: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  
  tabComplete: () => void;
  
  pick: () => void;
  
  runText: (text: string) => boolean;
  
  click: (index: number) => void;
  
  hover: (index: number) => void;
}

interface SlashState {
  list: SlashCommand[] | null;
  sel: number;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));


export function useSlashMenu(
  draft: string,
  onDraftChange: (value: string) => void,
  onRun: (command: SlashCommand, args: string) => void,
  builtin: SlashCommand[],
): SlashMenuHandle {
  const [state, setState] = useState<SlashState>({ list: null, sel: 0 });
  const addonCommands = useRef<SlashCommand[]>([]);
  const skillCommands = useRef<SlashCommand[]>([]);
  const [addonTick, setAddonTick] = useState(0);
  const [skillTick, setSkillTick] = useState(0);

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

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const resp = await fetch('/api/skills');
        if (!resp.ok) return;
        const payload = (await resp.json()) as {
          skills: Array<{ name: string; description: string }>;
        };
        if (cancelled) return;
        const names = payload.skills.map((skill) => skill.name);
        const preview = names.slice(0, 4).join(', ') + (names.length > 4 ? `, +${names.length - 4} more` : '');
        skillCommands.current = [
          {
            c: '/skills',
            h: names.length ? `Available skills: ${preview}` : 'No skills installed (~/.moriko-studio/skills or .moriko/skills)',
            builtin: false,
            skill: true,
            argumentHint: '[skill] [args]',
          },
        ];
        setSkillTick((tick) => tick + 1);
      } catch {
      }
    };
    void load();
    const interval = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const all = useRef<SlashCommand[]>([]);
  all.current = [...builtin, ...addonCommands.current, ...skillCommands.current];
  void skillTick;

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
