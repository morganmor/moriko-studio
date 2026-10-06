import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown,
  Database,
  Folder,
  History,
  Image as ImageIcon,
  Images,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings,
  Settings2,
  Sun,
  Moon,
  Trash2,
  X,
} from './icons';

import { brandCatHeadSvgUrl, brandWordmarkSvgUrl } from '../lib/brandAssets';
import { isPhantomConversation, useStore } from '../store/useStore';
import { refreshLiveStreamsNow, subscribeLivePolls, type LiveStreamSnapshot } from '../store/livePoller';
import type { Conversation, ViewId } from '../types';
import { storage } from '../lib/storage';
import { Tip, cx } from './ui';

interface SidebarProps {
  onOpenProviders: () => void;
  /** Opens the workspace preferences dialog (font, theme, data). */
  onOpenSettings?: () => void;
  /** Called after any navigation, so a mobile drawer can close itself. */
  onNavigate?: () => void;
  /** Drag-resizable rail width (device-persisted); 248 default. */
  width?: number;
}

interface NavItemProps {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
  trailing?: React.ReactNode;
  /** Renders the item as a non-interactive placeholder, kept for future use. */
  placeholder?: boolean;
  'aria-expanded'?: boolean;
}

function NavItem({
  icon,
  label,
  active,
  onClick,
  trailing,
  placeholder,
  ...rest
}: NavItemProps) {
  return (
    <Tip label={placeholder ? 'Coming soon' : undefined} className="w-full">
      <button
        type="button"
        onClick={placeholder ? undefined : onClick}
        disabled={placeholder}
        aria-current={active ? 'page' : undefined}
        {...rest}
      className={cx(
        'flex w-full items-center gap-3 rounded-control px-3 py-2 text-left text-sm',
        'transition-colors duration-150',
        active
          ? 'bg-elevated font-medium text-ink'
          : 'text-muted hover:bg-elevated/60 hover:text-ink',
        placeholder && 'cursor-default opacity-40 hover:bg-transparent hover:text-muted',
      )}
    >
      <span className="shrink-0 text-current" aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
      </button>
    </Tip>
  );
}

/** Indented child of a collapsible nav group ("New Chat", "History", …). */
function SubItem({
  icon,
  label,
  active,
  onClick,
  trailing,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
  trailing?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'flex w-full items-center gap-2.5 rounded-control py-2 pl-[42px] pr-3 text-left text-[13px]',
        'transition-colors duration-150',
        active
          ? 'bg-elevated font-medium text-ink'
          : 'text-muted hover:bg-elevated/60 hover:text-ink',
      )}
    >
      <span className="shrink-0 text-current" aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  );
}

/**
 * Height-animated disclosure — the same easing the activity pill uses
 * (grid-rows 0fr→1fr). Content stays mounted ~330ms after close so the
 * collapse eases down instead of snapping shut, then unmounts.
 */
function CollapseSection({
  open,
  className,
  contentClassName,
  children,
}: {
  open: boolean;
  className?: string;
  contentClassName?: string;
  children: React.ReactNode;
}) {
  const [contentMounted, setContentMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setContentMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setContentMounted(false), 330);
    return () => window.clearTimeout(timer);
  }, [open]);

  return (
    <div
      className={cx('grid transition-[grid-template-rows] duration-300 ease-in-out', className)}
      style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      aria-hidden={!open}
    >
      <div className={cx('min-h-0 overflow-hidden', contentClassName)}>
        {contentMounted ? children : null}
      </div>
    </div>
  );
}

/** Expandable nav group: the parent toggles, children render inline below. */
function NavGroup({
  icon,
  label,
  active,
  open,
  onToggle,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <NavItem
        icon={icon}
        label={label}
        active={active}
        onClick={onToggle}
        aria-expanded={open}
        trailing={
          <ChevronDown
            className={cx(
              'h-3.5 w-3.5 shrink-0 text-faint transition-transform duration-200',
              open && 'rotate-180',
            )}
            aria-hidden="true"
          />
        }
      />
      <CollapseSection open={open} className="mt-0.5">
        <div className="space-y-0.5">{children}</div>
      </CollapseSection>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 pb-1.5 pt-5 text-[12px] font-semibold uppercase tracking-wider text-faint">
      {children}
    </p>
  );
}


