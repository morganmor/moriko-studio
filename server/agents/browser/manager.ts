/**
 * BrowserManager — persistent built-in browser (layer-1 actuator).
 *
 * ONE long-lived Chromium/Edge context backed by a persistent profile at
 * `~/.moriko/browser-profile/`. Cookies, localStorage, IndexedDB and saved
 * logins all survive across tool calls.
 *
 * - ensureContext()   — launch on first use, reuse afterwards
 * - getActivePage()   — the current tab
 * - openInNewTab() / listTabs() / switchTo() / closePage() — tab management
 * - Cursor state {x, y, visible} — harness cursor driven by page.mouse
 * - WebRTC transport: active tab captures itself; Node relays SDP/ICE only
 * - Takeover mode: startTakeover()/endTakeover()/isTakeover()
 *
 * Safety: URL navigation gated by assertAllowedTarget() (http(s) only).
 * Profile dir lives under ~/.moriko, not inside any workspace.
 */
import fs from 'node:fs';
import path from 'node:path';

import { morikoHome } from '../../paths.js';
import { assertAllowedTarget, loadPlaywright } from '../spatial-runtime.js';
import { TAB_CAPTURE_SCRIPT } from './tab-capture.js';

type BrowserContext = import('playwright-core').BrowserContext;
type Page = import('playwright-core').Page;

/** Minimal send-only view of a WebSocket connection (keeps this file ws-free). */
export interface PanelSubscriber {
  send: (data: string) => void;
  readyState: number;
}
/** readyState === 1 means OPEN on the ws package — mirrored here so the
 *  manager never imports 'ws' directly. */
export const WS_OPEN = 1;

/** Default viewport — the coordinate system the tools document (0,0 top-left).
 *  CSS pixels: Playwright input APIs always work in CSS px, so agent tools,
 *  cursor clamps and tests are INDEPENDENT of the video capture scale.
 *  DEFAULT only — the panel can resize the live viewport at runtime
 *  (setViewport), so always read the CURRENT size via manager.getViewport(). */
export const BROWSER_VIEWPORT = { width: 1920, height: 1080 } as const;

/** Panel DPR → launch deviceScaleFactor, rounded to halves and clamped 1..3
 *  (rounding avoids context churn from fractional DPR jitter). */
function clampDpr(dpr: number): number {
  return Math.min(Math.max(Math.round(dpr * 2) / 2, 1), 3);
}

/** Where the persistent profile lives — survives across sessions/restarts. */
export function browserProfileDir(): string {
  return path.join(morikoHome, 'browser-profile');
}

export interface BrowserCursor {
  x: number;
  y: number;
  visible: boolean;
}

export interface BrowserTab {
  id: string;
  page: Page;
}

interface BrowserSession {
  context: BrowserContext;
  tabs: Map<string, BrowserTab>;
  activeTabId: string;
  /** Monotonic tab counter — stable ids across the session (tab-1, tab-2…). */
  nextTabNumber: number;
}

class BrowserManager {
  private session: BrowserSession | null = null;
  /** Serializes ensureContext() — two concurrent tool calls launch once. */
  private ensuring: Promise<BrowserSession> | null = null;
  private viewport: { width: number; height: number } = { ...BROWSER_VIEWPORT };
  private screenInfo: { width: number; height: number; dpr: number } | null = null;
  /** DPR the running context was launched with — DPR changes need a relaunch. */
  private launchedDpr = 1;

  getViewport(): { width: number; height: number } {
    return { ...this.viewport };
  }

  setScreenInfo(info: { width: number; height: number; dpr: number }): void {
    const dprChanged = clampDpr(info.dpr) !== this.launchedDpr;
    this.screenInfo = info;
    if (dprChanged && this.session) {
      const stale = this.session;
      this.session = null;
      void stale.context.close().catch(() => undefined);
    }
  }
  getScreenInfo(): { width: number; height: number; dpr: number } | null {
    return this.screenInfo;
  }

  /** Resizes the viewport (every tab), clamped to sane bounds. */
  async setViewport(width: number, height: number): Promise<{ width: number; height: number }> {
    const w = Math.min(Math.max(Math.round(width), 320), 3840);
    const h = Math.min(Math.max(Math.round(height), 240), 2160);
    this.viewport = { width: w, height: h };
    const session = await this.ensureContext().catch(() => null);
    if (session) {
      for (const tab of session.tabs.values()) {
        await tab.page.setViewportSize({ width: w, height: h }).catch(() => undefined);
      }
    }
    this.broadcast({ type: 'viewport', width: w, height: h });
    return { ...this.viewport };
  }



