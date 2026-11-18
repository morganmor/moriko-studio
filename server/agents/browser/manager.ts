import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { morikoHome } from '../../paths.js';
import { assertAllowedTarget } from '../spatial-runtime.js';
import { getSharedBrowser } from './engine.js';
import { TAB_CAPTURE_SCRIPT } from './tab-capture.js';

type BrowserContext = import('playwright-core').BrowserContext;
type Page = import('playwright-core').Page;
type FileChooser = import('playwright-core').FileChooser;

export const WS_OPEN = 1;
export const DEFAULT_BROWSER_SESSION = 'default';
export const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const;
export const BROWSER_VIEWPORT = DEFAULT_VIEWPORT;

export function normalizeSessionId(sessionId?: string): string {
  if (typeof sessionId !== 'string') return DEFAULT_BROWSER_SESSION;
  const trimmed = sessionId.trim();
  return trimmed || DEFAULT_BROWSER_SESSION;
}

export function browserProfileDir(): string {
  return path.join(morikoHome, 'browser-profile');
}

function sanitizeSessionPathSegment(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 64) || DEFAULT_BROWSER_SESSION;
}

function clampDimension(val: number, min: number, max: number): number {
  const n = Number.isFinite(val) ? Math.round(val) : min;
  const clamped = Math.min(max, Math.max(min, n));
  return Math.max(min, clamped & ~1);
}

export interface BrowserCursor {
  x: number;
  y: number;
  visible: boolean;
}

export interface DiagnosticEntry {
  ts: number;
  kind: 'console' | 'pageerror' | 'http';
  text: string;
}

export interface PanelSubscriber {
  readonly readyState: number;
  send(data: string): void;
}

export interface BrowserTab {
  id: string;
  page: Page;
  loading: boolean;
}

export interface PendingDialogView {
  id: string;
  dialogType: string;
  message: string;
  defaultValue: string;
}

export interface PendingFileChooserView {
  id: string;
  multiple: boolean;
}

export interface BrowserDownloadEntry {
  id: string;
  filename: string;
  path: string;
  size: number;
  url: string;
  ts: number;
  status: 'done' | 'failed';
  error?: string;
}

export interface BrowserSession {
  sessionId: string;
  context: BrowserContext;
  tabs: Map<string, BrowserTab>;
  activeTabId: string;
  nextTabNumber: number;
}

interface SessionState {
  sessionId: string;
  context: BrowserContext | null;
  ensuring: Promise<BrowserSession> | null;
  tabs: Map<string, BrowserTab>;
  activeTabId: string;
  nextTabNumber: number;
  internalPageCreates: number;
  knownPages: WeakSet<Page>;
  signalingReadyPages: WeakSet<Page>;
  viewport: { width: number; height: number };
  windowInset: { w: number; h: number } | null;
  screenInfo: { width: number; height: number; dpr: number } | null;
  cursor: BrowserCursor;
  userCursor: { x: number; y: number; visible: boolean };
  annotations: Array<{ type: 'rect'; x: number; y: number; w: number; h: number; ts: number }>;
  diagBuffer: DiagnosticEntry[];
  lastActionTs: number;
  dialogPolicy: { action: 'accept' | 'dismiss' | 'default'; text?: string } | null;
  pendingDialog: {
    id: string;
    dialogType: string;
    message: string;
    defaultValue: string;
    resolve: (res: { accept: boolean; text?: string }) => void;
  } | null;
  pendingFileChooser: {
    id: string;
    multiple: boolean;
    chooser: FileChooser;
  } | null;
  downloads: Map<string, BrowserDownloadEntry>;
  agentDownloadDepth: number;
  domCache: Map<string, { url: string; ts: number; value: unknown }>;
  auditLog: Array<{ ts: number; action: string; detail: string }>;
  watchSnapshots: Map<string, { html: string; text: string; cls: string; exists: boolean } | null>;
  activeRecording: {
    name: string;
    startedAt: number;
    lastTs: number;
    steps: Array<Record<string, unknown>>;
  } | null;
  subscribers: Set<PanelSubscriber>;
  takeoverActive: boolean;
  takeoverBy: string;
  handoverMessage: string;
  agentAbortControllers: Set<AbortController>;
  mouseButtonsDown: Set<'left' | 'right' | 'middle'>;
  inputChain: Promise<void>;
  pendingMove: { x: number; y: number } | null;
  moveLoopActive: boolean;
  pendingScroll: { deltaX: number; deltaY: number } | null;
  scrollLoopActive: boolean;
}

function matchHostGlob(host: string, pattern: string): boolean {
  const clean = pattern.trim().toLowerCase();
  if (!clean) return false;
  const escaped = clean
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(host.toLowerCase());
}

class BrowserManager {
  private static readonly DIAG_CAP = 80;
  private static readonly DOM_CACHE_TTL_MS = 10_000;
  private static readonly AUDIT_CAP = 200;

  private sessions = new Map<string, SessionState>();
  private webAccessBySession = new Map<string, boolean>();
  private domainPolicy: { allow?: string[]; block?: string[] } | null = null;
  private storedScripts: Array<{ name: string; matches: string; script: string }> | null = null;

  private retargetCapture: ((sessionId: string) => Promise<void>) | null = null;
  private resizeCapture: ((sessionId: string, width: number, height: number) => Promise<void>) | null = null;
  private signalingSink: ((msg: Record<string, unknown>) => void) | null = null;
  private stopTransportSession: ((sessionId: string) => Promise<void>) | null = null;

  constructor() {
    this.loadDomainPolicy();
  }

  private getOrCreateState(sessionId?: string): SessionState {
    const sid = normalizeSessionId(sessionId);
    let state = this.sessions.get(sid);
    if (!state) {
      state = {
        sessionId: sid,
        context: null,
        ensuring: null,
        tabs: new Map(),
        activeTabId: '',
        nextTabNumber: 1,
        internalPageCreates: 0,
        knownPages: new WeakSet(),
        signalingReadyPages: new WeakSet(),
        viewport: { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height },
        windowInset: null,
        screenInfo: null,
        cursor: { x: 0, y: 0, visible: false },
        userCursor: { x: 0, y: 0, visible: false },
        annotations: [],
        diagBuffer: [],
        lastActionTs: Date.now(),
        dialogPolicy: null,
        pendingDialog: null,
        pendingFileChooser: null,
        downloads: new Map(),
        agentDownloadDepth: 0,
        domCache: new Map(),
        auditLog: [],
        watchSnapshots: new Map(),
        activeRecording: null,
        subscribers: new Set(),
        takeoverActive: false,
        takeoverBy: '',
        handoverMessage: '',
        agentAbortControllers: new Set(),
        mouseButtonsDown: new Set(),
        inputChain: Promise.resolve(),
        pendingMove: null,
        moveLoopActive: false,
        pendingScroll: null,
        scrollLoopActive: false,
      };
      this.sessions.set(sid, state);
    }
    return state;
  }

  getViewport(sessionId?: string): { width: number; height: number } {
    return { ...this.getOrCreateState(sessionId).viewport };
  }

  /**
   * Stores reported host window screen metrics without mutating DPR or closing
   * the context; interactive viewports strictly follow DPR 1 and .bp-stage.
   */
  setScreenInfo(info: { width: number; height: number; dpr: number }, sessionId?: string): void {
    const s = this.getOrCreateState(sessionId);
    s.screenInfo = { width: info.width, height: info.height, dpr: 1 };
  }

  getScreenInfo(sessionId?: string): { width: number; height: number; dpr: number } | null {
    return this.getOrCreateState(sessionId).screenInfo;
  }