/**
 * One recent-chat row. Hovering reveals the triple-dots button; the menu lets
 * the user rename the chat inline (input replaces the label) or delete it.
 */
const RecentItem = memo(function RecentItem({
  conversation,
  active,
  onSelect,
  running,
  menuOpen,
  onMenuToggle,
}: {
  conversation: Conversation;
  active: boolean;
  /** Selects this row's conversation — receives the id so a single stable
   *  closure serves every row (the memo only holds while props are equal). */
  onSelect: (id: string) => void;
  /** An agent/AI is actively generating in this conversation right now. */
  running?: boolean;
  /** Owned by the Sidebar — only ONE row's menu may be open at a time. */
  menuOpen: boolean;
  onMenuToggle: (id: string) => void;
}) {
  const renameConversation = useStore((state) => state.renameConversation);
  const deleteConversation = useStore((state) => state.deleteConversation);

  const triggerRef = useRef<HTMLButtonElement>(null);
  /** Viewport anchor captured when the menu opens: the floating menu mounts
   *  BESIDE the row via a body portal, never inside the scrolling list. */
  const [menuAnchor, setMenuAnchor] = useState<{ top: number; left: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(conversation.title);
  const inputRef = useRef<HTMLInputElement>(null);


  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startRename = () => {
    setDraft(conversation.title);
    onMenuToggle(conversation.id);
    setEditing(true);
  };

  const commitRename = () => {
    setEditing(false);
    if (draft.trim() !== conversation.title) {
      renameConversation(conversation.id, draft);
    }
  };

  return (
    <div
      className="group relative"
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && editing) setEditing(false);
      }}
    >
      {editing ? (
        <div className="px-1 py-0.5">
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitRename();
              }
            }}
            aria-label={`Rename chat "${conversation.title}"`}
            className="field px-2 py-1.5 text-[13px]"
          />
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => onSelect(conversation.id)}
            aria-current={active ? 'true' : undefined}
            className={cx(
              'flex w-full items-center gap-2 rounded-control py-2 pl-3 pr-8 text-left text-[13px]',
              'transition-colors duration-150',
              active
                ? 'bg-elevated font-medium text-ink'
                : 'text-muted hover:bg-elevated/60 hover:text-ink',
            )}
          >
            {running ? (
              <Tip label="Agent active — generating in this chat">
              <span
                className="relative flex h-2 w-2 shrink-0"
                aria-hidden="true"
              >
                {}
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
              </span>
              </Tip>
            ) : null}
            <span className="truncate">{conversation.title}</span>
            {running ? (
              <span className="ml-auto flex shrink-0 items-center gap-1 pr-1 text-[10px] font-medium text-accent">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                <span className="sr-only">generating</span>
              </span>
            ) : null}
          </button>
          <button
            type="button"
            ref={triggerRef}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => {
              if (!menuOpen) {
                const rect = triggerRef.current?.getBoundingClientRect();
                setMenuAnchor(rect ? { top: rect.top, left: rect.right + 6 } : null);
              }
              onMenuToggle(conversation.id);
            }}
            aria-label={`Chat options for "${conversation.title}"`}
            aria-expanded={menuOpen}
            className="icon-button absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          >
            <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
          </button>

          {}
          {menuOpen && menuAnchor
            ? createPortal(
                <div
                  role="menu"
                  aria-label={`Options for "${conversation.title}"`}
                  onMouseDown={(event) => event.stopPropagation()}
                  style={{
                    position: 'fixed',
                    left: menuAnchor.left,
                    top: Math.min(menuAnchor.top, window.innerHeight - 96),
                  }}
                  className="z-[70] w-36 rounded-card border border-hairline bg-surface p-1 shadow-popover"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={startRename}
                    className="flex w-full items-center gap-2 rounded-control px-2.5 py-1.5 text-left text-[13px] text-muted transition-colors hover:bg-elevated/60 hover:text-ink"
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    Rename
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onMenuToggle(conversation.id);
                      deleteConversation(conversation.id);
                    }}
                    className="flex w-full items-center gap-2 rounded-control px-2.5 py-1.5 text-left text-[13px] text-danger transition-colors hover:bg-danger/10"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    Delete
                  </button>
                </div>,
                document.body,
              )
            : null}
        </>
      )}
    </div>
  );
});