  private cursor: BrowserCursor = { x: BROWSER_VIEWPORT.width / 2, y: BROWSER_VIEWPORT.height / 2, visible: false };
  /** Viewport bounds helper — clamps any coordinate into the LIVE viewport. */
  private clampViewport(x: number, y: number): { x: number; y: number } {
    return { x: clamp(x, 0, this.viewport.width), y: clamp(y, 0, this.viewport.height) };
  }
  private subscribers = new Set<PanelSubscriber>();
  private takeoverActive = false;
  private takeoverBy: string | null = null;
  /** Sink for signaling messages emitted by the in-page WebRTC peer —
   *  wired by webrtc.ts (setSignalingSink); fires on EVERY page with the
   *  init script, but only the ACTIVE tab's peer is driven. */
  private signalingSink: ((msg: Record<string, unknown>) => void) | null = null;
  /** Serialized input chain — ops run strictly after the previous; never rejects. */
  private inputChain: Promise<void> = Promise.resolve();
  /** Newest pending mouse-move — coalesces into ONE CDP call per ~8ms burst
   *  so the input chain stays responsive for clicks/scrolls arriving mid-flood. */
  private pendingMove: { x: number; y: number } | null = null;
  private moveFlushTimer: ReturnType<typeof setTimeout> | null = null;


  /** Domain policy — block wins over allow. Empty = unrestricted. */
  private domainPolicy: { allow?: string[]; block?: string[] } | null = null;
  /** WEB ACCESS KILL-SWITCH — true while any conversation allows the agent web
   *  tools; while false the context is never launched and panel sockets get a
   *  permanent shutdown notice (see ws.ts / routes.ts / dispatcher.ts). */
  private webAccessOn = false;
  /** True while a close is in flight — ensuresContext() stays inert until it settles. */
  private closing = false;

  /** Phase 8 — audit trail: every agent browser action appends here
   *  (session-scoped; cleared on close). Bounded so a long session cannot
   *  grow it unbounded. */
  private audit: Array<{ ts: number; action: string; detail: string }> = [];
  private static readonly AUDIT_CAP = 500;

