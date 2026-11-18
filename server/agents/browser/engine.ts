type PlaywrightModule = typeof import('playwright-core');
type Browser = import('playwright-core').Browser;
type BrowserContext = import('playwright-core').BrowserContext;
type BrowserContextOptions = import('playwright-core').BrowserContextOptions;

let cachedPw: PlaywrightModule | null | undefined;
let sharedBrowser: Browser | null = null;
let launchPromise: Promise<Browser> | null = null;

export const SHARED_BROWSER_ARGS: string[] = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=Translate',
  '--auto-accept-this-tab-capture',
  '--autoplay-policy=no-user-gesture-required',
  '--use-gl=angle',
  '--enable-gpu-rasterization',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

export async function loadPlaywright(): Promise<PlaywrightModule | null> {
  if (cachedPw !== undefined) return cachedPw;
  try {
    const imported = await import('playwright-core');
    cachedPw = (imported as { default?: PlaywrightModule }).default ?? imported;
    return cachedPw;
  } catch {
    cachedPw = null;
    return null;
  }
}

function launchErrorMessage(error: unknown): string {
  return (
    'Could not launch the shared headless browser (tried channel "msedge", then bundled "chromium"). ' +
    'Install Microsoft Edge or run "npx playwright install chromium" once. ' +
    `Underlying error: ${error instanceof Error ? error.message : String(error)}`
  );
}

/**
 * Returns the single shared Chromium Browser engine reused across interactive
 * browser sessions, screenshots, spatial runtime probes, and game probes.
 */
export async function getSharedBrowser(): Promise<Browser> {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  if (launchPromise) return launchPromise;

  launchPromise = (async () => {
    const pw = await loadPlaywright();
    if (!pw) {
      throw new Error(
        'playwright-core is not installed. Run: pnpm add -D playwright-core — ' +
        'the shared headless browser requires it.',
      );
    }

    let browser: Browser;
    try {
      browser = await pw.chromium.launch({
        channel: 'msedge',
        headless: true,
        args: SHARED_BROWSER_ARGS,
      });
    } catch {
      try {
        browser = await pw.chromium.launch({
          headless: true,
          args: SHARED_BROWSER_ARGS,
        });
      } catch (error) {
        throw new Error(launchErrorMessage(error));
      }
    }

    browser.on('disconnected', () => {
      if (sharedBrowser === browser) sharedBrowser = null;
    });
    sharedBrowser = browser;
    return browser;
  })().finally(() => {
    launchPromise = null;
  });

  return launchPromise;
}

/**
 * Opens an ephemeral isolated BrowserContext on the shared engine. Callers
 * must close the returned context in a finally block so cookies and tabs
 * never leak across runs.
 */
export async function acquireEphemeralContext(
  options: BrowserContextOptions = {},
): Promise<BrowserContext> {
  const browser = await getSharedBrowser();
  return browser.newContext({
    deviceScaleFactor: 1,
    ...options,
  });
}

export function isSharedBrowserAlive(): boolean {
  return Boolean(sharedBrowser && sharedBrowser.isConnected());
}

export async function closeSharedBrowser(): Promise<void> {
  const target = sharedBrowser;
  sharedBrowser = null;
  launchPromise = null;
  if (target) {
    await target.close().catch(() => undefined);
  }
}