  private async withPageWindowCdp<T>(
    s: SessionState,
    page: Page,
    fn: (
      cdp: { send: (method: string, params?: Record<string, unknown>) => Promise<unknown> },
      windowId: number,
    ) => Promise<T>,
  ): Promise<T | null> {
    if (page.isClosed() || !s.context) return null;
    try {
      const cdp = (await s.context.newCDPSession(page)) as unknown as {
        send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
        detach: () => Promise<void>;
      };
      try {
        const info = (await cdp.send('Browser.getWindowForTarget')) as { windowId?: number } | undefined;
        if (typeof info?.windowId !== 'number') return null;
        return await fn(cdp, info.windowId);
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    } catch {
      return null;
    }
  }

  /**
   * Matches the page's emulated viewport AND expands the host browser window's
   * outer bounds by the measured chrome/infobar inset so headless capture never
   * clips or aspect-locks the active tab content.
   */
  async syncPageViewportAndBounds(page: Page, sessionId?: string): Promise<void> {
    if (page.isClosed()) return;
    const s = this.getOrCreateState(sessionId);
    const cur = page.viewportSize();
    if (!cur || cur.width !== s.viewport.width || cur.height !== s.viewport.height) {
      await page.setViewportSize(s.viewport).catch(() => undefined);
    }
    if (!s.windowInset || (s.windowInset.w <= 0 && s.windowInset.h <= 0)) return;
    const inset = s.windowInset;
    await this.withPageWindowCdp(s, page, async (cdp, windowId) => {
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: {
          width: s.viewport.width + inset.w,
          height: s.viewport.height + inset.h,
        },
      });
    });
  }

  /**
   * Compares live getDisplayMedia track dimensions against outer BrowserWindow
   * bounds to learn the host chrome + capture-infobar frame inset and expand
   * the window bounds if any axis was clipped.
   */
  async calibrateWindowInsetFromCapture(
    sessionId: string,
    trackW: number,
    trackH: number,
  ): Promise<boolean> {
    if (!(trackW > 0) || !(trackH > 0)) return false;
    const s = this.getOrCreateState(sessionId);
    const active = s.tabs.get(s.activeTabId)?.page;
    if (!active || active.isClosed()) return false;

    const updated = await this.withPageWindowCdp(s, active, async (cdp, windowId) => {
      const res = (await cdp.send('Browser.getWindowBounds', { windowId })) as
        | { bounds?: { width?: number; height?: number } }
        | undefined;
      const bw = Number(res?.bounds?.width) || 0;
      const bh = Number(res?.bounds?.height) || 0;
      if (!(bw > 0) || !(bh > 0)) return false;

      const obsW = bw - trackW;
      const obsH = bh - trackH;
      const prevW = s.windowInset?.w ?? 0;
      const prevH = s.windowInset?.h ?? 0;

      // Ignore implausibly huge deltas (e.g. aspect-locked old stream) so only real window chrome is learned.
      const nextW =
        trackW < s.viewport.width && obsW > prevW && obsW <= 96
          ? obsW
          : prevW;
      const nextH =
        trackH < s.viewport.height && obsH > prevH && obsH <= 240
          ? obsH
          : prevH;

      if (s.windowInset !== null && nextW === prevW && nextH === prevH) {
        return false;
      }
      s.windowInset = { w: nextW, h: nextH };
      if (nextW === 0 && nextH === 0) return false;

      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: {
          width: s.viewport.width + nextW,
          height: s.viewport.height + nextH,
        },
      });
      return nextW !== prevW || nextH !== prevH;
    });

    return updated === true;
  }

  async setViewport(
    width: number,
    height: number,
    sessionId?: string,
  ): Promise<{ width: number; height: number }> {
    const s = this.getOrCreateState(sessionId);
    const w = clampDimension(width, 320, 3840);
    const h = clampDimension(height, 240, 2160);
    const changed = s.viewport.width !== w || s.viewport.height !== h;
    s.viewport = { width: w, height: h };

    const active = s.tabs.get(s.activeTabId)?.page;
    if (active && !active.isClosed()) {
      await this.syncPageViewportAndBounds(active, s.sessionId);
    }
    for (const tab of s.tabs.values()) {
      if (tab.page !== active && !tab.page.isClosed()) {
        void tab.page.setViewportSize(s.viewport).catch(() => undefined);
      }
    }
    if (changed) {
      this.broadcast({ type: 'viewport', width: w, height: h }, s.sessionId);
      if (this.resizeCapture) {
        void this.resizeCapture(s.sessionId, w, h).catch(() => undefined);
      }
    }
    return { width: w, height: h };
  }

  async ensureContext(sessionId?: string): Promise<BrowserSession> {
    const s = this.getOrCreateState(sessionId);
    if (s.context && s.tabs.size > 0) {
      return {
        sessionId: s.sessionId,
        context: s.context,
        tabs: s.tabs,
        activeTabId: s.activeTabId,
        nextTabNumber: s.nextTabNumber,
      };
    }
    if (s.ensuring) return s.ensuring;

    s.ensuring = (async () => {
      const browser = await getSharedBrowser();
      const context = await browser.newContext({
        viewport: { ...s.viewport },
        deviceScaleFactor: 1,
        acceptDownloads: true,
      });

      s.context = context;
      s.tabs.clear();
      s.activeTabId = '';
      s.nextTabNumber = 1;

      for (const entry of this.loadScripts()) {
        await context.addInitScript(this.wrapScript(entry)).catch(() => undefined);
      }

      context.on('page', (popupPage: Page) => {
        if (s.internalPageCreates > 0 || s.knownPages.has(popupPage)) return;
        void this.registerPopupPage(s, popupPage);
      });

      context.on('close', () => {
        if (s.context !== context) return;
        this.cleanupSessionContext(s);
        this.broadcast({ type: 'shutdown', reason: 'closed' }, s.sessionId);
      });

      let firstPage: Page;
      s.internalPageCreates += 1;
      try {
        const existing = context.pages()[0];
        firstPage = existing ?? (await context.newPage());
      } finally {
        s.internalPageCreates = Math.max(0, s.internalPageCreates - 1);
      }

      await firstPage.setViewportSize(s.viewport).catch(() => undefined);
      await this.registerTabPage(s, firstPage, true);

      return {
        sessionId: s.sessionId,
        context,
        tabs: s.tabs,
        activeTabId: s.activeTabId,
        nextTabNumber: s.nextTabNumber,
      };
    })().finally(() => {
      s.ensuring = null;
    });

    return s.ensuring;
  }

  private async registerPopupPage(s: SessionState, popupPage: Page): Promise<void> {
    if (s.knownPages.has(popupPage) || popupPage.isClosed()) return;
    await popupPage.setViewportSize(s.viewport).catch(() => undefined);
    await this.registerTabPage(s, popupPage, true);
    this.notifyTabsChanged(s.sessionId);
    if (this.retargetCapture) {
      await this.retargetCapture(s.sessionId).catch(() => undefined);
    }
  }

  private async registerTabPage(s: SessionState, page: Page, activate: boolean): Promise<BrowserTab> {
    s.knownPages.add(page);
    const id = `tab-${s.nextTabNumber}`;
    s.nextTabNumber += 1;
    const tab: BrowserTab = { id, page, loading: false };
    s.tabs.set(id, tab);
    if (activate || !s.activeTabId) {
      s.activeTabId = id;
    }

    this.attachDiagnostics(s, page, tab);
    await this.ensurePageSignalingReady(s.sessionId, page);

    page.on('close', () => {
      const existed = s.tabs.delete(id);
      if (!existed) return;
      if (s.pendingDialog) {
        s.pendingDialog.resolve({ accept: false });
        const did = s.pendingDialog.id;
        s.pendingDialog = null;
        this.broadcast({ type: 'dialog-closed', id: did }, s.sessionId);
      }
      if (s.activeTabId === id) {
        const next = s.tabs.keys().next().value as string | undefined;
        s.activeTabId = next ?? '';
        if (s.activeTabId && this.retargetCapture) {
          void this.retargetCapture(s.sessionId).catch(() => undefined);
        }
      }
      this.notifyTabsChanged(s.sessionId);
    });

    return tab;
  }

  async ensurePageSignalingReady(sessionId: string, page: Page): Promise<void> {
    const s = this.getOrCreateState(sessionId);
    if (s.signalingReadyPages.has(page) || page.isClosed()) return;
    s.signalingReadyPages.add(page);
    try {
      await page.addInitScript(TAB_CAPTURE_SCRIPT);
      await page.exposeFunction('__morikoRtcSignal', (msg: Record<string, unknown>) => {
        this.emitSignaling(s.sessionId, page, msg);
      }).catch(() => undefined);
      await page.evaluate(TAB_CAPTURE_SCRIPT).catch(() => undefined);
    } catch {
      s.signalingReadyPages.delete(page);
    }
  }

  async getActivePage(sessionId?: string): Promise<Page> {
    const s = this.getOrCreateState(sessionId);
    const session = await this.ensureContext(s.sessionId);
    const current = session.tabs.get(s.activeTabId);
    if (current && !current.page.isClosed()) return current.page;
    const first = session.tabs.values().next().value as BrowserTab | undefined;
    if (first && !first.page.isClosed()) {
      s.activeTabId = first.id;
      return first.page;
    }
    const tab = await this.openInNewTab(s.sessionId);
    return tab.page;
  }

  async getTabPage(tabId: string, sessionId?: string): Promise<Page> {
    const s = this.getOrCreateState(sessionId);
    await this.ensureContext(s.sessionId);
    const tab = s.tabs.get(tabId);
    if (!tab || tab.page.isClosed()) {
      throw new Error(`No tab "${tabId}" exists in session "${s.sessionId}".`);
    }
    return tab.page;
  }

  async openInNewTab(sessionId?: string): Promise<BrowserTab> {
    const s = this.getOrCreateState(sessionId);
    const session = await this.ensureContext(s.sessionId);
    let page: Page;
    s.internalPageCreates += 1;
    try {
      page = await session.context.newPage();
    } finally {
      s.internalPageCreates = Math.max(0, s.internalPageCreates - 1);
    }
    await this.syncPageViewportAndBounds(page, s.sessionId);
    const tab = await this.registerTabPage(s, page, true);
    this.notifyTabsChanged(s.sessionId);
    if (this.retargetCapture) {
      void this.retargetCapture(s.sessionId).catch(() => undefined);
    }
    return tab;
  }

  /**
   * Opens a hidden/ephemeral Playwright Page inside the session context without
   * registering it as a user-visible tab or interrupting the live panel stream.
   */
  async openEphemeralPage(sessionId?: string): Promise<Page> {
    const s = this.getOrCreateState(sessionId);
    const session = await this.ensureContext(s.sessionId);
    s.internalPageCreates += 1;
    try {
      const page = await session.context.newPage();
      await page.setViewportSize(s.viewport).catch(() => undefined);
      return page;
    } finally {
      s.internalPageCreates = Math.max(0, s.internalPageCreates - 1);
    }
  }

  async listTabs(sessionId?: string): Promise<Array<{ id: string; url: string; title: string; active: boolean; loading: boolean }>> {
    const s = this.sessions.get(normalizeSessionId(sessionId));
    if (!s || !s.context) return [];
    const out: Array<{ id: string; url: string; title: string; active: boolean; loading: boolean }> = [];
    for (const tab of s.tabs.values()) {
      if (tab.page.isClosed()) continue;
      const title = await tab.page.title().catch(() => '');
      out.push({
        id: tab.id,
        url: tab.page.url() || 'about:blank',
        title,
        active: tab.id === s.activeTabId,
        loading: tab.loading,
      });
    }
    return out;
  }

  async switchTo(tabId: string, sessionId?: string): Promise<Page> {
    const s = this.getOrCreateState(sessionId);
    await this.ensureContext(s.sessionId);
    const tab = s.tabs.get(tabId);
    if (!tab || tab.page.isClosed()) {
      throw new Error(`No tab "${tabId}" exists.`);
    }
    s.activeTabId = tabId;
    await tab.page.bringToFront().catch(() => undefined);
    await tab.page.setViewportSize(s.viewport).catch(() => undefined);
    this.notifyTabsChanged(s.sessionId);
    if (this.retargetCapture) {
      void this.retargetCapture(s.sessionId).catch(() => undefined);
    }
    return tab.page;
  }

  async closePage(tabId: string, sessionId?: string): Promise<void> {
    const s = this.getOrCreateState(sessionId);
    const tab = s.tabs.get(tabId);
    if (!tab) return;
    s.tabs.delete(tabId);
    const wasActive = s.activeTabId === tabId;
    if (!tab.page.isClosed()) {
      await tab.page.close().catch(() => undefined);
    }
    if (wasActive) {
      const next = s.tabs.keys().next().value as string | undefined;
      s.activeTabId = next ?? '';
    }
    this.notifyTabsChanged(s.sessionId);
    if (wasActive && s.activeTabId && this.retargetCapture) {
      void this.retargetCapture(s.sessionId).catch(() => undefined);
    }
  }

  assertUrl(raw: string, allowPublic = true, sessionId?: string): URL {
    void sessionId;
    const url = assertAllowedTarget(raw, allowPublic);
    const policy = this.domainPolicy;
    if (policy?.block?.some((pat) => matchHostGlob(url.hostname, pat))) {
      throw new Error(`URL blocked by ~/.moriko/browser-policy.json blocklist (${url.hostname}).`);
    }
    if (policy?.allow?.length && !policy.allow.some((pat) => matchHostGlob(url.hostname, pat))) {
      throw new Error(`URL not permitted by ~/.moriko/browser-policy.json allowlist (${url.hostname}).`);
    }
    return url;
  }

  loadDomainPolicy(): void {
    try {
      const file = path.join(morikoHome, 'browser-policy.json');
      if (!fs.existsSync(file)) {
        this.domainPolicy = null;
        return;
      }
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { allow?: unknown; block?: unknown };
      const allow = Array.isArray(parsed.allow)
        ? parsed.allow.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        : undefined;
      const block = Array.isArray(parsed.block)
        ? parsed.block.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        : undefined;
      this.domainPolicy = allow?.length || block?.length ? { allow, block } : null;
    } catch {
      this.domainPolicy = null;
    }
  }

  setDomainPolicy(policy: { allow?: string[]; block?: string[] } | null): void {
    this.domainPolicy = policy;
  }

  getDomainPolicy(): { allow?: string[]; block?: string[] } | null {
    return this.domainPolicy;
  }

  logAction(action: string, detail: string, sessionId?: string): void {
    const s = this.getOrCreateState(sessionId);
    s.lastActionTs = Date.now();
    s.auditLog.push({ ts: s.lastActionTs, action, detail });
    if (s.auditLog.length > BrowserManager.AUDIT_CAP) {
      s.auditLog.splice(0, s.auditLog.length - BrowserManager.AUDIT_CAP);
    }
  }

  getAuditLog(sessionId?: string): Array<{ ts: number; action: string; detail: string }> {
    return [...this.getOrCreateState(sessionId).auditLog];
  }

  private attachDiagnostics(s: SessionState, page: Page, tab: BrowserTab): void {
    page.on('console', (msg: { type(): string; text(): string }) => {
      const type = msg.type();
      if (type === 'error' || type === 'warning') {
        this.pushDiag(s, { kind: 'console', text: `${type}: ${msg.text().slice(0, 300)}` });
      }
    });
    page.on('pageerror', (err: unknown) => {
      this.pushDiag(s, { kind: 'pageerror', text: String(err).slice(0, 300) });
    });
    page.on('dialog', (dialog) => {
      if (s.takeoverActive && s.subscribers.size > 0) {
        if (s.pendingDialog) {
          s.pendingDialog.resolve({ accept: false });
          const oldId = s.pendingDialog.id;
          s.pendingDialog = null;
          this.broadcast({ type: 'dialog-closed', id: oldId }, s.sessionId);
        }
        const id = crypto.randomUUID().slice(0, 12);
        const dialogType = dialog.type();
        const message = dialog.message().slice(0, 1000);
        const defaultValue = dialog.defaultValue().slice(0, 400);
        void new Promise<{ accept: boolean; text?: string }>((resolve) => {
          s.pendingDialog = { id, dialogType, message, defaultValue, resolve };
          this.broadcast(
            { type: 'dialog-open', id, dialogType, message, defaultValue },
            s.sessionId,
          );
        })
          .then(async (decision) => {
            if (decision.accept) {
              await dialog.accept(decision.text);
            } else {
              await dialog.dismiss();
            }
          })
          .catch(() => {
            void dialog.dismiss().catch(() => undefined);
          });
        return;
      }

      const p = s.dialogPolicy;
      const summary = `dialog ${dialog.type()}: "${dialog.message().slice(0, 120)}" → ${p?.action === 'accept' ? 'accepted' : p?.action === 'dismiss' ? 'dismissed' : 'dismissed (default)'}`;
      this.pushDiag(s, { kind: 'console', text: summary });
      void (p?.action === 'accept' ? dialog.accept(p.text) : dialog.dismiss()).catch(() => undefined);
    });

    page.on('filechooser', (chooser) => {
      if (!s.takeoverActive || s.subscribers.size === 0) return;
      const id = crypto.randomUUID().slice(0, 12);
      s.pendingFileChooser = { id, multiple: chooser.isMultiple(), chooser };
      this.broadcast({ type: 'file-chooser', id, multiple: chooser.isMultiple() }, s.sessionId);
    });

    page.on('download', (download) => {
      if (s.agentDownloadDepth > 0) return;
      void this.captureUserDownload(s, download);
    });

    page.on('response', (res: { status(): number; url(): string }) => {
      if (res.status() >= 400) {
        this.pushDiag(s, { kind: 'http', text: `HTTP ${res.status()} ${res.url().slice(0, 200)}` });
      }
    });

    page.on('request', (req) => {
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
        tab.loading = true;
        if (s.activeTabId === tab.id) {
          this.broadcast({ type: 'nav-state', loading: true, url: page.url() }, s.sessionId);
        }
      }
    });

    const markIdle = () => {
      if (!tab.loading) return;
      tab.loading = false;
      this.notifyTabsChanged(s.sessionId);
      if (s.activeTabId === tab.id) {
        this.broadcast({ type: 'nav-state', loading: false, url: page.url() }, s.sessionId);
      }
    };
    page.on('load', markIdle);
    page.on('domcontentloaded', () => {
      this.notifyTabsChanged(s.sessionId);
    });

    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      this.notifyTabsChanged(s.sessionId);
      if (s.activeTabId === tab.id) {
        this.broadcast({ type: 'nav-state', loading: tab.loading, url: page.url() }, s.sessionId);
      }
      if (this.signalingSink) {
        this.signalingSink({ type: '__pageNavigated', __page: page, __sessionId: s.sessionId });
      }
    });
  }

  private async captureUserDownload(
    s: SessionState,
    download: import('playwright-core').Download,
  ): Promise<void> {
    const id = crypto.randomUUID().slice(0, 12);
    const rawName = download.suggestedFilename() || 'download.bin';
    const filename = rawName.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'download.bin';
    const dir = path.join(morikoHome, 'browser-downloads', sanitizeSessionPathSegment(s.sessionId));
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${id}-${filename}`);
    const url = download.url();
    try {
      await download.saveAs(target);
      const size = fs.existsSync(target) ? fs.statSync(target).size : 0;
      const entry: BrowserDownloadEntry = {
        id,
        filename,
        path: target,
        size,
        url,
        ts: Date.now(),
        status: 'done',
      };
      s.downloads.set(id, entry);
      this.broadcast(
        {
          type: 'download-complete',
          id,
          filename,
          size,
          url,
          downloadUrl: `/api/agent/browser/download/${encodeURIComponent(s.sessionId)}/${encodeURIComponent(id)}`,
        },
        s.sessionId,
      );
    } catch (error) {
      const entry: BrowserDownloadEntry = {
        id,
        filename,
        path: target,
        size: 0,
        url,
        ts: Date.now(),
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
      s.downloads.set(id, entry);
      this.broadcast(
        {
          type: 'download-failed',
          id,
          filename,
          error: entry.error,
        },
        s.sessionId,
      );
    }
  }

  beginAgentDownload(sessionId?: string): () => void {
    const s = this.getOrCreateState(sessionId);
    s.agentDownloadDepth += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      s.agentDownloadDepth = Math.max(0, s.agentDownloadDepth - 1);
    };
  }

  getDownload(downloadId: string, sessionId?: string): BrowserDownloadEntry | undefined {
    return this.sessions.get(normalizeSessionId(sessionId))?.downloads.get(downloadId);
  }

  respondToDialog(
    dialogId: string,
    accept: boolean,
    promptText?: string,
    sessionId?: string,
  ): boolean {
    const s = this.getOrCreateState(sessionId);
    if (!s.pendingDialog) return false;
    if (dialogId && s.pendingDialog.id !== dialogId) return false;
    const pending = s.pendingDialog;
    s.pendingDialog = null;
    pending.resolve({ accept, text: promptText });
    this.broadcast({ type: 'dialog-closed', id: pending.id }, s.sessionId);
    return true;
  }

  async uploadFileChooser(
    chooserId: string,
    files: Array<{ name: string; mimeType?: string; bufferBase64: string }>,
    sessionId?: string,
  ): Promise<void> {
    const s = this.getOrCreateState(sessionId);
    const pending = s.pendingFileChooser;
    if (!pending || (chooserId && pending.id !== chooserId)) return;
    s.pendingFileChooser = null;
    const payload = files.slice(0, 10).map((f) => ({
      name: String(f.name || 'file.bin').slice(0, 180),
      mimeType: String(f.mimeType || 'application/octet-stream'),
      buffer: Buffer.from(f.bufferBase64, 'base64'),
    }));
    await pending.chooser.setFiles(payload);
    this.broadcast({ type: 'file-chooser-closed', id: pending.id }, s.sessionId);
  }

  async cancelFileChooser(chooserId: string, sessionId?: string): Promise<void> {
    const s = this.getOrCreateState(sessionId);
    const pending = s.pendingFileChooser;
    if (!pending || (chooserId && pending.id !== chooserId)) return;
    s.pendingFileChooser = null;
    await pending.chooser.setFiles([]).catch(() => undefined);
    this.broadcast({ type: 'file-chooser-closed', id: pending.id }, s.sessionId);
  }

  /**
   * Attaches the DOM MutationObserver ONLY on-demand when browser_watch runs,
   * eliminating continuous background DOM overhead on regular pages.
   */
  async enableWatchObserver(page: Page, selector?: string): Promise<void> {
    if (page.isClosed()) return;
    await page.evaluate(
      `((sel) => {
        try {
          if (typeof globalThis.__morikoMutationsStop === 'function') {
            globalThis.__morikoMutationsStop();
          }
          const target = (sel ? document.querySelector(sel) : null) || document.documentElement;
          if (!target) return;
          const state = { count: 0, lastText: '' };
          globalThis.__morikoMutations = state;
          const obs = new MutationObserver((muts) => {
            state.count += muts.length;
            for (const m of muts) {
              if (m.addedNodes && m.addedNodes.length) {
                state.lastText = (m.addedNodes[0].textContent || '').trim().slice(0, 120);
              }
            }
          });
          obs.observe(target, { childList: true, subtree: true, characterData: true });
          globalThis.__morikoMutationsStop = () => {
            try { obs.disconnect(); } catch {}
            delete globalThis.__morikoMutationsStop;
          };
        } catch {}
      })(${JSON.stringify(selector ?? '')})`,
    ).catch(() => undefined);
  }

  async disableWatchObserver(page: Page): Promise<void> {
    if (page.isClosed()) return;
    await page.evaluate(
      `(() => {
        try {
          if (typeof globalThis.__morikoMutationsStop === 'function') {
            globalThis.__morikoMutationsStop();
          }
          delete globalThis.__morikoMutations;
        } catch {}
      })()`,
    ).catch(() => undefined);
  }

  private pushDiag(s: SessionState, entry: { kind: 'console' | 'pageerror' | 'http'; text: string }): void {
    s.diagBuffer.push({ ts: Date.now(), ...entry });
    if (s.diagBuffer.length > BrowserManager.DIAG_CAP) {
      s.diagBuffer.splice(0, s.diagBuffer.length - BrowserManager.DIAG_CAP);
    }
  }

  getDiagnostics(
    sinceTs?: number,
    sessionId?: string,
  ): {
    sinceTs: number;
    console: Array<{ ts: number; text: string }>;
    pageErrors: Array<{ ts: number; text: string }>;
    http: Array<{ ts: number; text: string }>;
  } {
    const s = this.getOrCreateState(sessionId);
    const since = sinceTs ?? s.lastActionTs;
    const pick = (kind: DiagnosticEntry['kind']) =>
      s.diagBuffer.filter((e) => e.ts >= since && e.kind === kind).map((e) => ({ ts: e.ts, text: e.text }));
    return {
      sinceTs: since,
      console: pick('console'),
      pageErrors: pick('pageerror'),
      http: pick('http'),
    };
  }

  setDialogPolicy(
    policy: { action: 'accept' | 'dismiss' | 'default'; text?: string } | null,
    sessionId?: string,
  ): void {
    this.getOrCreateState(sessionId).dialogPolicy = policy;
  }

  getDialogPolicy(sessionId?: string): { action: 'accept' | 'dismiss' | 'default'; text?: string } | null {
    return this.getOrCreateState(sessionId).dialogPolicy;
  }

  moveUserCursor(x: number, y: number, sessionId?: string): void {
    const s = this.getOrCreateState(sessionId);
    s.userCursor = { x, y, visible: true };
    this.broadcast({ type: 'userCursor', x: s.userCursor.x, y: s.userCursor.y, visible: true }, s.sessionId);
  }

  getUserCursor(sessionId?: string): { x: number; y: number; visible: boolean } {
    return { ...this.getOrCreateState(sessionId).userCursor };
  }

  pushAnnotation(a: { x: number; y: number; w: number; h: number }, sessionId?: string): void {
    const s = this.getOrCreateState(sessionId);
    s.annotations.push({ type: 'rect', ...a, ts: Date.now() });
    if (s.annotations.length > 50) s.annotations.shift();
  }

  takeAnnotations(sessionId?: string): Array<{ type: 'rect'; x: number; y: number; w: number; h: number; ts: number }> {
    const s = this.getOrCreateState(sessionId);
    return s.annotations.splice(0, s.annotations.length);
  }

  getCachedDom<T>(key: string, url: string, sessionId?: string): T | undefined {
    const s = this.getOrCreateState(sessionId);
    const hit = s.domCache.get(key);
    if (!hit) return undefined;
    if (hit.url !== url || Date.now() - hit.ts > BrowserManager.DOM_CACHE_TTL_MS) {
      s.domCache.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  putCachedDom(key: string, url: string, value: unknown, sessionId?: string): void {
    const s = this.getOrCreateState(sessionId);
    s.domCache.set(key, { url, ts: Date.now(), value });
  }

  invalidateDomCache(sessionId?: string): void {
    this.getOrCreateState(sessionId).domCache.clear();
  }

  private scriptsFile(): string {
    return path.join(morikoHome, 'browser-scripts.json');
  }

  private loadScripts(): Array<{ name: string; matches: string; script: string }> {
    if (this.storedScripts) return this.storedScripts;
    try {
      const file = this.scriptsFile();
      if (!fs.existsSync(file)) {
        this.storedScripts = [];
        return this.storedScripts;
      }
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      this.storedScripts = Array.isArray(parsed)
        ? parsed.filter(
            (x): x is { name: string; matches: string; script: string } =>
              Boolean(x) &&
              typeof (x as { name?: unknown }).name === 'string' &&
              typeof (x as { matches?: unknown }).matches === 'string' &&
              typeof (x as { script?: unknown }).script === 'string',
          )
        : [];
      return this.storedScripts;
    } catch {
      this.storedScripts = [];
      return this.storedScripts;
    }
  }

  private saveScripts(): void {
    fs.mkdirSync(morikoHome, { recursive: true });
    fs.writeFileSync(this.scriptsFile(), JSON.stringify(this.storedScripts ?? [], null, 2), 'utf8');
  }

  private wrapScript(entry: { matches: string; script: string }): string {
    return `(() => {
      try {
        const pattern = ${JSON.stringify(entry.matches)};
        const escaped = pattern.replace(/[.+?^\${}()|[\\]\\\\]/g, '\\\\$&').replace(/\\*/g, '.*');
        if (!new RegExp('^' + escaped + '$', 'i').test(location.href)) return;
        ${entry.script}
      } catch {}
    })();`;
  }

  async installScript(
    entry: { name: string; matches: string; script: string },
    sessionId?: string,
  ): Promise<void> {
    const list = this.loadScripts();
    const idx = list.findIndex((x) => x.name === entry.name);
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
    this.storedScripts = list;
    this.saveScripts();
    const sid = normalizeSessionId(sessionId);
    const s = this.sessions.get(sid);
    if (s?.context) {
      await s.context.addInitScript(this.wrapScript(entry)).catch(() => undefined);
    }
  }

  listScripts(): Array<{ name: string; matches: string; script: string }> {
    return [...this.loadScripts()];
  }

  removeScript(name: string): boolean {
    const list = this.loadScripts();
    const before = list.length;
    this.storedScripts = list.filter((x) => x.name !== name);
    if (this.storedScripts.length === before) return false;
    this.saveScripts();
    return true;
  }

  private macrosDir(): string {
    return path.join(morikoHome, 'browser-macros');
  }

  startRecording(name: string, sessionId?: string): void {
    const s = this.getOrCreateState(sessionId);
    const now = Date.now();
    s.activeRecording = { name, startedAt: now, lastTs: now, steps: [] };
  }

  isRecording(sessionId?: string): boolean {
    return Boolean(this.getOrCreateState(sessionId).activeRecording);
  }

  private pushRecordedStep(s: SessionState, step: Record<string, unknown>): void {
    if (!s.activeRecording) return;
    const now = Date.now();
    const dt = Math.min(5000, Math.max(0, now - s.activeRecording.lastTs));
    s.activeRecording.lastTs = now;
    s.activeRecording.steps.push({ ...step, dt });
  }

  stopRecording(sessionId?: string): { file: string; steps: number } | null {
    const s = this.getOrCreateState(sessionId);
    const rec = s.activeRecording;
    if (!rec) return null;
    s.activeRecording = null;
    const dir = this.macrosDir();
    fs.mkdirSync(dir, { recursive: true });
    const safe = rec.name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60) || 'macro';
    const file = path.join(dir, `${safe}.json`);
    fs.writeFileSync(file, JSON.stringify({ name: rec.name, startedAt: rec.startedAt, steps: rec.steps }, null, 2), 'utf8');
    return { file, steps: rec.steps.length };
  }

  loadMacro(name: string): Array<Record<string, unknown>> | null {
    try {
      const safe = name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60) || 'macro';
      const parsed = JSON.parse(fs.readFileSync(path.join(this.macrosDir(), `${safe}.json`), 'utf8')) as {
        steps?: Array<Record<string, unknown>>;
      };
      return Array.isArray(parsed.steps) ? parsed.steps : null;
    } catch {
      return null;
    }
  }

  registerTransport(hooks: {
    retarget: (sessionId: string) => Promise<void>;
    resize?: (sessionId: string, width: number, height: number) => Promise<void>;
    onSignaling: (msg: Record<string, unknown>) => void;
    stopSession?: (sessionId: string) => Promise<void>;
  }): void {
    this.retargetCapture = hooks.retarget;
    this.resizeCapture = hooks.resize ?? null;
    this.signalingSink = hooks.onSignaling;
    this.stopTransportSession = hooks.stopSession ?? null;
  }

  emitSignaling(sessionId: string, page: Page, msg: Record<string, unknown>): void {
    if (this.signalingSink) {
      this.signalingSink({ ...msg, __page: page, __sessionId: normalizeSessionId(sessionId) });
    }
  }

  private cleanupSessionContext(s: SessionState): void {
    for (const ctrl of s.agentAbortControllers) {
      ctrl.abort(new Error('Browser session closed'));
    }
    s.agentAbortControllers.clear();
    if (s.pendingDialog) {
      s.pendingDialog.resolve({ accept: false });
      s.pendingDialog = null;
    }
    s.pendingFileChooser = null;
    s.context = null;
    s.tabs.clear();
    s.activeTabId = '';
    s.cursor.visible = false;
    s.mouseButtonsDown.clear();
    s.pendingMove = null;
    s.pendingScroll = null;
    s.domCache.clear();
  }

  async close(sessionId?: string): Promise<void> {
    if (sessionId === undefined) {
      for (const sid of [...this.sessions.keys()]) {
        await this.closeSession(sid);
      }
      return;
    }
    await this.closeSession(normalizeSessionId(sessionId));
  }

  async closeSession(sessionId: string): Promise<void> {
    const sid = normalizeSessionId(sessionId);
    const s = this.sessions.get(sid);
    if (!s) return;
    if (this.stopTransportSession) {
      await this.stopTransportSession(sid).catch(() => undefined);
    }
    const ctx = s.context;
    this.cleanupSessionContext(s);
    if (ctx) {
      await ctx.close().catch(() => undefined);
    }
    this.broadcast({ type: 'shutdown', reason: 'closed' }, sid);
  }

  isWebAccessOn(sessionId?: string): boolean {
    const sid = normalizeSessionId(sessionId);
    const val = this.webAccessBySession.get(sid);
    return val !== false;
  }

  async setWebAccess(on: boolean, sessionId?: string): Promise<void> {
    const sid = normalizeSessionId(sessionId);
    this.webAccessBySession.set(sid, on);
    if (!on) {
      await this.closeSession(sid);
    }
  }

  isLive(sessionId?: string): boolean {
    const s = this.sessions.get(normalizeSessionId(sessionId));
    return Boolean(s && s.context && s.tabs.size > 0);
  }

  getCursor(sessionId?: string): BrowserCursor {
    return { ...this.getOrCreateState(sessionId).cursor };
  }

  async moveCursor(x: number, y: number, steps = 1, sessionId?: string): Promise<BrowserCursor> {
    const s = this.getOrCreateState(sessionId);
    const page = await this.getActivePage(s.sessionId);
    const clampedX = Math.max(0, Math.min(s.viewport.width, x));
    const clampedY = Math.max(0, Math.min(s.viewport.height, y));
    await page.mouse.move(clampedX, clampedY, { steps: Math.max(1, steps) });
    s.cursor = { x: clampedX, y: clampedY, visible: true };
    this.broadcast({ type: 'cursorMove', x: clampedX, y: clampedY, visible: true }, s.sessionId);
    return { ...s.cursor };
  }

  hideCursor(sessionId?: string): void {
    const s = this.getOrCreateState(sessionId);
    s.cursor.visible = false;
    this.broadcast({ type: 'cursorMove', x: s.cursor.x, y: s.cursor.y, visible: false }, s.sessionId);
  }

  subscribe(sub: PanelSubscriber, sessionId?: string): void {
    this.getOrCreateState(sessionId).subscribers.add(sub);
  }

  unsubscribe(sub: PanelSubscriber, sessionId?: string): void {
    this.getOrCreateState(sessionId).subscribers.delete(sub);
  }

  subscriberCount(sessionId?: string): number {
    return this.getOrCreateState(sessionId).subscribers.size;
  }

  broadcast(message: Record<string, unknown>, sessionId?: string): void {
    const s = this.sessions.get(normalizeSessionId(sessionId));
    if (!s || s.subscribers.size === 0) return;
    const payload = JSON.stringify(message);
    for (const sub of s.subscribers) {
      if (sub.readyState === WS_OPEN) {
        try {
          sub.send(payload);
        } catch {
        }
      }
    }
  }

  broadcastClick(x: number, y: number, sessionId?: string): void {
    const s = this.getOrCreateState(sessionId);
    const cx = Math.max(0, Math.min(s.viewport.width, x));
    const cy = Math.max(0, Math.min(s.viewport.height, y));
    this.broadcast({ type: 'cursorClick', x: cx, y: cy }, s.sessionId);
  }

  broadcastDrag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    button: 'left' | 'right' | 'middle',
    points?: Array<{ x: number; y: number }>,
    sessionId?: string,
  ): void {
    const s = this.getOrCreateState(sessionId);
    const pts = points ?? [{ x: fromX, y: fromY }, { x: toX, y: toY }];
    this.broadcast({ type: 'cursorDrag', fromX, fromY, toX, toY, button, points: pts }, s.sessionId);
  }

  setWatchSnapshot(
    selector: string,
    snapshot: { html: string; text: string; cls: string; exists: boolean } | null | undefined,
    sessionId?: string,
  ): void {
    const s = this.getOrCreateState(sessionId);
    if (snapshot === undefined) s.watchSnapshots.delete(selector);
    else s.watchSnapshots.set(selector, snapshot);
  }

  listWatched(sessionId?: string): { selector: string; snapshot: { html: string; text: string; cls: string; exists: boolean } | null } | undefined {
    const s = this.getOrCreateState(sessionId);
    const first = s.watchSnapshots.entries().next().value as
      | [string, { html: string; text: string; cls: string; exists: boolean } | null]
      | undefined;
    if (!first) return undefined;
    return { selector: first[0], snapshot: first[1] };
  }

  clearWatchSnapshots(sessionId?: string): void {
    this.getOrCreateState(sessionId).watchSnapshots.clear();
  }

  notifyTabsChanged(sessionId?: string): void {
    const sid = normalizeSessionId(sessionId);
    const s = this.sessions.get(sid);
    if (!s || s.subscribers.size === 0) return;
    void this.listTabs(sid).then((tabs) => {
      this.broadcast(
        {
          type: 'tabList',
          tabs,
          activeTabId: tabs.find((t) => t.active)?.id ?? s.activeTabId,
        },
        sid,
      );
    });
  }

  notifyStatusChanged(sessionId?: string): void {
    const s = this.getOrCreateState(sessionId);
    this.broadcast(
      {
        type: 'statusChange',
        mode: s.takeoverActive ? 'takeover' : 'agent',
        ...(s.takeoverActive ? { by: s.takeoverBy, message: s.handoverMessage } : {}),
      },
      s.sessionId,
    );
  }

  async performDrag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    steps: number,
    button: 'left' | 'right' | 'middle',
    delayMs: number,
    sessionId?: string,
  ): Promise<void> {
    const s = this.getOrCreateState(sessionId);
    const page = await this.getActivePage(s.sessionId);
    const sx = Math.max(0, Math.min(s.viewport.width, fromX));
    const sy = Math.max(0, Math.min(s.viewport.height, fromY));
    const ex = Math.max(0, Math.min(s.viewport.width, toX));
    const ey = Math.max(0, Math.min(s.viewport.height, toY));
    const count = Math.max(1, steps);
    const points: Array<{ x: number; y: number }> = [];

    await page.mouse.move(sx, sy);
    await page.mouse.down({ button });
    s.mouseButtonsDown.add(button);
    try {
      for (let i = 1; i <= count; i += 1) {
        const t = i / count;
        const ix = sx + (ex - sx) * t;
        const iy = sy + (ey - sy) * t;
        await page.mouse.move(ix, iy);
        points.push({ x: ix, y: iy });
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      }
    } finally {
      await page.mouse.up({ button }).catch(() => undefined);
      s.mouseButtonsDown.delete(button);
    }
    s.cursor = { x: ex, y: ey, visible: true };
    this.broadcastDrag(sx, sy, ex, ey, button, [{ x: sx, y: sy }, ...points], s.sessionId);
  }

  async performMouseDown(x: number, y: number, button: 'left' | 'right' | 'middle', sessionId?: string): Promise<void> {
    const s = this.getOrCreateState(sessionId);
    const page = await this.getActivePage(s.sessionId);
    const cx = Math.max(0, Math.min(s.viewport.width, x));
    const cy = Math.max(0, Math.min(s.viewport.height, y));
    await page.mouse.move(cx, cy);
    await page.mouse.down({ button });
    s.mouseButtonsDown.add(button);
    s.cursor = { x: cx, y: cy, visible: true };
    this.broadcast({ type: 'cursorDrag', fromX: cx, fromY: cy, toX: cx, toY: cy, button, points: [{ x: cx, y: cy }], phase: 'down' }, s.sessionId);
  }

  async performMouseUp(
    x: number | undefined,
    y: number | undefined,
    button: 'left' | 'right' | 'middle',
    sessionId?: string,
  ): Promise<void> {
    const s = this.getOrCreateState(sessionId);
    const page = await this.getActivePage(s.sessionId);
    const cx = Math.max(0, Math.min(s.viewport.width, x ?? s.cursor.x));
    const cy = Math.max(0, Math.min(s.viewport.height, y ?? s.cursor.y));
    if (x !== undefined && y !== undefined) await page.mouse.move(cx, cy);
    await page.mouse.up({ button });
    s.mouseButtonsDown.delete(button);
    s.cursor = { x: cx, y: cy, visible: true };
    this.broadcast({ type: 'cursorDrag', fromX: cx, fromY: cy, toX: cx, toY: cy, button, points: [{ x: cx, y: cy }], phase: 'up' }, s.sessionId);
  }

  isMouseDown(sessionId?: string): boolean {
    return this.getOrCreateState(sessionId).mouseButtonsDown.size > 0;
  }

  trackAgentAbort(sessionId?: string, parentSignal?: AbortSignal): { signal: AbortSignal; dispose(): void } {
    const s = this.getOrCreateState(sessionId);
    const controller = new AbortController();
    s.agentAbortControllers.add(controller);
    if (parentSignal) {
      if (parentSignal.aborted) controller.abort(parentSignal.reason);
      else parentSignal.addEventListener('abort', () => controller.abort(parentSignal.reason), { once: true });
    }
    return {
      signal: controller.signal,
      dispose: () => {
        s.agentAbortControllers.delete(controller);
      },
    };
  }

  startTakeover(by = 'user', message = '', sessionId?: string): void {
    const s = this.getOrCreateState(sessionId);
    s.takeoverActive = true;
    s.takeoverBy = by;
    s.handoverMessage = message;
    for (const ctrl of s.agentAbortControllers) {
      ctrl.abort(new Error(`User takeover activated by ${by}`));
    }
    this.broadcast(
      { type: 'statusChange', mode: 'takeover', by: s.takeoverBy, message: s.handoverMessage },
      s.sessionId,
    );
  }

  endTakeover(sessionId?: string): void {
    const s = this.getOrCreateState(sessionId);
    if (s.pendingDialog) {
      const id = s.pendingDialog.id;
      s.pendingDialog.resolve({ accept: false });
      s.pendingDialog = null;
      this.broadcast({ type: 'dialog-closed', id }, s.sessionId);
    }
    if (s.pendingFileChooser) {
      const id = s.pendingFileChooser.id;
      void s.pendingFileChooser.chooser.setFiles([]).catch(() => undefined);
      s.pendingFileChooser = null;
      this.broadcast({ type: 'file-chooser-closed', id }, s.sessionId);
    }
    s.takeoverActive = false;
    s.takeoverBy = '';
    s.handoverMessage = '';
    this.broadcast({ type: 'statusChange', mode: 'agent', message: '' }, s.sessionId);
  }

  isTakeover(sessionId?: string): boolean {
    return this.getOrCreateState(sessionId).takeoverActive;
  }

  getHandoverMessage(sessionId?: string): string {
    return this.getOrCreateState(sessionId).handoverMessage;
  }

  getPendingDialog(sessionId?: string): PendingDialogView | null {
    const d = this.getOrCreateState(sessionId).pendingDialog;
    if (!d) return null;
    return { id: d.id, dialogType: d.dialogType, message: d.message, defaultValue: d.defaultValue };
  }

  getPendingFileChooser(sessionId?: string): PendingFileChooserView | null {
    const fc = this.getOrCreateState(sessionId).pendingFileChooser;
    if (!fc) return null;
    return { id: fc.id, multiple: fc.multiple };
  }

  takeoverNotice(sessionId?: string): string {
    const s = this.getOrCreateState(sessionId);
    return (
      `Browser control is currently with the user (TAKEOVER${s.takeoverBy ? `: ${s.takeoverBy}` : ''}). ` +
      'Refusing automated browser mutations until control is returned (user clicks "Hand Back to Agent" or browser_release is called).'
    );
  }

  private enqueueInput(s: SessionState, fn: () => Promise<void>): Promise<void> {
    const next = s.inputChain.then(fn, fn);
    s.inputChain = next.catch(() => undefined);
    return next;
  }

  /**
   * Latest-Wins mouse movement slot outside serial inputChain so rapid pointer
   * events never queue stale intermediate coordinates or artificial sleeps.
   */
  forwardMouseMove(x: number, y: number, sessionId?: string): void {
    const s = this.getOrCreateState(sessionId);
    if (!s.takeoverActive) return;
    const cx = Math.max(0, Math.min(s.viewport.width, x));
    const cy = Math.max(0, Math.min(s.viewport.height, y));
    s.userCursor = { x: cx, y: cy, visible: true };
    s.pendingMove = { x: cx, y: cy };
    if (s.moveLoopActive) return;
    s.moveLoopActive = true;
    void (async () => {
      try {
        while (s.pendingMove) {
          const target = s.pendingMove;
          s.pendingMove = null;
          const page = await this.getActivePage(s.sessionId).catch(() => null);
          if (!page || page.isClosed()) break;
          await page.mouse.move(target.x, target.y).catch(() => undefined);
        }
      } finally {
        s.moveLoopActive = false;
      }
    })();
  }

  forwardMouseDown(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left', sessionId?: string): Promise<void> {
    const s = this.getOrCreateState(sessionId);
    if (!s.takeoverActive) return Promise.resolve();
    const cx = Math.max(0, Math.min(s.viewport.width, x));
    const cy = Math.max(0, Math.min(s.viewport.height, y));
    s.pendingMove = null;
    return this.enqueueInput(s, async () => {
      const page = await this.getActivePage(s.sessionId);
      await page.mouse.move(cx, cy);
      await page.mouse.down({ button });
      s.mouseButtonsDown.add(button);
      this.pushRecordedStep(s, { type: 'click', x: cx, y: cy, button });
    });
  }

  forwardMouseUp(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left', sessionId?: string): Promise<void> {
    const s = this.getOrCreateState(sessionId);
    if (!s.takeoverActive) return Promise.resolve();
    const cx = Math.max(0, Math.min(s.viewport.width, x));
    const cy = Math.max(0, Math.min(s.viewport.height, y));
    s.pendingMove = null;
    return this.enqueueInput(s, async () => {
      const page = await this.getActivePage(s.sessionId);
      await page.mouse.move(cx, cy);
      await page.mouse.up({ button });
      s.mouseButtonsDown.delete(button);
    });
  }

  async forwardMouseClick(
    x: number,
    y: number,
    button: 'left' | 'right' | 'middle' = 'left',
    sessionId?: string,
  ): Promise<void> {
    const s = this.getOrCreateState(sessionId);
    if (!s.takeoverActive) return;
    const cx = Math.max(0, Math.min(s.viewport.width, x));
    const cy = Math.max(0, Math.min(s.viewport.height, y));
    return this.enqueueInput(s, async () => {
      const page = await this.getActivePage(s.sessionId);
      await page.mouse.move(cx, cy);
      await page.mouse.click(cx, cy, { button });
      this.pushRecordedStep(s, { type: 'click', x: cx, y: cy, button });
    });
  }

  async forwardKeyboardType(text: string, sessionId?: string): Promise<void> {
    const s = this.getOrCreateState(sessionId);
    if (!s.takeoverActive || !text) return;
    return this.enqueueInput(s, async () => {
      const page = await this.getActivePage(s.sessionId);
      await page.keyboard.insertText(text);
      this.pushRecordedStep(s, { type: 'type', text });
    });
  }

  async forwardKeyboardPress(
    key: string,
    modifiers?: { ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean },
    sessionId?: string,
  ): Promise<void> {
    const s = this.getOrCreateState(sessionId);
    if (!s.takeoverActive || !key) return;
    const parts: string[] = [];
    if (modifiers?.ctrlKey) parts.push('Control');
    if (modifiers?.altKey) parts.push('Alt');
    if (modifiers?.shiftKey) parts.push('Shift');
    if (modifiers?.metaKey) parts.push('Meta');
    const chord = parts.length > 0 && !parts.includes(key) ? `${parts.join('+')}+${key}` : key;
    return this.enqueueInput(s, async () => {
      const page = await this.getActivePage(s.sessionId);
      await page.keyboard.press(chord);
      this.pushRecordedStep(s, { type: 'press', key: chord });
    });
  }

  async forwardPaste(text: string, sessionId?: string): Promise<void> {
    const s = this.getOrCreateState(sessionId);
    if (!s.takeoverActive || !text) return;
    return this.enqueueInput(s, async () => {
      const page = await this.getActivePage(s.sessionId);
      await page.keyboard.insertText(text);
      this.pushRecordedStep(s, { type: 'type', text });
    });
  }

  async copySelection(sessionId?: string): Promise<string> {
    const s = this.getOrCreateState(sessionId);
    const page = await this.getActivePage(s.sessionId);
    const text = await page.evaluate(
      `(() => {
        const el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && typeof el.selectionStart === 'number' && typeof el.selectionEnd === 'number') {
          const val = String(el.value || '');
          const sliced = val.slice(el.selectionStart, el.selectionEnd);
          if (sliced) return sliced;
        }
        return String(window.getSelection ? window.getSelection() : '');
      })()`,
    );
    return typeof text === 'string' ? text : '';
  }

  /**
   * Coalescing wheel scroll slot outside serial inputChain so rapid wheel events
   * merge their deltas instead of queuing dozens of Playwright IPC calls.
   */
  async forwardScroll(deltaX: number, deltaY: number, sessionId?: string): Promise<void> {
    const s = this.getOrCreateState(sessionId);
    if (!s.takeoverActive) return;
    if (s.pendingScroll) {
      s.pendingScroll.deltaX += deltaX;
      s.pendingScroll.deltaY += deltaY;
    } else {
      s.pendingScroll = { deltaX, deltaY };
    }
    this.pushRecordedStep(s, { type: 'scroll', deltaX, deltaY });
    if (s.scrollLoopActive) return;
    s.scrollLoopActive = true;
    void (async () => {
      try {
        while (s.pendingScroll) {
          const delta = s.pendingScroll;
          s.pendingScroll = null;
          const page = await this.getActivePage(s.sessionId).catch(() => null);
          if (!page || page.isClosed()) break;
          await page.mouse.wheel(delta.deltaX, delta.deltaY).catch(() => undefined);
        }
      } finally {
        s.scrollLoopActive = false;
      }
    })();
  }

  async navigateBack(sessionId?: string): Promise<void> {
    const page = await this.getActivePage(sessionId);
    await page.goBack({ waitUntil: 'commit', timeout: 15_000 }).catch(() => undefined);
  }

  async navigateForward(sessionId?: string): Promise<void> {
    const page = await this.getActivePage(sessionId);
    await page.goForward({ waitUntil: 'commit', timeout: 15_000 }).catch(() => undefined);
  }

  async reloadPage(sessionId?: string): Promise<void> {
    const page = await this.getActivePage(sessionId);
    await page.reload({ waitUntil: 'commit', timeout: 25_000 }).catch(() => undefined);
  }

  async stopLoading(sessionId?: string): Promise<void> {
    const s = this.getOrCreateState(sessionId);
    const tab = s.tabs.get(s.activeTabId);
    if (!tab || tab.page.isClosed() || !s.context) return;
    const cdp = await s.context.newCDPSession(tab.page).catch(() => null);
    if (cdp) {
      await cdp.send('Page.stopLoading').catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    }
    tab.loading = false;
    this.broadcast({ type: 'nav-state', loading: false, url: tab.page.url() }, s.sessionId);
    this.notifyTabsChanged(s.sessionId);
  }

  async navigateToUrl(rawUrl: string, sessionId?: string): Promise<string> {
    const sid = normalizeSessionId(sessionId);
    const trimmed = rawUrl.trim();
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = this.assertUrl(withScheme, true, sid);
    const page = await this.getActivePage(sid);
    await page.goto(url.toString(), { waitUntil: 'commit', timeout: 30_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
    return page.url();
  }
}

export const browserManager = new BrowserManager();
