import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Popover } from './Popover';
import { ChatIcon, DashboardIcon, DIcon, GalleryIcon, HistoryIcon, ProviderIcon, SettingsIcon } from './designIcons';

import { brandCatHeadSvgUrl, brandWordmarkSvgUrl } from '../lib/brandAssets';
import { CommandPalette } from './CommandPalette';
import { Download, Pin } from './icons';
import { isPhantomConversation, isSubSession, useStore } from '../store/useStore';
import { refreshLiveStreamsNow, subscribeLivePolls, type LiveStreamSnapshot } from '../store/livePoller';
import type { Conversation, ViewId } from '../types';
import { storage } from '../lib/storage';
import { resolveTheme } from '../lib/appearance';
import { Tip, cx } from './ui';
import { MobileWatching } from './MobileWatching';
import { AddonHubModal } from './AddonHub';
import { ShortcutsDialog } from './ShortcutsDialog';

interface SidebarProps {
  onOpenProviders: () => void;
  
  onOpenSettings?: () => void;
  
  onBindWorkspace?: () => void;
  
  onNavigate?: () => void;
  
  width?: number;
}

interface NavItemProps {
  icon: React.ReactNode;
  label: string;
  
  subtitle?: string;
  active?: boolean;
  onClick?: () => void;
  trailing?: React.ReactNode;
  
  placeholder?: boolean;
  'aria-expanded'?: boolean;
}

function NavItem({
  icon,
  label,
  subtitle,
  active,
  onClick,
  trailing,
  placeholder,
  ...rest
}: NavItemProps) {
  return (
    <Tip label={placeholder ? 'Coming soon' : undefined} className="nav-tip">
      <button
        type="button"
        onClick={placeholder ? undefined : onClick}
        disabled={placeholder}
        aria-current={active ? 'page' : undefined}
        {...rest}
        className={cx('nav', subtitle ? 'has-sub' : undefined)}
      >
        <span className="nav-ic" aria-hidden="true">
          {icon}
        </span>
        <span className="nav-lbl">
          <span className="nav-lbl-t">{label}</span>
          {subtitle ? <span className="nav-sub">{subtitle}</span> : null}
        </span>
        {trailing}
      </button>
    </Tip>
  );
}


export function SubItem({
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
      className="nav sub"
    >
      <span className="nav-ic" aria-hidden="true">
        {icon}
      </span>
      <span className="nav-lbl">{label}</span>
      {trailing}
    </button>
  );
}


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
    <div className={cx('col', !open && 'shut', className)} aria-hidden={!open}>
      <div className={cx('col-in', contentClassName)}>
        {contentMounted ? children : null}
      </div>
    </div>
  );
}