/**
 * Primary navigation rail.
 *
 * Playground entries are collapsible groups with inline children (matching the
 * requested layout). The NAV itself is the scroll region once every tab is
 * open, so nothing sinks behind the fixed footer; Recent Chat yields (bounded
 * list) while Workspace always shows in full — workspace outranks chat.
 */
export function Sidebar({ onOpenProviders, onOpenSettings, onNavigate, width }: SidebarProps) {
  const theme = useStore((state) => state.theme);
  const setTheme = useStore((state) => state.setTheme);
  const view = useStore((state) => state.view);
  const setView = useStore((state) => state.setView);
  const conversations = useStore((state) => state.conversations);
  const activeId = useStore((state) => state.activeId);
  const genRunning = useStore((state) => state.genRunning);
  const stoppedRuns = useStore((state) => state.stoppedRuns);
  const [serverRunning, setServerRunning] = useState<Record<string, boolean>>({});
  useEffect(() => {
    return subscribeLivePolls((snapshot: LiveStreamSnapshot) => {
      const next: Record<string, boolean> = {};
      for (const conversationId of snapshot.byConversation.keys()) {
        next[conversationId] = true;
      }
      setServerRunning(next);
    });
  }, []);

  const wasRunningRef = useRef<Record<string, boolean>>({});
  useEffect(() => {
    const previous = wasRunningRef.current;
    wasRunningRef.current = genRunning;
    const justStopped = Object.keys(previous).filter((id) => previous[id] && !genRunning[id]);
    if (justStopped.length === 0) return;
    setServerRunning((current) => {
      const next = { ...current };
      for (const id of justStopped) delete next[id];
      return next;
    });
    refreshLiveStreamsNow();
  }, [genRunning]);

  const selectConversation = useStore((state) => state.selectConversation);
  const imageSessions = useStore((state) => state.imageSessions);
  const loadImageSessions = useStore((state) => state.loadImageSessions);
  const agentWorkspaces = useStore((state) => state.agentWorkspaces);
  const showNotice = useStore((state) => state.showNotice);
  const handleSelect = useCallback(
    (id: string) => {
      selectConversation(id);
      onNavigate?.();
    },
    [selectConversation, onNavigate],
  );
  const handleMenuToggle = useCallback(
    (id: string) => setOpenMenuId((current) => (current === id ? null : id)),
    [],
  );
  const newConversation = useStore((state) => state.newConversation);
  const createImageSession = useStore((state) => state.createImageSession);
  const removeAgentWorkspace = useStore((state) => state.removeAgentWorkspace);
  const patchConversation = useStore((state) => state.patchConversation);
  const searchQuery = useStore((state) => state.searchQuery);
  const setSearchQuery = useStore((state) => state.setSearchQuery);

  /**
   * Session bug: workspaces used to pile up with no way to unregister them.
   * Removal unbinds the CHATS first (so grouping stays honest), then drops
   * the registration — the files on disk are never touched.
   */
  const handleRemoveWorkspace = useCallback(
    async (workspaceId: string) => {
      const bound = useStore
        .getState()
        .conversations.filter((entry) => entry.workspaceId === workspaceId);
      for (const conversation of bound) {
        patchConversation(conversation.id, { workspaceId: undefined });
      }
      try {
        await removeAgentWorkspace(workspaceId);
        showNotice('workspace.removed');
      } catch (cause) {
        showNotice(
          'workspace.removeFailed',
          undefined,
          cause instanceof Error ? { detail: cause.message } : undefined,
        );
      }
    },
    [patchConversation, removeAgentWorkspace, showNotice],
  );

  /** DROPDOWN PERSIST (2026-10): open/closed follows the user's LAST
   *  condition across reloads (device ui-state) — hard defaults are first-run
   *  only. Refresh keeps whatever was left open/closed. */
  const savedSections = storage.loadSidebarSections();
  const [recentOpen, setRecentOpen] = useState(savedSections.recent ?? true);
  /** 6A: the Workspace dropdown — chats grouped under their bound workspace. */
  const [workspaceOpen, setWorkspaceOpen] = useState(savedSections.workspace ?? true);
  const [expandedWorkspaceId, setExpandedWorkspaceId] = useState<string | null>(
    savedSections.expanded ?? null,
  );
  /** '+' in the Workspace header: start a chat bound to a picked workspace
   *  WITHOUT switching the active workspace. Closed on outside mousedown. */
  const [newChatPickerOpen, setNewChatPickerOpen] = useState(false);
  const newChatPickerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!newChatPickerOpen) return;
    const close = (event: MouseEvent) => {
      if (newChatPickerRef.current?.contains(event.target as Node)) return;
      setNewChatPickerOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [newChatPickerOpen]);
  /** Collapsible playground groups; start expanded around the active view. */
  const [chatOpen, setChatOpen] = useState(savedSections.chat ?? view === 'playground');
  const [imageOpen, setImageOpen] = useState(savedSections.image ?? view === 'imagestudio');
  /** Save every dropdown's last condition on change (debounced device patch). */
  useEffect(() => {
    storage.saveSidebarSections({
      chat: chatOpen,
      image: imageOpen,
      workspace: workspaceOpen,
      recent: recentOpen,
      expanded: expandedWorkspaceId,
    });
  }, [chatOpen, imageOpen, workspaceOpen, recentOpen, expandedWorkspaceId]);
  /** The recent-chat row menus are Sidebar-owned: only ONE open at a time. */
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  useEffect(() => {
    void loadImageSessions();
  }, [loadImageSessions]);

  useEffect(() => {
    if (!openMenuId) return;
    const close = () => setOpenMenuId(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [openMenuId]);

  /** Chats that actually exist: unused "New chat" phantoms never show. */
  const visibleConversations = useMemo(
    () => conversations.filter((conversation) => !isPhantomConversation(conversation)),
    [conversations],
  );

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const sorted = [...visibleConversations].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!query) return sorted;
    return sorted.filter(
      (conversation) =>
        conversation.title.toLowerCase().includes(query) ||
        conversation.turns.some((turn) => turn.content.toLowerCase().includes(query)),
    );
  }, [visibleConversations, searchQuery]);

  /** 6A: sessions per workspace — the Workspace dropdown's grouping. */
  const chatsByWorkspace = useMemo(() => {
    const map = new Map<string, Conversation[]>();
    for (const workspace of agentWorkspaces) map.set(workspace.id, []);
    for (const conversation of visibleConversations) {
      if (conversation.workspaceId && map.has(conversation.workspaceId)) {
        map.get(conversation.workspaceId)!.push(conversation);
      }
    }
    for (const list of map.values()) list.sort((a, b) => b.updatedAt - a.updatedAt);
    return map;
  }, [agentWorkspaces, visibleConversations]);

  const go = (target: ViewId, options?: { keepDrawer?: boolean }) => {
    setView(target);
    if (!options?.keepDrawer) onNavigate?.();
  };

  return (
    <aside
      className="flex h-full shrink-0 flex-col border-r-0 border-hairline bg-canvas"
      style={{ width: width ?? 248 }}
    >
      {}
      {/* BRAND ROW — fixed px box (the old em-sized box let the cat img
          overflow it at smaller root font sizes), 3px looser gap and a bit
          more vertical air. */}
      <div className="flex items-center gap-3 px-4 pt-5 pb-2 -mb-2">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft"
          aria-hidden="true"
        >
          <img
            src={brandCatHeadSvgUrl}
            alt=""
            draggable={false}
            width={152}
            height={100}
            style={{ aspectRatio: '152 / 100' }}
            className="h-5 w-auto"
          />
        </span>
        <img
          src={brandWordmarkSvgUrl}
          alt="Moriko Studio"
          draggable={false}
          width={42}
          height={9}
          style={{ aspectRatio: '42 / 9' }}
          className="h-5 w-auto"
        />
      </div>

      {}
      <div className="px-3 pb-1" />

      <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto" aria-label="Main">
        <SectionLabel>Playground</SectionLabel>
        <div className="space-y-0.5 px-2">
          {}
          <NavGroup
            icon={<MessageSquare className="h-5 w-5" />}
            label="Chat"
            active={view === 'playground' || view === 'history'}
            open={chatOpen}
            onToggle={() => setChatOpen((open) => !open)}
          >
            <SubItem
              icon={<Plus className="h-5 w-5" />}
              label="New Chat"
              onClick={() => {
                newConversation();
                onNavigate?.();
              }}
            />
            <SubItem
              icon={<History className="h-5 w-5" />}
              label="History"
              active={view === 'history'}
              onClick={() => go('history')}
              trailing={
                visibleConversations.length > 0 ? (
                  <span className="rounded-full bg-elevated px-1.5 py-0.5 text-[10px] tabular-nums text-faint">
                    {visibleConversations.length}
                  </span>
                ) : null
              }
            />
          </NavGroup>

          {}
          <NavGroup
            icon={<ImageIcon className="h-5 w-5" />}
            label="Image Studio"
            active={view === 'imagestudio' || view === 'gallery' || view === 'imagehistory'}
            open={imageOpen}
            onToggle={() => setImageOpen((open) => !open)}
          >
            <SubItem
              icon={<Plus className="h-5 w-5" />}
              label="New Session"
              onClick={() => {
                void createImageSession();
                go('imagestudio');
              }}
            />
            <SubItem
              icon={<History className="h-5 w-5" />}
              label="History"
              active={view === 'imagehistory'}
              onClick={() => go('imagehistory')}
              trailing={
                imageSessions.length > 0 ? (
                  <span className="rounded-full bg-elevated px-1.5 py-0.5 text-[10px] tabular-nums text-faint">
                    {imageSessions.length}
                  </span>
                ) : null
              }
            />
            <SubItem
              icon={<Images className="h-5 w-5" />}
              label="Gallery"
              active={view === 'gallery'}
              onClick={() => go('gallery')}
            />
          </NavGroup>
        </div>

        {}

        {}
        <div className="mt-4 flex items-center pr-3">
          <button
            type="button"
            onClick={() => setWorkspaceOpen((open) => !open)}
            aria-expanded={workspaceOpen}
            className="flex flex-1 items-center gap-1.5 px-5 pb-1.5 text-[12px] font-semibold uppercase tracking-wider text-faint transition-colors hover:text-muted"
          >
            Workspace
            <ChevronDown
              className={cx(
                'h-3 w-3 transition-transform duration-200',
                !workspaceOpen && '-rotate-90',
              )}
              aria-hidden="true"
            />
          </button>
          <div className="relative" ref={newChatPickerRef}>
            <button
              type="button"
              onClick={() => setNewChatPickerOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={newChatPickerOpen}
              aria-label="New chat in a workspace"
              className="icon-button h-5 w-5 text-faint hover:text-ink"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            {newChatPickerOpen ? (
              <div
                role="menu"
                aria-label="New chat in a workspace"
                className="absolute right-0 top-full z-50 mt-1 max-h-[220px] min-w-[190px] overflow-y-auto rounded-control border border-hairline bg-elevated py-1 shadow-popover"
              >
                {agentWorkspaces.length === 0 ? (
                  <p className="px-2.5 py-1.5 text-[11px] leading-snug text-faint">
                    No workspaces registered — bind one from a chat&rsquo;s workspace pill first.
                  </p>
                ) : (
                  agentWorkspaces.map((workspace) => (
                    <button
                      key={workspace.id}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        newConversation({ workspaceId: workspace.id });
                        setNewChatPickerOpen(false);
                        onNavigate?.();
                      }}
                      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-muted transition-colors hover:bg-accent/10 hover:text-ink"
                    >
                      <Folder className="h-3.5 w-3.5 shrink-0 text-accent/80" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{workspace.label}</span>
                    </button>
                  ))
                )}
              </div>
            ) : null}
          </div>
        </div>

        <CollapseSection open={workspaceOpen} className="px-2 pb-3">
          {agentWorkspaces.length === 0 ? (
            <p className="px-3 py-2 text-[11.5px] leading-relaxed text-faint">
              No workspaces yet — bind one from a chat&rsquo;s workspace pill.
            </p>
          ) : (
            agentWorkspaces.map((workspace) => {
              const chats = chatsByWorkspace.get(workspace.id) ?? [];
              const expanded = expandedWorkspaceId === workspace.id;
              return (
                <div key={workspace.id} className="group/ws rounded-control">
                  {}
                  <div className="flex items-center">
                    <button
                      type="button"
                      onClick={() => setExpandedWorkspaceId(expanded ? null : workspace.id)}
                      aria-expanded={expanded}
                      className="flex min-w-0 w-full flex-1 items-center gap-1.5 rounded-control px-3 py-1.5 text-left text-[14px] text-muted transition-colors hover:bg-elevated/60 hover:text-ink"
                    >
                      <ChevronDown
                        className={cx(
                          'h-3 w-3 shrink-0 text-faint transition-transform duration-200',
                          !expanded && '-rotate-90',
                        )}
                        aria-hidden="true"
                      />
                      <Folder className="h-4 w-4 shrink-0 text-accent/80" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate font-medium">{workspace.label}</span>
                      <span className="shrink-0 text-[12px] text-faint">{chats.length}</span>
                    </button>
                    {}
                      <button
                        type="button"
                        onClick={() => void handleRemoveWorkspace(workspace.id)}
                        aria-label={`Unregister workspace ${workspace.label}`}
                        className="icon-button h-6 w-6 mr-1 shrink-0 text-faint opacity-0 transition-opacity hover:text-ink group-hover/ws:opacity-100 focus-visible:opacity-100"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </button>
                  </div>
                  <CollapseSection open={expanded}>
                    <div className="mt-0.5 space-y-0.5 border-l border-hairline pl-3 ml-4">
                      {chats.length === 0 ? (
                        <p className="px-2 py-1 text-[11px] text-faint">No sessions bound.</p>
                      ) : (
                        chats.map((conversation) => (
                          <button
                            key={conversation.id}
                            type="button"
                            onClick={() => handleSelect(conversation.id)}
                            className={cx(
                              'flex w-full items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left text-[14px] transition-colors',
                              conversation.id === activeId
                                ? 'bg-elevated text-ink'
                                : 'text-muted hover:bg-elevated/60 hover:text-ink',
                            )}
                          >
                            <MessageSquare className="h-4 w-4 shrink-0 text-faint" aria-hidden="true" />
                            <span className="min-w-0 flex-1 truncate">{conversation.title || 'Untitled'}</span>
                            {Boolean(genRunning[conversation.id]) ? (
                              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-faint" aria-hidden="true" />
                            ) : null}
                          </button>
                        ))
                      )}
                    </div>
                  </CollapseSection>
                </div>
              );
            })
          )}
        </CollapseSection>

        {}
        <button
          type="button"
          onClick={() => setRecentOpen((open) => !open)}
          aria-expanded={recentOpen}
          className={cx(
            'flex items-center gap-1.5 px-5 pb-1.5 text-[12px] font-semibold uppercase tracking-wider text-faint transition-colors hover:text-muted',
            !workspaceOpen && 'mt-4',
          )}
        >
          Recent Chat
          <ChevronDown
            className={cx(
              'h-3 w-3 transition-transform duration-200',
              !recentOpen && '-rotate-90',
            )}
            aria-hidden="true"
          />
        </button>

        <CollapseSection open={recentOpen}>
          <div className="flex min-h-0 flex-1 flex-col">
            {}
            <div className="px-3 pb-1.5">
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint"
                  aria-hidden="true"
                />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search chats"
                  aria-label="Search recent chats"
                  className={cx(
                    'w-full rounded-control border border-hairline bg-elevated/60 py-1.5 pl-8 text-[14px]',
                    'text-ink outline-none transition-colors placeholder:text-faint focus:border-accent/50',
                    searchQuery ? 'pr-7' : 'pr-2.5',
                  )}
                />
                {searchQuery ? (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    aria-label="Clear search"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-faint transition-colors hover:text-ink"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </div>

            <div className="max-h-[40vh] space-y-0.5 overflow-y-auto px-2 pb-2">
              {filtered.map((conversation) => (
                <RecentItem
                  key={conversation.id}
                  conversation={conversation}
                  active={conversation.id === activeId}
                  running={
                    Boolean(genRunning[conversation.id]) ||
                    (Boolean(serverRunning[conversation.id]) && !stoppedRuns[conversation.id])
                  }
                  menuOpen={openMenuId === conversation.id}
                  onMenuToggle={handleMenuToggle}
                  onSelect={handleSelect}
                />
              ))}
              {filtered.length === 0 ? (
                <p className="px-3 py-2 text-[11.5px] leading-relaxed text-faint">
                  {searchQuery.trim()
                    ? 'No chats match your search.'
                    : 'Chats appear here once you send a message.'}
                </p>
              ) : null}
            </div>
          </div>
        </CollapseSection>
        {!recentOpen ? <div className="flex-1" /> : null}
      </nav>

      {}
      <div
        className="flex shrink-0 items-center gap-2 border-t border-hairline px-3 py-2.5"
        aria-label="Sidebar footer"
      >
        <Tip label="Settings" align="start">
          <button
            type="button"
            onClick={() => onOpenSettings?.()}
            aria-label="Settings"
            className="icon-button h-8 w-8 text-muted transition-colors hover:text-ink"
          >
            <Settings className="h-4.5 w-4.5" aria-hidden="true" />
          </button>
        </Tip>

        <Tip label="Provider" align="start">
          <button
            type="button"
            onClick={() => {
              onOpenProviders();
              onNavigate?.();
            }}
            aria-label="Provider"
            className="icon-button h-8 w-8 text-muted transition-colors hover:text-ink"
          >
            <Database className="h-4.5 w-4.5" aria-hidden="true" />
          </button>
        </Tip>

        <Tip label="Dashboard" align="start">
          <button
            type="button"
            onClick={() => go('dashboard')}
            aria-label="Dashboard"
            className={cx(
              'icon-button h-8 w-8 transition-colors hover:text-ink',
              view === 'dashboard' ? 'text-ink' : 'text-muted',
            )}
          >
            <Settings2 className="h-4.5 w-4.5" aria-hidden="true" />
          </button>
        </Tip>

        <Tip label={theme === 'dark' ? 'Day mode' : 'Night mode'} align="start">
          <button
            type="button"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label="Toggle day/night theme"
            className="icon-button h-8 w-8 text-muted transition-colors hover:text-ink"
          >
            {theme === 'dark' ? (
              <Sun className="h-4.5 w-4.5" aria-hidden="true" />
            ) : (
              <Moon className="h-4.5 w-4.5" aria-hidden="true" />
            )}
          </button>
        </Tip>
      </div>
    </aside>
  );
}