  /**
   * Launches the persistent context on first use; every later call reuses it.
   * Health-checked: a context whose pages() throws is treated as dead and
   * relaunched with the SAME profile dir (cookies survive).
   */
  async ensureContext(): Promise<BrowserSession> {
    if (this.webAccessOn === false) {
      throw new Error('Web access is OFF — the built-in browser is disabled (Configuration → Tools → Web Access).');
    }
    if (this.closing) {
      throw new Error('The built-in browser is shutting down.');
    }
    this.loadDomainPolicy();
    if (this.session && (await this.isHealthy(this.session))) {
      return this.session;
    }
    if (this.session) {
      await this.session.context.close().catch(() => undefined);
      this.session = null;
    }
    if (this.ensuring) return this.ensuring;

    this.ensuring = (async () => {
      const pw = await loadPlaywright();
      if (!pw) {
        throw new Error(
          'playwright-core is not installed. Run: pnpm add -D playwright-core — ' +
          'the built-in browser needs it to drive Edge (channel "msedge").',
        );
      }

      const profileDir = browserProfileDir();
      fs.mkdirSync(profileDir, { recursive: true });
      const launchDpr = clampDpr(this.screenInfo?.dpr ?? 1);

      let context: BrowserContext;
      try {
        context = await pw.chromium.launchPersistentContext(profileDir, {
          channel: 'msedge',
          headless: true,
          viewport: BROWSER_VIEWPORT,
          deviceScaleFactor: launchDpr,
          args: [
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=Translate',
            '--auto-accept-this-tab-capture',
            '--autoplay-policy=no-user-gesture-required',
            '--use-gl=angle',
            '--enable-gpu-rasterization',
          ],
        });
      } catch (error) {
        throw new Error(
          'Could not launch the built-in browser (headless Edge, channel "msedge"). ' +
          'Install Microsoft Edge, or run "npx playwright install chromium" once ' +
          '(downloads ~150 MB) and the browser manager will fall back to it. ' +
          `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      this.launchedDpr = launchDpr;
      const existing = context.pages()[0];
      const firstPage = existing ?? (await context.newPage());
      const session: BrowserSession = {
        context,
        tabs: new Map(),
        activeTabId: '',
        nextTabNumber: 1,
      };
      const tab: BrowserTab = { id: 'tab-1', page: firstPage };
      session.tabs.set(tab.id, tab);
      session.activeTabId = tab.id;
      session.nextTabNumber = 2;
      this.session = session;
      this.attachDiagnostics(firstPage);
      this.attachSignaling(firstPage);
      for (const entry of this.loadScripts()) {
        void session.context.addInitScript(this.wrapScript(entry)).catch(() => undefined);
      }
      return session;
    })();

    try {
      return await this.ensuring;
    } finally {
      this.ensuring = null;
    }
  }

  /** A context is healthy when pages() resolves and reports ≥ 0 pages. */
  private async isHealthy(session: BrowserSession): Promise<boolean> {
    try {
      await session.context.pages();
      return true;
    } catch {
      return false;
    }
  }

  /** The tab every browser_* tool operates on. */
  async getActivePage(): Promise<Page> {
    const session = await this.ensureContext();
    const tab = session.tabs.get(session.activeTabId);
    if (!tab) throw new Error('Active browser tab vanished — call browser_open to recover.');
    return tab.page;
  }

  /** Phase 9 — a SPECIFIC tab's page WITHOUT switching to it (merge_tabs /
   *  fan_out read side-by-side tabs; switching would churn the capture). */
  async getTabPage(tabId: string): Promise<Page> {
    const session = await this.ensureContext();
    const tab = session.tabs.get(tabId);
    if (!tab) {
      const known = [...session.tabs.keys()].join(', ') || '(none)';
      throw new Error(`Unknown tab "${tabId}". Open tabs: ${known}.`);
    }
    return tab.page;
  }

  async openInNewTab(): Promise<BrowserTab> {
    const session = await this.ensureContext();
    const page = await session.context.newPage();
    this.attachDiagnostics(page);
    this.attachSignaling(page);
    const id = `tab-${session.nextTabNumber++}`;
    const tab: BrowserTab = { id, page };
    session.tabs.set(id, tab);
    session.activeTabId = id;
    this.notifyTabsChanged();
    void this.retargetCapture?.().catch(() => undefined);
    return tab;
  }

  async listTabs(): Promise<Array<{ id: string; url: string; title: string; active: boolean }>> {
    const session = await this.ensureContext();
    const out: Array<{ id: string; url: string; title: string; active: boolean }> = [];
    for (const [id, tab] of session.tabs) {
      let url = 'about:blank';
      let title = '';
      try {
        url = tab.page.url();
        title = await tab.page.title();
      } catch {
      }
      out.push({ id, url, title, active: id === session.activeTabId });
    }
    return out;
  }

  async switchTo(tabId: string): Promise<Page> {
    const session = await this.ensureContext();
    const tab = session.tabs.get(tabId);
    if (!tab) {
      const known = [...session.tabs.keys()].join(', ') || '(none)';
      throw new Error(`Unknown tab "${tabId}". Open tabs: ${known}.`);
    }
    session.activeTabId = tabId;
    void this.retargetCapture?.().catch(() => undefined);
    this.notifyTabsChanged();
    return tab.page;
  }

  /** Closes a tab; if it was active, focus moves to the first survivor. */
  async closePage(tabId: string): Promise<void> {
    const session = await this.ensureContext();
    const tab = session.tabs.get(tabId);
    if (!tab) return;
    session.tabs.delete(tabId);
    await tab.page.close().catch(() => undefined);
    if (session.activeTabId === tabId) {
      session.activeTabId = session.tabs.keys().next().value ?? '';
      void this.retargetCapture?.().catch(() => undefined);
    }
    this.notifyTabsChanged();
  }

  /** Normalizes + validates a URL for navigation. http(s) only.
   *  Phase 8: ALSO enforces the domain policy (block wins over allow) —
   *  every navigation path (browser_open, panel goto) funnels through here. */
  assertUrl(raw: string, allowPublic = true): URL {
    const url = assertAllowedTarget(raw, allowPublic);
    const policy = this.domainPolicy;
    if (policy) {
      const host = url.hostname.toLowerCase();
      const matches = (entry: string) =>
        host === entry.toLowerCase() || host.endsWith(`.${entry.toLowerCase()}`);
      if (policy.block?.some(matches)) {
        throw new Error(`Domain policy: "${url.hostname}" is BLOCKED by the operator's policy.`);
      }
      if (policy.allow?.length && !policy.allow.some(matches)) {
        throw new Error(`Domain policy: "${url.hostname}" is not in the allowlist (${policy.allow.join(', ')}).`);
      }
    }
    return url;
  }

  /** Phase 8 — loads the operator's domain policy from
   *  ~/.moriko/browser-policy.json ({ allow?: string[], block?: string[] }).
   *  Called at context launch; a missing/corrupt file just means no policy. */
  loadDomainPolicy(): void {
    try {
      const file = path.join(morikoHome, 'browser-policy.json');
      if (!fs.existsSync(file)) return;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { allow?: unknown; block?: unknown };
      const allow = Array.isArray(parsed.allow) ? parsed.allow.filter((d): d is string => typeof d === 'string' && d.trim().length > 0).map((d) => d.trim().toLowerCase()) : undefined;
      const block = Array.isArray(parsed.block) ? parsed.block.filter((d): d is string => typeof d === 'string' && d.trim().length > 0).map((d) => d.trim().toLowerCase()) : undefined;
      this.domainPolicy = allow || block ? { allow, block } : null;
    } catch {
      this.domainPolicy = null;
    }
  }

  /** Phase 8 — test/operator hook: set the policy programmatically. */
  setDomainPolicy(policy: { allow?: string[]; block?: string[] } | null): void {
    this.domainPolicy = policy;
  }

  getDomainPolicy(): { allow?: string[]; block?: string[] } | null {
    return this.domainPolicy;
  }

  /** Phase 8 — appends to the audit trail (bounded to AUDIT_CAP entries).
   *  ALSO marks the diagnostic window: browser_debug reports what happened
   *  since the LAST agent action, and logAction is that boundary. */
  logAction(action: string, detail: string): void {
    this.lastActionTs = Date.now();
    this.domCache = null;
    this.audit.push({ ts: Date.now(), action, detail });
    if (this.audit.length > BrowserManager.AUDIT_CAP) {
      this.audit.splice(0, this.audit.length - BrowserManager.AUDIT_CAP);
    }
  }

  /** Phase 8 — the audit trail, oldest first. */
  getAuditLog(): Array<{ ts: number; action: string; detail: string }> {
    return [...this.audit];
  }


  /** Ring buffer of page-level diagnostics (console/pageerror/http 4xx-5xx). */
  private diagBuffer: Array<{
    ts: number;
    kind: 'console' | 'pageerror' | 'http';
    text: string;
  }> = [];
  private static readonly DIAG_CAP = 200;
  /** Marker: diagnostics AFTER this ts belong to the CURRENT action window. */
  private lastActionTs = Date.now();
  /** Active macro recording (null = not recording). */
  private recording: { name: string; startedTs: number; lastStepTs: number; steps: Array<Record<string, unknown>> } | null = null;
  /** Stored persistent userscripts (mirrors browser-scripts.json). */
  private storedScripts: Array<{ name: string; matches: string; script: string }> | null = null;

  /** Wires the diagnostic listeners onto a page (called for every new tab).
   *  The init script counts DOM mutations so browser_debug can report "the
   *  page changed N times since load" without a full snapshot diff. */
  private attachDiagnostics(page: Page): void {
    page.on('console', (msg: { type(): string; text(): string }) => {
      const type = msg.type();
      if (type === 'error' || type === 'warning') {
        this.pushDiag({ kind: 'console', text: `${type}: ${msg.text().slice(0, 300)}` });
      }
    });
    page.on('pageerror', (err: unknown) => {
      this.pushDiag({ kind: 'pageerror', text: String(err).slice(0, 300) });
    });
    page.on('dialog', (dialog: { type(): string; message(): string; accept(text?: string): Promise<void>; dismiss(): Promise<void> }) => {
      const p = this.dialogPolicy;
      const summary = `dialog ${dialog.type()}: "${dialog.message().slice(0, 120)}" → ${p?.action === 'accept' ? 'accepted' : p?.action === 'dismiss' ? 'dismissed' : 'dismissed (default)'}`;
      this.pushDiag({ kind: 'console', text: summary });
      void (p?.action === 'accept' ? dialog.accept(p.text) : dialog.dismiss()).catch(() => undefined);
    });
    page.on('response', (res: { status(): number; url(): string }) => {
      if (res.status() >= 400) {
        this.pushDiag({ kind: 'http', text: `HTTP ${res.status()} ${res.url().slice(0, 200)}` });
      }
    });
    page.on('framenavigated', (frame: unknown) => {
      if (frame === page.mainFrame() && this.signalingSink)
        this.signalingSink({ type: '__pageNavigated', __page: page });
    });
    void page
      .addInitScript(
        `(() => {
          try {
            const state = { count: 0, lastText: '' };
            (globalThis).__morikoMutations = state;
            const obs = new MutationObserver((muts) => {
              state.count += muts.length;
              for (const m of muts) {
                if (m.addedNodes && m.addedNodes.length) {
                  state.lastText = (m.addedNodes[0].textContent || '').trim().slice(0, 120);
                }
              }
            });
            obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
          } catch { /* pages may lock down globals */ }
        })()`,
      )
      .catch(() => undefined);
  }

  private pushDiag(entry: { kind: 'console' | 'pageerror' | 'http'; text: string }): void {
    this.diagBuffer.push({ ts: Date.now(), ...entry });
    if (this.diagBuffer.length > BrowserManager.DIAG_CAP) {
      this.diagBuffer.splice(0, this.diagBuffer.length - BrowserManager.DIAG_CAP);
    }
  }

  /** The diagnostics recorded AFTER `sinceTs` (default: the last agent action). */
  getDiagnostics(sinceTs?: number): {
    sinceTs: number;
    console: Array<{ ts: number; text: string }>;
    pageErrors: Array<{ ts: number; text: string }>;
    http: Array<{ ts: number; text: string }>;
  } {
    const since = sinceTs ?? this.lastActionTs;
    const pick = (kind: string) =>
      this.diagBuffer.filter((e) => e.ts >= since && e.kind === kind).map((e) => ({ ts: e.ts, text: e.text }));
    return { sinceTs: since, console: pick('console'), pageErrors: pick('pageerror'), http: pick('http') };
  }


  /** Session dialog policy — browser_dialog sets it BEFORE the triggering
   *  action; attachDiagnostics' listener acts on every dialog accordingly. */
  private dialogPolicy: { action: 'accept' | 'dismiss' | 'default'; text?: string } | null = null;

  setDialogPolicy(policy: { action: 'accept' | 'dismiss' | 'default'; text?: string } | null): void {
    this.dialogPolicy = policy;
  }

  getDialogPolicy(): { action: 'accept' | 'dismiss' | 'default'; text?: string } | null {
    return this.dialogPolicy;
  }

  private userCursor: { x: number; y: number; visible: boolean } = { x: 0, y: 0, visible: false };

  moveUserCursor(x: number, y: number): void {
    this.userCursor = {
      ...this.clampViewport(x, y),
      visible: true,
    };
    this.broadcast({ type: 'userCursor', x: this.userCursor.x, y: this.userCursor.y, visible: true });
  }

  getUserCursor(): { x: number; y: number; visible: boolean } {
    return { ...this.userCursor };
  }

  private annotations: Array<{ type: 'rect'; x: number; y: number; w: number; h: number; ts: number }> = [];

  pushAnnotation(a: { x: number; y: number; w: number; h: number }): void {
    this.annotations.push({ type: 'rect', ts: Date.now(), ...a });
    if (this.annotations.length > 20) this.annotations.splice(0, this.annotations.length - 20);
  }

  /** Returns the pending annotations and CLEARS them (consume semantics). */
  takeAnnotations(): Array<{ type: 'rect'; x: number; y: number; w: number; h: number; ts: number }> {
    const out = [...this.annotations];
    this.annotations = [];
    return out;
  }

  /** Tiny page-data cache (semantic/read_article walkers): url+keyed, 5s TTL,
   *  invalidated by every logged action and every eval. */
  private domCache: { url: string; key: string; ts: number; value: unknown } | null = null;
  private static readonly DOM_CACHE_TTL = 5_000;

  getCachedDom<T>(key: string, url: string): T | undefined {
    const c = this.domCache;
    if (!c || c.key !== key || c.url !== url) return undefined;
    if (Date.now() - c.ts > BrowserManager.DOM_CACHE_TTL) return undefined;
    return c.value as T;
  }

  putCachedDom(key: string, url: string, value: unknown): void {
    this.domCache = { key, url, ts: Date.now(), value };
  }

  invalidateDomCache(): void {
    this.domCache = null;
  }


  private scriptsFile(): string {
    return path.join(morikoHome, 'browser-scripts.json');
  }

  private loadScripts(): Array<{ name: string; matches: string; script: string }> {
    if (this.storedScripts) return this.storedScripts;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.scriptsFile(), 'utf8')) as unknown;
      this.storedScripts = Array.isArray(parsed)
        ? parsed.filter((s): s is { name: string; matches: string; script: string } =>
            !!s && typeof s.name === 'string' && typeof s.script === 'string')
        : [];
    } catch {
      this.storedScripts = [];
    }
    return this.storedScripts;
  }

  private saveScripts(): void {
    try {
      fs.mkdirSync(morikoHome, { recursive: true });
      fs.writeFileSync(this.scriptsFile(), JSON.stringify(this.storedScripts ?? [], null, 2));
    } catch {
    }
  }

  /** Wraps a userscript so it only runs on matching URLs (glob → regex).
   *  Single-pass escaping: `*` becomes `[\s\S]*`, everything regex-special
   *  is escaped (a second replace pass would re-mangle the inserted `*`). */
  private wrapScript(entry: { matches: string; script: string }): string {
    const source = entry.matches.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === '*' ? '[\\s\\S]*' : `\\${ch}`));
    return `(() => { try { if (!new RegExp(${JSON.stringify(source)}).test(location.href)) return; (function(){ ${entry.script} })(); } catch (e) { console.warn('[moriko-script]', e && e.message); } })();`;
  }

  /** Installs (or replaces by name) a persistent userscript on the context. */
  async installScript(entry: { name: string; matches: string; script: string }): Promise<void> {
    const session = await this.ensureContext();
    const all = this.loadScripts();
    const existing = all.findIndex((s) => s.name === entry.name);
    if (existing >= 0) all[existing] = entry;
    else all.push(entry);
    this.saveScripts();
    await session.context.addInitScript(this.wrapScript(entry));
  }

  listScripts(): Array<{ name: string; matches: string; script: string }> {
    return [...this.loadScripts()];
  }

  /** Removes a script from the REGISTRY — already-injected contexts keep it
   *  until relaunch (documented behavior; addInitScript cannot be undone). */
  removeScript(name: string): boolean {
    const all = this.loadScripts();
    const before = all.length;
    this.storedScripts = all.filter((s) => s.name !== name);
    this.saveScripts();
    return this.storedScripts.length < before;
  }


  private macrosDir(): string {
    return path.join(morikoHome, 'browser-macros');
  }

  startRecording(name: string): void {
    this.recording = { name, startedTs: Date.now(), lastStepTs: Date.now(), steps: [] };
  }

  /** Called by the forward* takeover methods — captures user actions. */
  private captureStep(step: Record<string, unknown>): void {
    if (!this.recording) return;
    const now = Date.now();
    this.recording.steps.push({ ...step, dt: now - this.recording.lastStepTs });
    this.recording.lastStepTs = now;
  }

  isRecording(): boolean {
    return this.recording !== null;
  }

  /** Stops recording, persists ~/.moriko/browser-macros/<name>.json, returns the path. */
  stopRecording(): { file: string; steps: number } | null {
    const rec = this.recording;
    this.recording = null;
    if (!rec) return null;
    const dir = this.macrosDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
      const safe = rec.name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60) || 'macro';
      const file = path.join(dir, `${safe}.json`);
      fs.writeFileSync(file, JSON.stringify({ name: rec.name, recordedAt: rec.startedTs, steps: rec.steps }, null, 1));
      return { file, steps: rec.steps.length };
    } catch {
      return { file: '(save failed)', steps: rec.steps.length };
    }
  }

  loadMacro(name: string): Array<Record<string, unknown>> | null {
    try {
      const safe = name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60) || 'macro';
      const parsed = JSON.parse(fs.readFileSync(path.join(this.macrosDir(), `${safe}.json`), 'utf8')) as { steps?: Array<Record<string, unknown>> };
      return Array.isArray(parsed.steps) ? parsed.steps : null;
    } catch {
      return null;
    }
  }

  /**
   * Retargets the WebRTC capture at the ACTIVE tab (webrtc.ts implements it —
   * kept as a manager hook so tab switches re-negotiate the stream).
   */
  private retargetCapture: (() => Promise<void>) | null = null;
  /** webrtc.ts registers its retarget + signaling sink here at module load. */
  registerTransport(hooks: {
    retarget: () => Promise<void>;
    onSignaling: (msg: Record<string, unknown>) => void;
  }): void {
    this.retargetCapture = hooks.retarget;
    this.signalingSink = hooks.onSignaling;
  }

  /** A page emitted a signaling message (rtc-offer / rtc-ice from the in-page
   *  peer). Forwarded to webrtc.ts — only the ACTIVE tab's peer is honored. */
  emitSignaling(page: Page, msg: Record<string, unknown>): void {
    if (this.signalingSink) this.signalingSink({ ...msg, __page: page });
  }

  /**
   * Injects the in-page WebRTC peer (capture + RTCPeerConnection) into a page
   * and binds the signaling bridge. The ACTIVE tab is the one whose peer
   * actually drives the connection; background tabs' peers stay idle.
   */
  private attachSignaling(page: Page): void {
    void page
      .addInitScript(TAB_CAPTURE_SCRIPT)
      .then(() => page.exposeFunction('__morikoRtcSignal', (msg: Record<string, unknown>) => {
        this.emitSignaling(page, msg);
      }))
      .then(() => page.evaluate(TAB_CAPTURE_SCRIPT))
      .catch(() => undefined);
  }

  /** Graceful shutdown — the profile flushes cookies/localStorage on close. */
  async close(): Promise<void> {
    const session = this.session;
    this.closing = true;
    this.session = null;
    this.broadcast({ type: 'shutdown', reason: 'closed' });
    this.subscribers.clear();
    if (session) {
      await session.context.close().catch(() => undefined);
    }
    this.closing = false;
  }

  /** True while any conversation has Web Access on (set by the close/allow routes). */
  isWebAccessOn(): boolean {
    return this.webAccessOn;
  }

  /** WEB ACCESS KILL-SWITCH: flip the gate + broadcast shutdown to every panel.
   *  `on` is computed by the caller from the conversation settings; the manager
   *  only owns the single shared context. Off also tears the context down so
   *  nothing keeps running in the background. */
  async setWebAccess(on: boolean): Promise<void> {
    this.webAccessOn = on === true;
    if (this.webAccessOn) return;
    if (!this.session) return;
    await this.close().catch(() => undefined);
  }


  isLive(): boolean {
    return this.session !== null;
  }


  /** Current harness-cursor state (rendered by the Phase-3 panel). */
  getCursor(): BrowserCursor {
    return { ...this.cursor };
  }

  /**
   * Moves the harness cursor: updates the tracked state AND the browser's
   * synthetic mouse (so hover states / mousemove listeners fire). Coordinates
   * are clamped to the viewport.
   */
  async moveCursor(x: number, y: number, steps = 1): Promise<BrowserCursor> {
    const { x: cx, y: cy } = this.clampViewport(x, y);
    this.cursor = { x: cx, y: cy, visible: true };
    try {
      const page = await this.getActivePage();
      await page.mouse.move(cx, cy, { steps: Math.max(1, Math.round(steps)) });
    } catch {
    }
    return this.getCursor();
  }

  /** Hides the cursor (e.g. takeover mode takes the pointer back). */
  hideCursor(): void {
    this.cursor = { ...this.cursor, visible: false };
  }

  subscribe(sub: PanelSubscriber): void {
    this.subscribers.add(sub);
  }

  unsubscribe(sub: PanelSubscriber): void {
    this.subscribers.delete(sub);
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Fans one JSON message out to every open subscriber socket. */
  broadcast(message: Record<string, unknown>): void {
    if (this.subscribers.size === 0) return;
    const payload = JSON.stringify(message);
    for (const sub of this.subscribers) {
      if (sub.readyState === WS_OPEN) {
        try {
          sub.send(payload);
        } catch {
        }
      }
    }
  }

  /** A click ripple for the panel — piggybacks on the same broadcast channel. */
  broadcastClick(x: number, y: number): void {
    const { x: cx, y: cy } = this.clampViewport(x, y);
    this.broadcast({ type: 'cursorClick', x: cx, y: cy });
  }

  /** Phase 5 — a drag trail for the panel: start, end, and the sampled path
   *  (sub-sampled to ≤16 points so the WS frame stays small). */
  broadcastDrag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    steps: number,
    button: string,
  ): void {
    const pts: Array<{ x: number; y: number }> = [];
    const samples = Math.min(steps, 16);
    for (let i = 0; i <= samples; i += 1) {
      const t = i / samples;
      pts.push({
        x: Math.round(fromX + (toX - fromX) * t),
        y: Math.round(fromY + (toY - fromY) * t),
      });
    }
    this.broadcast({ type: 'cursorDrag', fromX, fromY, toX, toY, button, points: pts });
  }

  /** Phase 5 — tracks which mouse button the agent currently holds down
   *  (multi-segment strokes: down → N× cursor_move → up). */
  private mouseDownButton: 'left' | 'right' | 'middle' | null = null;


  /** The last element snapshot per selector. One open watch at a time keeps
   *  the flow unambiguous: watch → act → result (consumed) → watch again.
   *  undefined = no watch; null = watching a not-yet-existing element. */
  private watchSnapshots = new Map<
    string,
    { html: string; text: string; cls: string; exists: boolean } | null | undefined
  >();

  /** Stores (or clears with undefined) the pre-action snapshot for a selector. */
  setWatchSnapshot(selector: string, snapshot: { html: string; text: string; cls: string; exists: boolean } | null | undefined): void {
    if (snapshot === undefined) this.watchSnapshots.delete(selector);
    else this.watchSnapshots.set(selector, snapshot);
  }

  /** The FIRST open watch — { selector, snapshot } — or undefined when none.
   *  A single open watch keeps the watch → act → result flow unambiguous. */
  listWatched(): { selector: string; snapshot: { html: string; text: string; cls: string; exists: boolean } | null } | undefined {
    for (const [selector, snapshot] of this.watchSnapshots) {
      return { selector, snapshot: snapshot ?? null };
    }
    return undefined;
  }

  /** Drops ALL snapshots (used on navigation-ish boundaries and tests). */
  clearWatchSnapshots(): void {
    this.watchSnapshots.clear();
  }

  /** Pushes the tab list + active id to every watcher (panel tab bar). */
  notifyTabsChanged(): void {
    void this.listTabs()
      .then((tabs) => {
        this.broadcast({
          type: 'tabList',
          tabs,
          activeTabId: tabs.find((t) => t.active)?.id ?? '',
        });
      })
      .catch(() => undefined);
  }

  /** Pushes mode/url/title to every watcher (panel status bar). */
  notifyStatusChanged(): void {
    void this.getActivePage()
      .then(async (page) => {
        this.broadcast({
          type: 'statusChange',
          mode: this.takeoverActive ? 'takeover' : 'agent',
          url: page.url(),
          title: await page.title().catch(() => ''),
        });
      })
      .catch(() => undefined);
  }


  /** Phase 5 — an interpolated DRAG: down → N× move → up on the serialized
   *  input chain. `steps` interpolates linearly between the endpoints (the
   *  canvas apps between the moves see pointermove streams, so painted lines
   *  are smooth, not teleport-jumps). Broadcasts a trail to the panel. */
  async performDrag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    steps: number,
    button: 'left' | 'right' | 'middle',
    delayMs: number,
  ): Promise<void> {
    const { x: fx, y: fy } = this.clampViewport(fromX, fromY);
    const { x: tx, y: ty } = this.clampViewport(toX, toY);
    const n = Math.max(1, Math.min(200, Math.round(steps)));
    await this.moveCursor(fx, fy);
    await this.enqueueInput(async () => {
      const page = await this.getActivePage();
      await page.mouse.move(fx, fy, { steps: 1 });
      await page.mouse.down({ button });
      for (let i = 1; i <= n; i += 1) {
        const t = i / n;
        await page.mouse.move(fx + (tx - fx) * t, fy + (ty - fy) * t);
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      }
      await page.mouse.up({ button });
    });
    this.cursor = { x: tx, y: ty, visible: true };
    this.broadcastDrag(fx, fy, tx, ty, n, button);
  }

  /** Phase 5 — press-and-hold at (x,y): the START of a multi-segment stroke.
   *  Tracks the held button so cursor_move drags the line and mouse_up ends it. */
  async performMouseDown(x: number, y: number, button: 'left' | 'right' | 'middle'): Promise<void> {
    const { x: cx, y: cy } = this.clampViewport(x, y);
    if (this.mouseDownButton) {
      throw new Error(`mouse button "${this.mouseDownButton}" is already down — send browser_mouse_up first (multi-segment strokes: down → cursor_move → up).`);
    }
    await this.moveCursor(cx, cy);
    await this.enqueueInput(async () => {
      const page = await this.getActivePage();
      await page.mouse.move(cx, cy, { steps: 1 });
      await page.mouse.down({ button });
    });
    this.mouseDownButton = button;
    this.broadcast({ type: 'cursorDrag', fromX: cx, fromY: cy, toX: cx, toY: cy, button, points: [{ x: cx, y: cy }], phase: 'down' });
  }

  /** Phase 5 — release the held button (ends a multi-segment stroke).
   *  Accepts a final (x,y) so the last vertex lands exactly where intended. */
  async performMouseUp(x: number | undefined, y: number | undefined, button: 'left' | 'right' | 'middle'): Promise<void> {
    if (!this.mouseDownButton) {
      throw new Error('no mouse button is currently down — send browser_mouse_down first.');
    }
    const fallback = { x: this.cursor.x, y: this.cursor.y };
    const clamped = x === undefined || y === undefined ? fallback : this.clampViewport(x, y);
    const cx = clamped.x;
    const cy = clamped.y;
    await this.enqueueInput(async () => {
      const page = await this.getActivePage();
      if (x !== undefined && y !== undefined) {
        await page.mouse.move(cx, cy);
      }
      await page.mouse.up({ button });
    });
    this.mouseDownButton = null;
    this.cursor = { x: cx, y: cy, visible: true };
    this.broadcast({ type: 'cursorDrag', fromX: cx, fromY: cy, toX: cx, toY: cy, button, points: [{ x: cx, y: cy }], phase: 'up' });
  }

  /** Phase 5 — whether an agent stroke is currently in progress. */
  isMouseDown(): boolean {
    return this.mouseDownButton !== null;
  }

  startTakeover(by?: string): void {
    this.takeoverActive = true;
    this.takeoverBy = by ?? null;
    this.hideCursor();
    this.broadcast({ type: 'statusChange', mode: 'takeover', by: this.takeoverBy });
    this.notifyStatusChanged();
  }

  endTakeover(): void {
    this.takeoverActive = false;
    this.takeoverBy = null;
    this.broadcast({ type: 'statusChange', mode: 'agent' });
    this.notifyStatusChanged();
  }

  isTakeover(): boolean {
    return this.takeoverActive;
  }

  /** Readable reason the input tools surface during takeover. */
  takeoverNotice(): string {
    return 'Browser is in takeover mode — the user is controlling it. Wait for the user to release, or ask them to click "Release to Agent" in the browser panel.';
  }


  /** Queues ONE input op onto the serialized chain; the chain never rejects. */
  private enqueueInput(op: () => Promise<void>): Promise<void> {
    const run = this.inputChain.then(op, op);
    this.inputChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Flushes a coalesced move NOW — before a click/wheel/key. */
  private flushPendingMove(): void {
    if (this.moveFlushTimer) {
      clearTimeout(this.moveFlushTimer);
      this.moveFlushTimer = null;
    }
    const move = this.pendingMove;
    this.pendingMove = null;
    if (!move) return;
    void this.enqueueInput(async () => {
      const page = await this.getActivePage();
      await page.mouse.move(move.x, move.y);
    }).catch(() => undefined);
  }

  /** Forwards a user mouse-move (takeover only). Coalesced: newest position
   *  wins, flushes ~8ms after the last burst. */
  forwardMouseMove(x: number, y: number): void {
    if (!this.takeoverActive) return;
    this.pendingMove = this.clampViewport(x, y);
    if (this.moveFlushTimer) return;
    this.moveFlushTimer = setTimeout(() => {
      this.moveFlushTimer = null;
      if (!this.takeoverActive) {
        this.pendingMove = null;
        return;
      }
      this.flushPendingMove();
    }, 8);
  }

  /** Forwards a user click (takeover only). Clamped to the viewport. */
  async forwardMouseClick(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    if (!this.takeoverActive) return;
    this.flushPendingMove();
    const { x: cx, y: cy } = this.clampViewport(x, y);
    await this.enqueueInput(async () => {
      const page = await this.getActivePage();
      await page.mouse.click(cx, cy, { button });
    });
    this.captureStep({ type: 'click', x: cx, y: cy, button });
  }

  /** Forwards user typing (takeover only). */
  async forwardKeyboardType(text: string): Promise<void> {
    if (!this.takeoverActive) return;
    this.flushPendingMove();
    await this.enqueueInput(async () => {
      const page = await this.getActivePage();
      await page.keyboard.type(text, { delay: 10 });
    });
    this.captureStep({ type: 'type', text });
  }

  /** Forwards a user key press (takeover only). */
  async forwardKeyboardPress(key: string): Promise<void> {
    if (!this.takeoverActive) return;
    this.flushPendingMove();
    await this.enqueueInput(async () => {
      const page = await this.getActivePage();
      await page.keyboard.press(key);
    });
    this.captureStep({ type: 'press', key });
  }

  /** Forwards a user scroll (takeover only). */
  async forwardScroll(deltaX: number, deltaY: number): Promise<void> {
    if (!this.takeoverActive) return;
    this.flushPendingMove();
    await this.enqueueInput(async () => {
      const page = await this.getActivePage();
      await page.mouse.wheel(deltaX, deltaY);
    });
    this.captureStep({ type: 'scroll', deltaX, deltaY });
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/** Module-level singleton — ONE browser context per server process. */
export const browserManager = new BrowserManager();