export function NavGroup({
  icon,
  label,
  subtitle,
  tail,
  active,
  open,
  onToggle,
  count,
  leaf,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  subtitle?: string;
  
  tail?: React.ReactNode;
  active?: boolean;
  open: boolean;
  onToggle: () => void;
  count?: number;
  
  leaf?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <NavItem
        icon={icon}
        label={label}
        subtitle={subtitle}
        active={active}
        onClick={onToggle}
        aria-expanded={leaf ? undefined : open}
        trailing={
          <>
            {tail}
            {!leaf && typeof count === 'number' && count > 0 ? <span className="cnt">{count}</span> : null}
            {!leaf ? <DIcon name="chev-d" className="chev" aria-hidden="true" /> : null}
          </>
        }
      />
      {!leaf ? (
        <CollapseSection open={open} contentClassName="navsub">
          {children}
        </CollapseSection>
      ) : null}
    </div>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="sec-label">{children}</p>
  );
}



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
  
  onSelect: (id: string) => void;
  
  running?: boolean;
  
  menuOpen: boolean;
  onMenuToggle: (id: string) => void;
}) {
  const renameConversation = useStore((state) => state.renameConversation);
  const deleteConversation = useStore((state) => state.deleteConversation);
  const patchConversation = useStore((state) => state.patchConversation);
  const showNotice = useStore((state) => state.showNotice);

  const triggerRef = useRef<HTMLButtonElement>(null);
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
      className={cx('crow', active && 'on')}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && editing) setEditing(false);
      }}
    >
      {editing ? (
        <div className="crow-edit">
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
          />
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => onSelect(conversation.id)}
            aria-current={active ? 'true' : undefined}
            className="crow-t"
          >
            {running ? <span className="spin" aria-hidden="true" /> : null}
            <span className="ct">{conversation.title}</span>
            {conversation.pinned ? <Pin className="pinic" aria-hidden="true" /> : null}
            {running ? <span className="sr-only">generating</span> : null}
          </button>
          <button
            type="button"
            ref={triggerRef}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => onMenuToggle(conversation.id)}
            aria-label={`Chat options for "${conversation.title}"`}
            aria-expanded={menuOpen}
            className="crow-m"
          >
            <DIcon name="more" className="ic" aria-hidden="true" />
          </button>

          <Popover
            open={menuOpen}
            onClose={() => onMenuToggle(conversation.id)}
            anchorRef={triggerRef}
            label={`Options for "${conversation.title}"`}
            placement="right-start"
            width={220}
          >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={startRename}
                    className="mi"
                  >
                    <DIcon name="edit" className="ic" aria-hidden="true" />
                    Rename
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      patchConversation(conversation.id, { pinned: !conversation.pinned });
                      onMenuToggle(conversation.id);
                    }}
                    className="mi"
                  >
                    <Pin className="ic" aria-hidden="true" />
                    {conversation.pinned ? 'Unpin' : 'Pin'}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onMenuToggle(conversation.id);
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
                    }}
                    className="mi"
                  >
                    <Download className="ic" aria-hidden="true" />
                    Export JSON
                  </button>
                  <div className="sep" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onMenuToggle(conversation.id);
                      deleteConversation(conversation.id);
                    }}
                    className="mi danger"
                  >
                    <DIcon name="trash" className="ic" aria-hidden="true" />
                    Delete
                  </button>
          </Popover>
        </>
      )}
    </div>
  );
});


