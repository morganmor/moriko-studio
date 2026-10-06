import { useEffect, useRef, useState } from 'react';
import {
  Download,
  Menu,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightOpen,
  Pencil,
  Plus,
  Share2,
  Upload,
} from './icons';

import { NoticeCenter, cx } from './ui';
import { useStore } from '../store/useStore';

interface TopBarProps {
  title: string;
  onShare: () => void;
  /** Opens the navigation drawer. Only visible below the md breakpoint. */
  onOpenNav: () => void;
}

/**
 * Inline-editable workspace title.
 *
 * Clicking the title (or its pencil affordance) swaps it for a text input so
 * the open chat can be renamed without leaving the thread — right beside the
 * panel buttons. Enter or blur commits, Escape cancels.
 */
function EditableTitle({ title }: { title: string }) {
  const activeId = useStore((state) => state.activeId);
  const renameConversation = useStore((state) => state.renameConversation);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (activeId && draft.trim() && draft.trim() !== title) {
      renameConversation(activeId, draft);
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
          if (event.key === 'Escape') setEditing(false);
        }}
        aria-label="Rename this chat"
        className={cx(
          'min-w-0 max-w-[min(340px,50vw)] flex-1 rounded-control border border-hairline',
          'bg-elevated px-2 py-1 text-sm font-medium text-ink outline-none',
          'focus:border-accent/60',
        )}
      />
    );
  }

  // Tanpa tooltip — panel "Click to rename this chat" dihapus; ikon pensil
  // (muncul saat hover via group-hover) sudah cukup sebagai affordance.
  return (
    <div className="min-w-0 flex-1">
      <button
        type="button"
        onClick={() => {
          setDraft(title);
          setEditing(true);
        }}
        className={cx(
          'group flex min-w-0 flex-1 items-center gap-1.5 rounded-control px-1 py-1 text-left',
          'transition-colors hover:bg-elevated/60',
        )}
      >
      <span className="truncate text-sm font-medium text-ink">{title}</span>
      <Pencil
        className="h-3 w-3 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100"
        aria-hidden="true"
      />
      </button>
    </div>
  );
}

/**
 * Sticky workspace header.
 *
 * The left edge carries the sidebar toggle (desktop) or the drawer opener
 * (mobile); the right edge mirrors it for Run settings. Only the title area
 * flexes; every control keeps a fixed 36px hit target so the row never
 * reflows as the title grows or a panel toggles.
 */
