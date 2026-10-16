import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { cx } from './ui';
import {
  Clock3,
  Download,
  Gauge,
  ImageIcon,
  Images,
  LayoutPanelLeft,
  MessageSquare,
  Moon,
  PanelLeftClose,
  PanelRightOpen,
  Plus,
  Search,
  Settings,
  Sparkles,
  Sun,
  Upload,
  Wand2,
} from './icons';
import { useStore } from '../store/useStore';
import type { Accent, ThemeMode } from '../types';

/**
 * Command palette ("Search or jump…", Ctrl K) — ported from
 * moriko-design-1-command-palette.html.
 *
 * One input, grouped results (Chats / Actions / Go to / Theme), FUZZY search
 * (substring first, then subsequence) with matched characters highlighted,
 * ↑↓ / Enter / Escape, mouse hover-select, and the design's footer hints.
 * With an empty query the design keeps the default view short: 5 chats, only
 * Light/Dark theme entries — typing reveals Mocha/System and the accents.
 */
type PaletteItem = {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
};

/** Design's fuzzy(): exact substring scores high, else a subsequence match. */
type FuzzyMatch = { sc: number; m: Array<[number, number]> };
function fuzzy(q: string, s: string): FuzzyMatch | null {
  const text = s.toLowerCase();
  const at = text.indexOf(q);
  if (at >= 0) return { sc: 100 - at, m: [[at, at + q.length]] };
  let cursor = 0;
  const spans: Array<[number, number]> = [];
  for (let index = 0; index < text.length && cursor < q.length; index += 1) {
    if (text[index] === q[cursor]) {
      spans.push([index, index + 1]);
      cursor += 1;
    }
  }
  return cursor === q.length ? { sc: 10 - spans.length * 0.1, m: spans } : null;
}