export function Sidebar({ onOpenProviders, onOpenSettings, onNavigate, onBindWorkspace, width }: SidebarProps) {
  const theme = useStore((state) => state.theme);
  const setTheme = useStore((state) => state.setTheme);
  
  const effectiveTheme = resolveTheme(theme);
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
  const galleryImages = useStore((state) => state.galleryImages);
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

  
  const savedSections = storage.loadSidebarSections();
  const [recentOpen, setRecentOpen] = useState(savedSections.recent ?? true);
  
  const [workspaceOpen, setWorkspaceOpen] = useState(savedSections.workspace ?? true);
  const [expandedWorkspaceId, setExpandedWorkspaceId] = useState<string | null>(
    savedSections.expanded ?? null,
  );
  
  const [newChatPickerOpen, setNewChatPickerOpen] = useState(false);
  const newChatPickerRef = useRef<HTMLButtonElement | null>(null);
  
  const [chatOpen, setChatOpen] = useState(savedSections.chat ?? view === 'playground');
  const [imageOpen, setImageOpen] = useState(savedSections.image ?? view === 'imagestudio');
  
  useEffect(() => {
    storage.saveSidebarSections({
      chat: chatOpen,
      image: imageOpen,
      workspace: workspaceOpen,
      recent: recentOpen,
      expanded: expandedWorkspaceId,
    });
  }, [chatOpen, imageOpen, workspaceOpen, recentOpen, expandedWorkspaceId]);
  
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  
  const [paletteOpen, setPaletteOpen] = useState(false);
  
  useEffect(() => {
    const onOpenPalette = () => setPaletteOpen(true);
    window.addEventListener('moriko:open-palette', onOpenPalette);
    return () => window.removeEventListener('moriko:open-palette', onOpenPalette);
  }, []);
  const toggleSidebar = useStore((state) => state.toggleSidebar);
  const sidebarCollapsed = useStore((state) => state.sidebarCollapsed);
  
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  
  const [addonHubOpen, setAddonHubOpen] = useState(false);
  
  useEffect(() => {
    const onOpenShortcuts = () => setShortcutsOpen(true);
    window.addEventListener('moriko:open-shortcuts', onOpenShortcuts);
    return () => window.removeEventListener('moriko:open-shortcuts', onOpenShortcuts);
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if (event.key === '?') {
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
        ) {
          return;
        }
        event.preventDefault();
        setShortcutsOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    void loadImageSessions();
  }, [loadImageSessions]);

  
  const visibleConversations = useMemo(
    () => conversations.filter(
      (conversation) => !isPhantomConversation(conversation) && !isSubSession(conversation),
    ),
    [conversations],
  );

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const sorted = [...visibleConversations].sort(
      (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt,
    );
    if (!query) return sorted;
    return sorted.filter(
      (conversation) =>
        conversation.title.toLowerCase().includes(query) ||
        conversation.turns.some((turn) => turn.content.toLowerCase().includes(query)),
    );
  }, [visibleConversations, searchQuery]);

  
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

  
  const railSm = sidebarCollapsed && width !== undefined;

  return (
    <aside
      className={cx('rail', railSm && 'rail-sm')}
      style={{ width: railSm ? 64 : width ?? 260 }}
    >
      {}
      <div className="rail-full">
      {}
      <div className="brand">
        <span
          className="logo"
          aria-hidden="true"
          style={{ '--img-cat': `url("${brandCatHeadSvgUrl}")` } as React.CSSProperties}
        />
        <span
          className="wm"
          role="img"
          aria-label="Moriko Studio"
          style={{ '--img-wm': `url("${brandWordmarkSvgUrl}")` } as React.CSSProperties}
        />
        <span className="grow" />
      </div>

      {}
      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        className="rsearch"
      >
        <DIcon name="search" className="ic" aria-hidden="true" />
        <span>Search or jump…</span>
        <kbd>Ctrl K</kbd>
      </button>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenSettings={() => {
          setPaletteOpen(false);
          onOpenSettings?.();
        }}
      />

      <nav className="rscroll" aria-label="Main">
        <SectionLabel>Playground</SectionLabel>
        <div>
          {}
          {}
          <NavGroup
            icon={<ChatIcon />}
            label="Chat"
            open={chatOpen}
            onToggle={() => setChatOpen((open) => !open)}
            count={visibleConversations.length}
          >
            <SubItem
              icon={<DIcon name="plus" className="ic" />}
              label="New chat"
              trailing={<kbd>Alt N</kbd>}
              onClick={() => {
                newConversation();
                onNavigate?.();
              }}
            />
            <SubItem
              icon={<HistoryIcon />}
              label="History"
              active={view === 'history'}
              onClick={() => go('history')}
            />
          </NavGroup>

          {}
          {}
          <NavGroup
            icon={<DIcon name="image" className="ic" />}
            label="Image Studio"
            open={imageOpen}
            onToggle={() => setImageOpen((open) => !open)}
            count={imageSessions.length}
          >
            <SubItem
              icon={<DIcon name="wand" className="ic" />}
              label="New session"
              onClick={() => {
                void createImageSession();
                go('imagestudio');
              }}
            />
            <SubItem
              icon={<HistoryIcon />}
              label="Image history"
              active={view === 'imagehistory'}
              onClick={() => go('imagehistory')}
            />
            <SubItem
              icon={<GalleryIcon />}
              label="Gallery"
              active={view === 'gallery'}
              trailing={
                galleryImages.length > 0 ? (
                  <span className="cnt">{galleryImages.length}</span>
                ) : null
              }
              onClick={() => go('gallery')}
            />
          </NavGroup>
        </div>

        {}

        {}
        <div className="sec-row" >
          <button
            type="button"
            onClick={() => setWorkspaceOpen((open) => !open)}
            aria-expanded={workspaceOpen}
            className="sec-label tog"
          >
            <span>Workspace</span>
            <DIcon name="chev-d" className="chev" aria-hidden="true" />
          </button>
          <div className="pop-host">
            <button
              ref={newChatPickerRef}
              type="button"
              onClick={() => setNewChatPickerOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={newChatPickerOpen}
              aria-label="New chat in a workspace"
              className="ib xs"
            >
              <DIcon name="plus" className="ic" aria-hidden="true" />
            </button>
            <Popover
              open={newChatPickerOpen}
              onClose={() => setNewChatPickerOpen(false)}
              anchorRef={newChatPickerRef}
              label="New chat in a workspace"
              placement="bottom-end"
              width={240}
            >
                {agentWorkspaces.length === 0 ? (
                  <p className="ws-empty">
                    No workspaces yet — bind one below or from a chat&rsquo;s workspace pill.
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
                      className="mi"
                    >
                      <DIcon name="folder" className="ic ic-ac" aria-hidden="true" />
                      <span>{workspace.label}</span>
                    </button>
                  ))
                )}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    newConversation();
                    setNewChatPickerOpen(false);
                    onNavigate?.();
                  }}
                  className="mi"
                >
                  <DIcon name="plus" className="ic ic-ac" aria-hidden="true" />
                  <span>No workspace</span>
                </button>
            </Popover>

          </div>
        </div>

        <CollapseSection open={workspaceOpen}>
          {}
          <button
            type="button"
            className="ws-bind"
            onClick={() => {
              onBindWorkspace?.();
              onNavigate?.();
            }}
          >
            <DIcon name="plus" className="ic ic-ac" aria-hidden="true" />
            <span>Bind a folder…</span>
          </button>
          {agentWorkspaces.length === 0 ? (
            <p className="ws-empty">
              No workspaces yet — bind one below.
            </p>
          ) : (
            agentWorkspaces.map((workspace) => {
              const chats = chatsByWorkspace.get(workspace.id) ?? [];
              const expanded = expandedWorkspaceId === workspace.id;
              return (
                <div key={workspace.id} className="ws">
                  {}
                  <div className="ws-row">
                    <button
                      type="button"
                      onClick={() => setExpandedWorkspaceId(expanded ? null : workspace.id)}
                      aria-expanded={expanded}
                      className="ws-h"
                    >
                      <DIcon name="folder" className="ic ic-ac" aria-hidden="true" />
                      <span className="ws-name">{workspace.label}</span>
                      <span className="cnt">{chats.length}</span>
                      <DIcon name="chev-d" className="chev" aria-hidden="true" />
                    </button>
                    {}
                      <button
                        type="button"
                        onClick={() => void handleRemoveWorkspace(workspace.id)}
                        aria-label={`Unregister workspace ${workspace.label}`}
                        className="ws-del"
                      >
                        <DIcon name="trash" className="ic" aria-hidden="true" />
                      </button>
                  </div>
                  <CollapseSection open={expanded} contentClassName="ws-in">
                    {chats.length === 0 ? (
                      <p className="ws-empty">No sessions bound.</p>
                    ) : (
                      chats.map((conversation) => (
                        <RecentItem
                          key={conversation.id}
                          conversation={conversation}
                          active={conversation.id === activeId}
                          running={Boolean(genRunning[conversation.id])}
                          menuOpen={openMenuId === conversation.id}
                          onMenuToggle={handleMenuToggle}
                          onSelect={handleSelect}
                        />
                      ))
                    )}
                  </CollapseSection>
                </div>
              );
            })
          )}
        </CollapseSection>

        {}
        <div className="sec-row">
          <button
            type="button"
            onClick={() => setRecentOpen((open) => !open)}
            aria-expanded={recentOpen}
            className="sec-label tog"
          >
            <span>Recent Chat</span>
            <DIcon name="chev-d" className="chev" aria-hidden="true" />
          </button>
        </div>

        <CollapseSection open={recentOpen}>
          <div className="filter">
            <DIcon name="search" className="ic" aria-hidden="true" />
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Filter chats"
              aria-label="Filter chats"
            />
            {searchQuery ? (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
                className="filter-x"
              >
                <DIcon name="x" className="ic" aria-hidden="true" />
              </button>
            ) : null}
          </div>

          <div className="crow-list">
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
              <p className="ws-empty">
                {searchQuery.trim()
                  ? 'No chats match your search.'
                  : 'Chats appear here once you send a message.'}
              </p>
            ) : null}
          </div>
        </CollapseSection>
      </nav>

      {}
      <div className="rfoot" aria-label="Sidebar footer">
        <Tip label="Settings" align="start" className="sf-item">
          <button
            type="button"
            onClick={() => onOpenSettings?.()}
            aria-label="Settings"
            className="ib"
          >
            <SettingsIcon />
          </button>
        </Tip>

        <Tip label="Provider" align="start" className="sf-item">
          <button
            type="button"
            onClick={() => {
              onOpenProviders();
              onNavigate?.();
            }}
            aria-label="Provider"
            className="ib"
          >
            <ProviderIcon />
          </button>
        </Tip>

        <Tip label="Dashboard" align="start" className="sf-item">
          <button
            type="button"
            onClick={() => go('dashboard')}
            aria-label="Dashboard"
            aria-current={view === 'dashboard' ? 'page' : undefined}
            className="ib"
          >
            <DashboardIcon />
          </button>
        </Tip>

        <Tip label="Addon Hub" align="start" className="sf-item">
          <button
            type="button"
            onClick={() => setAddonHubOpen(true)}
            aria-label="Addon Hub"
            aria-haspopup="dialog"
            className="ib"
          >
            <DIcon name="addon" className="ic" aria-hidden="true" />
          </button>
        </Tip>

        <Tip label={effectiveTheme === 'light' ? 'Night mode' : 'Day mode'} align="start" className="sf-item">
          <button
            type="button"
            onClick={(event) => setTheme(effectiveTheme === 'light' ? 'dark' : 'light', event)}
            aria-label="Toggle day/night theme"
            className="ib theme-tg"
          >
            <DIcon name="sun" className="ic sun" aria-hidden="true" />
            <DIcon name="moon" className="ic moon" aria-hidden="true" />
          </button>
        </Tip>

        <span className="grow" />
        <span className="livechip">
          <span className="ld" aria-hidden="true" />
          <MobileWatching />
        </span>
      </div>
      </div>

      <div className="rail-mini">
        <button
          type="button"
          className="logo"
          aria-label="Expand sidebar"
          onClick={toggleSidebar}
          style={{ '--img-cat': `url("${brandCatHeadSvgUrl}")` } as React.CSSProperties}
        />
        <Tip label="New chat">
          <button
            type="button"
            aria-label="New chat"
            onClick={() => {
              newConversation();
              onNavigate?.();
            }}
            className="ib"
          >
            <DIcon name="plus" className="ic" aria-hidden="true" />
          </button>
        </Tip>
        <Tip label="Search · Ctrl K">
          <button
            type="button"
            aria-label="Search"
            onClick={() => setPaletteOpen(true)}
            className="ib"
          >
            <DIcon name="search" className="ic" aria-hidden="true" />
          </button>
        </Tip>
        <Tip label="History">
          <button
            type="button"
            aria-label="History"
            aria-current={view === 'history' ? 'page' : undefined}
            onClick={() => go('history')}
            className="ib"
          >
            <HistoryIcon />
          </button>
        </Tip>
        <Tip label="Image Studio">
          <button
            type="button"
            aria-label="Image Studio"
            aria-current={view === 'imagestudio' ? 'page' : undefined}
            onClick={() => go('imagestudio')}
            className="ib"
          >
            <DIcon name="image" className="ic" aria-hidden="true" />
          </button>
        </Tip>
        <Tip label="Gallery">
          <button
            type="button"
            aria-label="Gallery"
            aria-current={view === 'gallery' ? 'page' : undefined}
            onClick={() => go('gallery')}
            className="ib"
          >
            <GalleryIcon />
          </button>
        </Tip>
        <span className="grow" />
		<Tip label="Settings">
          <button
            type="button"
            aria-label="Settings"
            onClick={() => onOpenSettings?.()}
            className="ib"
          >
            <SettingsIcon />
          </button>
        </Tip>
		<Tip label="Provider">
		  <button
			type="button"
			aria-label="Provider"
			onClick={() => {
			  onOpenProviders?.();
			  onNavigate?.();
			}}
			className="ib"
		  >
			<ProviderIcon />
		  </button>
		</Tip>
        <Tip label="Dashboard">
          <button
            type="button"
            aria-label="Dashboard"
            aria-current={view === 'dashboard' ? 'page' : undefined}
            onClick={() => go('dashboard')}
            className="ib"
          >
            <DashboardIcon />
          </button>
        </Tip>
        <Tip label={effectiveTheme === 'light' ? 'Night mode' : 'Day mode'}>
          <button
            type="button"
            aria-label="Toggle day/night theme"
            onClick={(event) => setTheme(effectiveTheme === 'light' ? 'dark' : 'light', event)}
            className="ib theme-tg"
          >
            <DIcon name="sun" className="ic sun" aria-hidden="true" />
            <DIcon name="moon" className="ic moon" aria-hidden="true" />
          </button>
        </Tip>
      </div>

      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <AddonHubModal open={addonHubOpen} onClose={() => setAddonHubOpen(false)} />
    </aside>
  );
}