export function TopBar({ title, onShare, onOpenNav }: TopBarProps) {
  const settingsOpen = useStore((state) => state.settingsOpen);
  const toggleSettings = useStore((state) => state.toggleSettings);
  const sidebarCollapsed = useStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useStore((state) => state.toggleSidebar);
  const newConversation = useStore((state) => state.newConversation);
  const importConversation = useStore((state) => state.importConversation);
  const showNotice = useStore((state) => state.showNotice);
  const view = useStore((state) => state.view);
  const hasActiveChat = useStore((state) => state.activeConversation() !== undefined);
  const notices = useStore((state) => state.notices);
  const noticeHistory = useStore((state) => state.noticeHistory);
  const noticeHistoryExpanded = useStore((state) => state.noticeHistoryExpanded);
  const dismissNotice = useStore((state) => state.dismissNotice);
  const toggleNoticeHistory = useStore((state) => state.toggleNoticeHistory);
  const clearNoticeHistory = useStore((state) => state.clearNoticeHistory);

  /** Only real conversations are renameable — not the static view titles. */
  const editableTitle = view === 'playground' && hasActiveChat;
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * Secondary actions (theme, share, import, export) live in a LEFT drop
   * panel so the header row stays clear for the title and its rename input —
   * the inline rename needs the whole row, and four always-visible icon
   * buttons were crowding it past the truncate point.
   */
  const [dropOpen, setDropOpen] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  /** Closes the drop on any outside click or Escape — the same contract the
   *  modals use. Listeners mount only while open. */
  useEffect(() => {
    if (!dropOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (dropRef.current && !dropRef.current.contains(event.target as Node)) {
        setDropOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDropOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [dropOpen]);

  /** Downloads the ACTIVE conversation as a portable single-chat file. */
  const exportActiveChat = () => {
    const conversation = useStore.getState().activeConversation();
    if (!conversation) return;
    void (async () => {
      const { buildConversationExport, downloadJson, hydrateConversationPayloads } = await import('../lib/api');
      await hydrateConversationPayloads([conversation]);
      const slug =
        conversation.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 40) || 'chat';
      downloadJson(
        `moriko-chat-${slug}-${new Date().toISOString().slice(0, 10)}.json`,
        buildConversationExport(conversation),
      );
      showNotice('export.conversationDone');
    })();
  };

  /** Reads a single-conversation export file and adds it as a NEW thread. */
  const importChatFile = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as {
        kind?: string;
        conversation?: unknown;
      };
      if (parsed.kind !== 'nova-ai-studio-conversation-export') {
        showNotice('export.notConversation');
        return;
      }
      const { sanitizeConversation } = await import('../lib/importExport');
      const conversation = sanitizeConversation(parsed.conversation);
      if (!conversation) {
        showNotice('export.noConversation');
        return;
      }
      importConversation(conversation);
      showNotice('export.imported', { title: conversation.title });
    } catch (error) {
      showNotice('export.importFailed', undefined, {
        detail: error instanceof Error ? error.message : undefined,
      });
    }
  };

  return (
    <header id="moriko-session-bar" className="relative flex h-14 shrink-0 items-center gap-2 px-4">
      {}
      <NoticeCenter
        entries={notices}
        history={noticeHistory}
        expanded={noticeHistoryExpanded}
        onToggleExpanded={toggleNoticeHistory}
        onDismiss={dismissNotice}
        onClearHistory={clearNoticeHistory}
      />
      {}
      <button
        type="button"
        className="icon-button md:hidden"
        onClick={onOpenNav}
        aria-label="Open navigation"
      >
        <Menu className="h-4 w-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        className={cx('icon-button hidden md:inline-flex', !sidebarCollapsed && 'bg-elevated text-ink')}
        onClick={toggleSidebar}
        aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
        aria-pressed={!sidebarCollapsed}
      >
        {sidebarCollapsed ? (
          <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
        ) : (
          <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
        )}
      </button>

      {}
      {editableTitle ? (
        <EditableTitle title={title} />
      ) : (
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{title}</h1>
      )}

      {}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="icon-button"
          onClick={() => newConversation()}
          aria-label="New chat"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </button>

      <div className="mx-1 h-5 w-px bg-hairline" aria-hidden="true" />

      <div ref={dropRef} className="relative">
        <button
          type="button"
          className={cx('icon-button', dropOpen && 'bg-elevated text-ink')}
          onClick={() => setDropOpen((value) => !value)}
          aria-expanded={dropOpen}
          aria-haspopup="menu"
          aria-label="More actions"
        >
          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
        </button>

        {dropOpen ? (
          <div
            role="menu"
            aria-label="More actions"
            className="animate-scale-in absolute right-0 top-full z-50 mt-1 w-52 origin-top-right rounded-card border border-hairline bg-elevated p-1 shadow-popover"
          >
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-sm text-ink transition-colors hover:bg-surface"
              onClick={() => {
                setDropOpen(false);
                onShare();
              }}
            >
              <Share2 className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
              <span>Share this chat</span>
            </button>

            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-sm text-ink transition-colors hover:bg-surface"
              onClick={() => {
                setDropOpen(false);
                fileInputRef.current?.click();
              }}
            >
              <Upload className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
              <span>Import a chat</span>
            </button>

            {view === 'playground' && hasActiveChat ? (
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-sm text-ink transition-colors hover:bg-surface"
                onClick={() => {
                  setDropOpen(false);
                  exportActiveChat();
                }}
              >
                <Download className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                <span>Export this chat</span>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void importChatFile(file);
        }}
      />

      {}
      {!settingsOpen ? (
        <button
          type="button"
          className="icon-button"
          onClick={toggleSettings}
          aria-label="Show configuration"
        >
          <PanelRightOpen className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}
      </div>
    </header>
  );
}