function Highlight({ text, spans }: { text: string; spans: Array<[number, number]> | null }) {
  if (!spans || spans.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  spans.forEach(([from, to], index) => {
    if (from > cursor) parts.push(text.slice(cursor, from));
    parts.push(<b key={index}>{text.slice(from, to)}</b>);
    cursor = to;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

const THEME_ENTRIES: Array<{ mode: ThemeMode; label: string }> = [
  { mode: 'light', label: 'Light theme' },
  { mode: 'dark', label: 'Dark theme' },
  { mode: 'mocha', label: 'Mocha theme' },
  { mode: 'system', label: 'System theme' },
];

const ACCENT_ENTRIES: Accent[] = ['ember', 'sakura', 'matcha', 'ocean', 'violet'];

export function CommandPalette({
  open,
  onClose,
  onOpenSettings,
}: {
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const conversations = useStore((state) => state.conversations);
  const setView = useStore((state) => state.setView);
  const newConversation = useStore((state) => state.newConversation);
  const selectConversation = useStore((state) => state.selectConversation);
  const setTheme = useStore((state) => state.setTheme);
  const setAccent = useStore((state) => state.setAccent);
  const toggleSidebar = useStore((state) => state.toggleSidebar);
  const toggleSettings = useStore((state) => state.toggleSettings);

  const items = useMemo<PaletteItem[]>(() => {
    const run = (fn: () => void) => () => {
      fn();
      onClose();
    };
    const list: PaletteItem[] = [];
    for (const conversation of conversations.slice(0, 40)) {
      list.push({
        id: `chat:${conversation.id}`,
        group: 'Chats',
        label: conversation.title || 'Untitled',
        icon: <MessageSquare className="ic" aria-hidden="true" />,
        run: run(() => {
          useStore.getState().setView('playground');
          selectConversation(conversation.id);
        }),
      });
    }
    list.push(
      {
        id: 'new-chat',
        group: 'Actions',
        label: 'New chat',
        hint: 'Alt N',
        icon: <Plus className="ic" aria-hidden="true" />,
        run: run(() => {
          useStore.getState().setView('playground');
          newConversation();
        }),
      },
      {
        id: 'generate-image',
        group: 'Actions',
        label: 'Generate image',
        icon: <Wand2 className="ic" aria-hidden="true" />,
        run: run(() => setView('imagestudio')),
      },
      {
        id: 'toggle-sidebar',
        group: 'Actions',
        label: 'Toggle sidebar',
        hint: 'Ctrl B',
        icon: <PanelLeftClose className="ic" aria-hidden="true" />,
        run: run(() => toggleSidebar()),
      },
      {
        id: 'toggle-dock',
        group: 'Actions',
        label: 'Toggle configuration panel',
        hint: 'Ctrl .',
        icon: <PanelRightOpen className="ic" aria-hidden="true" />,
        run: run(() => toggleSettings()),
      },
      {
        id: 'export-all',
        group: 'Actions',
        label: 'Export all chats',
        icon: <Download className="ic" aria-hidden="true" />,
        run: run(() => {
          void import('../lib/exportImport').then((module) => module.exportAll());
        }),
      },
      {
        id: 'import-chats',
        group: 'Actions',
        label: 'Import chats',
        icon: <Upload className="ic" aria-hidden="true" />,
        run: run(() => {
          window.dispatchEvent(new CustomEvent('moriko:import-chat'));
        }),
      },
      {
        id: 'view:history',
        group: 'Go to',
        label: 'History',
        icon: <Clock3 className="ic" aria-hidden="true" />,
        run: run(() => setView('history')),
      },
      {
        id: 'view:imagestudio',
        group: 'Go to',
        label: 'Image Studio',
        icon: <Wand2 className="ic" aria-hidden="true" />,
        run: run(() => setView('imagestudio')),
      },
      {
        id: 'view:imagehistory',
        group: 'Go to',
        label: 'Image history',
        icon: <ImageIcon className="ic" aria-hidden="true" />,
        run: run(() => setView('imagehistory')),
      },
      {
        id: 'view:gallery',
        group: 'Go to',
        label: 'Gallery',
        icon: <Images className="ic" aria-hidden="true" />,
        run: run(() => setView('gallery')),
      },
      {
        id: 'view:dashboard',
        group: 'Go to',
        label: 'Dashboard',
        icon: <Gauge className="ic" aria-hidden="true" />,
        run: run(() => setView('dashboard')),
      },
      {
        id: 'view:playground',
        group: 'Go to',
        label: 'Playground',
        icon: <LayoutPanelLeft className="ic" aria-hidden="true" />,
        run: run(() => setView('playground')),
      },
      {
        id: 'settings',
        group: 'Actions',
        label: 'Settings',
        icon: <Settings className="ic" aria-hidden="true" />,
        run: run(() => onOpenSettings()),
      },
    );
    for (const entry of THEME_ENTRIES) {
      list.push({
        id: `theme:${entry.mode}`,
        group: 'Theme',
        label: entry.label,
        icon:
          entry.mode === 'light' ? (
            <Sun className="ic" aria-hidden="true" />
          ) : entry.mode === 'system' ? (
            <Settings className="ic" aria-hidden="true" />
          ) : (
            <Moon className="ic" aria-hidden="true" />
          ),
        run: run(() => setTheme(entry.mode)),
      });
    }
    for (const accent of ACCENT_ENTRIES) {
      list.push({
        id: `accent:${accent}`,
        group: 'Theme',
        label: `Accent: ${accent[0].toUpperCase()}${accent.slice(1)}`,
        icon: <Sparkles className="ic" aria-hidden="true" />,
        run: run(() => setAccent(accent)),
      });
    }
    return list;
  }, [conversations, onClose, onOpenSettings]);

  /** Scored fuzzy results when querying; the design's trimmed default otherwise. */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) {
      const scored = items
        .map((item) => ({ item, f: fuzzy(q, item.label) }))
        .filter((entry): entry is { item: PaletteItem; f: FuzzyMatch } => entry.f !== null);
      scored.sort((a, b) => b.f.sc - a.f.sc);
      return scored;
    }
    let chatCount = 0;
    return items
      .filter((item) => {
        if (item.group === 'Chats') {
          chatCount += 1;
          return chatCount <= 5;
        }
        if (item.group === 'Theme' && !(item.label.startsWith('Light') || item.label.startsWith('Dark'))) {
          return false;
        }
        return true;
      })
      .map((item) => ({ item, f: null as FuzzyMatch | null }));
  }, [items, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest('[data-palette-panel]')) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  const move = (delta: number) => {
    setCursor((current) => {
      const next = current + delta;
      if (next < 0) return filtered.length - 1;
      if (next >= filtered.length) return 0;
      return next;
    });
    requestAnimationFrame(() => {
      const active = listRef.current?.querySelector('[data-cursor="true"]');
      active?.scrollIntoView({ block: 'nearest' });
    });
  };

  let lastGroup = '';
  return createPortal(
    <div className="modal open" id="m-palette" style={{ alignItems: 'flex-start', paddingTop: '12vh' }}>
      <div className="mpanel" data-palette-panel role="dialog" aria-label="Command palette" style={{ maxWidth: 520 }}>
        <div className="pal-in">
          <Search className="ic" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                move(1);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                move(-1);
              } else if (event.key === 'Enter') {
                event.preventDefault();
                filtered[cursor]?.item.run();
              }
            }}
            placeholder="Type a command, chat or setting…"
            aria-label="Search commands"
            role="combobox"
            aria-expanded="true"
            autoComplete="off"
            style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'none', fontSize: 16, color: 'rgb(var(--c-ink))' }}
          />
          <kbd>Esc</kbd>
        </div>
        <div ref={listRef} className="pal-list" role="listbox" style={{ maxHeight: '46vh' }}>
          {filtered.length === 0 ? (
            <p className="pop-empty">No results for "{query.trim()}"</p>
          ) : (
            filtered.map((entry, index) => {
              const item = entry.item;
              const showGroup = item.group !== lastGroup;
              lastGroup = item.group;
              return (
                <div key={item.id}>
                  {showGroup ? <p className="pg">{item.group}</p> : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === cursor}
                    data-cursor={index === cursor}
                    onMouseEnter={() => setCursor(index)}
                    onClick={() => item.run()}
                    className={cx('pi', index === cursor && 'sel')}
                  >
                    <span className="pic">{item.icon}</span>
                    <span>
                      <Highlight text={item.label} spans={entry.f?.m ?? null} />
                    </span>
                    {item.hint ? <kbd>{item.hint}</kbd> : null}
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="pal-f">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>Enter</kbd> run
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
