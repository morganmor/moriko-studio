import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  Bell,
  Check,
  ChevronDown,
  Code2,
  Download,
  Folder,
  MoreHorizontal,
  PanelRightOpen,
  Pencil,
  Plus,
  Share2,
  Trash2,
  Upload,
} from './icons';

import { NoticeCenter, cx } from './ui';
import { DIcon } from './designIcons';
import { Popover } from './Popover';
import { exportUi } from '../lib/exportUi';
import { exportPill } from '../lib/exportPill';
import { useStore } from '../store/useStore';

interface TopBarProps {
  title: string;
  onShare: () => void;
  /** Opens the navigation drawer. Only visible below the md breakpoint. */
  onOpenNav: () => void;
  /** Workspace crumb pill — opens the native folder picker (design topbar). */
  onPickWorkspace: () => void;
  workspaceLabel?: string;
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

  /** Design's More menu / F2 "Rename" — ask the mounted title to start editing. */
  useEffect(() => {
    if (!activeId) return;
    const onRetitle = () => {
      setDraft(title);
      setEditing(true);
    };
    window.addEventListener('moriko:retitle', onRetitle);
    return () => window.removeEventListener('moriko:retitle', onRetitle);
  }, [activeId, title]);

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
        className="title"
        style={{ minWidth: 0, flex: 1, maxWidth: 'min(340px, 50vw)' }}
      />
    );
  }

  return (
    <div style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => {
          setDraft(title);
          setEditing(true);
        }}
        className="title"
        style={{ minWidth: 0, flex: 1, maxWidth: 'min(340px, 50vw)', display: 'flex', alignItems: 'center', gap: 6, textAlign: 'left' }}
      >
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
      <Pencil
        className="ic"
        style={{ width: 12, height: 12, flexShrink: 0, color: 'var(--faint)' }}
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
export function TopBar({ title, onShare, onOpenNav, onPickWorkspace, workspaceLabel }: TopBarProps) {
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
  /** Popovers design: the crumb opens "Move to workspace" over the registry. */
  const activeId = useStore((state) => state.activeId);
  const activeWorkspaceId = useStore((state) => state.activeConversation()?.workspaceId);
  const agentWorkspaces = useStore((state) => state.agentWorkspaces);
  const patchConversation = useStore((state) => state.patchConversation);
  const deleteConversation = useStore((state) => state.deleteConversation);
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const wsMenuRef = useRef<HTMLDivElement>(null);

  /** Only real conversations are renameable — not the static view titles. */
  const editableTitle = view === 'playground' && hasActiveChat;
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** The bell anchors BOTH the transient notice stack and the Notices popover. */
  const bellRef = useRef<HTMLButtonElement>(null);

  /**
   * Secondary actions (theme, share, import, export) live in a LEFT drop
   * panel so the header row stays clear for the title and its rename input —
   * the inline rename needs the whole row, and four always-visible icon
   * buttons were crowding it past the truncate point.
   */
  const [dropOpen, setDropOpen] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  /** The palette's "Import chats" action reaches the picker via this event. */
  useEffect(() => {
    const onImportChat = () => fileInputRef.current?.click();
    window.addEventListener('moriko:import-chat', onImportChat);
    return () => window.removeEventListener('moriko:import-chat', onImportChat);
  }, []);

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
      if (parsed.kind !== 'moriko-conversation-export') {
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
    <header id="moriko-session-bar" className="topbar">
      {}
      <NoticeCenter
        entries={notices}
        history={noticeHistory}
        expanded={noticeHistoryExpanded}
        anchorRef={bellRef}
        onToggleExpanded={toggleNoticeHistory}
        onDismiss={dismissNotice}
        onClearHistory={clearNoticeHistory}
      />
      {/* Single sidebar toggle (design .ib.sm + DIcon panel-l): opens the
          drawer below md, toggles the desktop sidebar at md and up. */}
      <button
        type="button"
        data-demo-toggle="rail"
        className={cx('ib sm', !sidebarCollapsed && 'on')}
        onClick={() => {
          if (window.matchMedia('(min-width: 768px)').matches) {
            toggleSidebar();
          } else {
            onOpenNav();
          }
        }}
        aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
        aria-pressed={!sidebarCollapsed}
      >
        <DIcon name="panel-l" className="ic" aria-hidden="true" />
      </button>

      {}
      {editableTitle ? (
        <EditableTitle title={title} />
      ) : (
        <h1 style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 15, fontWeight: 600, color: 'rgb(var(--c-ink))' }}>{title}</h1>
      )}

      {}
      <div ref={wsMenuRef} style={{ position: 'relative', marginLeft: 4, maxWidth: 220, flexShrink: 0 }}>
        <button
          type="button"
          onClick={() => setWsMenuOpen((value) => !value)}
          title="Move to workspace"
          aria-haspopup="menu"
          aria-expanded={wsMenuOpen}
          className="crumb"
          style={{ maxWidth: 220 }}
        >
          <Folder className="ic" aria-hidden="true" />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{workspaceLabel ?? 'No workspace'}</span>
          <ChevronDown className="ic" aria-hidden="true" />
        </button>
        <Popover
          open={wsMenuOpen}
          onClose={() => setWsMenuOpen(false)}
          anchorRef={wsMenuRef}
          label="Move to workspace"
          placement="bottom-start"
          width={230}
        >
            <p className="pop-h">Move to workspace</p>
            {agentWorkspaces.map((workspace) => (
              <button
                key={workspace.id}
                type="button"
                role="menuitemradio"
                aria-checked={workspace.id === activeWorkspaceId}
                onClick={() => {
                  if (activeId) {
                    patchConversation(activeId, { workspaceId: workspace.id });
                    showNotice('workspace.moved', { label: workspace.label });
                  }
                  setWsMenuOpen(false);
                }}
                className="mi"
              >
                <Folder className="ic" aria-hidden="true" />
                <span>{workspace.label}</span>
                {workspace.id === activeWorkspaceId ? <Check className="ic mck" aria-hidden="true" /> : null}
              </button>
            ))}
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!activeWorkspaceId}
              onClick={() => {
                if (activeId) {
                  patchConversation(activeId, { workspaceId: undefined });
                  showNotice('workspace.moved', { label: 'No workspace' });
                }
                setWsMenuOpen(false);
              }}
              className="mi"
            >
              <span>No workspace</span>
              {!activeWorkspaceId ? <Check className="ic mck" aria-hidden="true" /> : null}
            </button>
            <div className="sep" />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setWsMenuOpen(false);
                onPickWorkspace();
              }}
              className="mi"
            >
              <Folder className="ic" aria-hidden="true" />
              <span>Bind a folder…</span>
            </button>
        </Popover>
      </div>

      {}
      <div style={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: 6 }}>
        <button
          type="button"
          className="ib"
          onClick={() => newConversation()}
          aria-label="New chat"
        >
          <Plus className="ic" aria-hidden="true" />
        </button>

      {}
      <button
        type="button"
        ref={bellRef}
        className="ib bell"
        onClick={toggleNoticeHistory}
        aria-label="Notices"
        aria-haspopup="dialog"
        aria-expanded={noticeHistoryExpanded}
      >
        <Bell className="ic" aria-hidden="true" />
        {notices.length > 0 ? (
          <span className="badge">
            {notices.length}
          </span>
        ) : null}
      </button>

      <div ref={dropRef} style={{ position: 'relative' }}>
        <button
          type="button"
          className={cx('ib', dropOpen && 'on')}
          onClick={() => setDropOpen((value) => !value)}
          aria-expanded={dropOpen}
          aria-haspopup="menu"
          aria-label="More actions"
        >
          <MoreHorizontal className="ic" aria-hidden="true" />
        </button>

        <Popover
          open={dropOpen}
          onClose={() => setDropOpen(false)}
          anchorRef={dropRef}
          label="More actions"
          placement="bottom-end"
          width={220}
        >
            <button
              type="button"
              role="menuitem"
              className="mi"
              onClick={() => {
                setDropOpen(false);
                onShare();
              }}
            >
              <Share2 className="ic" aria-hidden="true" />
              <span>Share this chat</span>
            </button>

            <button
              type="button"
              role="menuitem"
              className="mi"
              onClick={() => {
                setDropOpen(false);
                fileInputRef.current?.click();
              }}
            >
              <Upload className="ic" aria-hidden="true" />
              <span>Import a chat</span>
            </button>

            {view === 'playground' && hasActiveChat ? (
              <button
                type="button"
                role="menuitem"
                className="mi"
                onClick={() => {
                  setDropOpen(false);
                  exportActiveChat();
                }}
              >
                <Download className="ic" aria-hidden="true" />
                <span>Export this chat</span>
              </button>
            ) : null}

            {}
            <button
              type="button"
              role="menuitem"
              className="mi"
              onClick={() => {
                setDropOpen(false);
                void exportUi();
              }}
            >
              <Code2 className="ic" aria-hidden="true" />
              <span>Export UI (HTML)</span>
            </button>

            <button
              type="button"
              role="menuitem"
              className="mi"
              onClick={() => {
                setDropOpen(false);
                void exportPill();
              }}
            >
              <Activity className="ic" aria-hidden="true" />
              <span>Export pill panel (HTML)</span>
            </button>

            <button
              type="button"
              role="menuitem"
              className="mi"
              onClick={() => {
                setDropOpen(false);
                void import('../lib/exportImport').then((module) => module.exportAll());
              }}
            >
              <Download className="ic" aria-hidden="true" />
              <span>Export all chats</span>
            </button>

            <div className="sep" />

            <button
              type="button"
              role="menuitem"
              className="mi"
              onClick={() => {
                setDropOpen(false);
                window.dispatchEvent(new CustomEvent('moriko:retitle'));
              }}
            >
              <Pencil className="ic" aria-hidden="true" />
              <span>Rename</span>
              <kbd>F2</kbd>
            </button>

            <button
              type="button"
              role="menuitem"
              className="mi danger"
              onClick={() => {
                setDropOpen(false);
                const id = useStore.getState().activeId;
                if (id) deleteConversation(id);
              }}
            >
              <Trash2 className="ic" aria-hidden="true" />
              <span>Delete chat</span>
            </button>
        </Popover>
      </div>

      {}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        hidden
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void importChatFile(file);
        }}
      />

      {}
      <button
        type="button"
        className={cx('ib', settingsOpen && 'on')}
        onClick={toggleSettings}
        aria-label="Show configuration"
        aria-expanded={settingsOpen}
      >
        <PanelRightOpen className="ic" aria-hidden="true" />
      </button>
      </div>
    </header>
  );
}
