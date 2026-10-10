# PLAN-MOBILE-UI-AND-MOBILE-WATCHING.md

Two workstreams for the Moriko harness:

- **A. Mobile & tablet responsive UI** — padding and layout that work on phones
  (average aspect ~9:20, e.g. 360×800, 412×915) and tablets (768–1280 px).
- **B. Mobile Watching** — a button in the bottom-left sidebar footer (next to
  the day/night toggle) that downloads `cloudflared` (skipped if already
  present), opens a tunnel to the currently running web dev port, and shows a
  QR code + link so the app can be opened on another device.

## Audit — current state (2026-10-06)

| Area | Finding |
| --- | --- |
| Viewport | `index.html` already has `viewport-fit=cover` + `color-scheme` — notch support is half-ready. |
| Responsive CSS | **Zero `@media` rules in `src/styles/`**. The only responsiveness is Tailwind utility classes (`hidden md:block`, drawers in `App.tsx`). |
| App shell | `App.tsx`: below `md` the sidebar becomes a left drawer, below `lg` the right dock (Settings/Tree/Diff) becomes a right drawer; `ResizeHandle` is `hidden md:block`. Solid base, but paddings/dialogs/components are desktop-first. |
| Day/night button | `src/components/Sidebar.tsx` footer (≈ lines 895–952): Settings · Provider · Dashboard · day/night. **Mobile Watching button goes in this row, right of the day/night button.** |
| Touch targets | `.icon-button h-8 w-8` = 32 px — below the 44 px guideline on coarse pointers. |
| Web dev port | `vite.config.ts`: web dev on **:5588** (`strictPort: false` → can drift), `/api` proxied to **:8826** (Express). `host: true` + `allowedHosts: ['.trycloudflare.com']` — **already tunnel-ready**. |
| Tunnel/QR infra | None. No `cloudflared`, no QR library anywhere in the repo. |
| Platform | Windows x64 primary (`cloudflared-windows-amd64.exe`); keep a platform→asset map for portability. |
| Data root | `server/paths.ts` owns `~/.moriko-studio` — binary + state belong there. |

---

## Part A — Mobile & tablet responsive UI

### A0. Foundation (tokens & rules)

1. **Breakpoints** (`tailwind.config.js`): keep Tailwind defaults `sm 640 / md 768 / lg 1024`, add `xs: 380` for the narrowest phones. Device matrix: 360×800, 390×844, 412×915 (9:20 class), 768×1024, 834×1194, 1280×800.
2. **Safe-area tokens** (`src/styles/index.css`):
   `--safe-top/left/right/bottom: env(safe-area-inset-*)`; all edge paddings become `max(<base>, env(safe-area-inset-*))` so notches/home bars never clip the composer or sidebar footer.
3. **Height units**: full-height columns switch from `100vh` to `100dvh` (mobile URL bar).
4. **Touch targets**: `@media (pointer: coarse)` — interactive controls get `min-h/min-w: 44px`; hover-only affordances (e.g. `Gallery` overlay) become always visible.
5. **Breakpoint hook**: small `useMediaQuery`/`useBreakpoint` helper (matchMedia) so JS layout decisions (drawer vs docked, sheet vs popover) share one source of truth with the CSS classes.

### A1. Shell & components

| Component | Change |
| --- | --- |
| `Sidebar.tsx` | < md: off-canvas drawer + scrim, auto-close on navigation; footer row (incl. new Mobile Watching button) wraps/scrolls instead of overflowing on 360 px. |
| `TopBar.tsx` | Phone: condense title/subtitle, move secondary actions into an overflow menu. |
| Right dock (Settings/Tree/Diff) | < lg: full-height sheet with scrim, Escape + backdrop close (partially exists — standardize). |
| `Composer.tsx` | Compact rows on phone; full-width Steer/Send; attachment chips wrap; `CatEyeModeToggle` scales down; keyboard-safe via `visualViewport` resize handling (composer stays above the on-screen keyboard). |
| `Thread.tsx` | Reduce horizontal padding (`px-3`) on phone; bubbles `max-w`; code blocks `overflow-x: auto`; `CheckpointRail` hidden < md. |
| Dialogs (`SettingsDialog`, `ProvidersDialog`, `ImageEditorModal`, `ImageLightbox`, …) | Phone: bottom-sheet / full-bleed presentation instead of centered wide modals. |
| `SettingsPanel.tsx`, `DashboardView.tsx`, `ImageStudio.tsx`, `ProjectTreePanel.tsx` | Tables → stacked cards; grids → 2 columns; wide rows collapse into two-line list items. |
| Landscape phone | Compact top bar, no 50/50 splits, drawers over content. |

### A2. PWA polish

`public/site.webmanifest` + icons exist — verify `display: standalone`, theme-color per day/night, and "Add to Home Screen" on Android/iOS (this is how Mobile Watching gets used daily).

### A3. Verification

- `agent__spatial` **runtime** at 360×800, 412×915, 768×1024, 1280×800 — hard overlaps, viewport overflow, tiny touch targets; `compare_static` after edits.
- Manual pass on a real phone **through the Mobile Watching tunnel itself** (dogfooding both features).

---

## Part B — Mobile Watching (cloudflared + QR)

### B0. Server subsystem — `server/watch/`

**`cloudflared.ts` — binary manager**
- `ensureInstalled(platform)`: if `~/.moriko-studio/bin/cloudflared(.exe)` exists → **skip** (per spec). Otherwise download the **user-selected** release asset from
  `https://github.com/cloudflare/cloudflared/releases/latest/download/<asset>`. The target is **explicit, never guessed silently**: the popover pre-selects the detected host (Windows x64 here) but the user can override it, so a wrong-asset download cannot happen. Asset map:

  | Selection | Asset | Packaging |
  | --- | --- | --- |
  | Windows x64 / arm64 | `cloudflared-windows-amd64.exe` / `cloudflared-windows-arm64.exe` | direct binary |
  | Linux x64 / arm64 / arm | `cloudflared-linux-amd64` / `-arm64` / `-arm` | direct binary |
  | macOS x64 / arm64 | `cloudflared-darwin-amd64.tgz` / `cloudflared-darwin-arm64.tgz` | `.tgz` → extract `cloudflared` |

  Stream to a `.partial` file, then atomic rename (pattern already used by `server/atomicWrite.ts`); extract `.tgz` after download. Progress is exposed through status polling. Sanity check: non-empty + `cloudflared --version` runs. The chosen platform/arch is recorded in `watch/state.json` (and re-confirmable before a reinstall).
- `startTunnel(port)`: spawn `cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate`; parse the log line containing `https://<random>.trycloudflare.com` → tunnel ready. Keep the child handle in a module singleton.
- `stopTunnel()`: kill the process tree, clear state.
- **Reload resilience**: persist `~/.moriko-studio/watch/state.json` `{ pid, url, port, startedAt }`. The supervisor reloads the server (exit code 75) — on boot, check PID liveness and either adopt the live tunnel or report it stale. Kill the tunnel on graceful shutdown.

**`ports.ts` — web dev port detection**
- Parse `netstat -ano -p tcp` (win32) / `ss -ltnp` (posix) for LISTENING sockets on `127.0.0.1`/`0.0.0.0`.
- Annotate known ports: **5588** → "Moriko web (Vite)" (preferred default), **8826** → "Moriko proxy (internal — excluded)".
- Return a candidate list; **manual port entry always allowed** (Vite may drift from 5588 since `strictPort: false`).

**`routes.ts` — mounted as `app.use('/api/watch', watchRouter())` in `server/index.ts`**
| Endpoint | Behavior |
| --- | --- |
| `GET /api/watch/status` | `{ installed, version, tunnel: { running, url, port, pid, startedAt }, ports[] }` |
| `POST /api/watch/install` `{ platform, arch }` | kick off download of the selected asset (202; progress via status polling) |
| `POST /api/watch/start` `{ port }` | ensureInstalled → startTunnel → `{ url }` |
| `POST /api/watch/stop` | stop tunnel |
| `GET /api/watch/qr?text=…` | SVG QR code |

**QR rendering**: add the `qrcode` npm dependency (pure JS), render SVG server-side — client bundle stays lean. *(Alt: vendored tiny encoder if we want zero new deps.)*

**Guardrails**
- Quick tunnel = **public random URL** — the popover shows a warning, and Stop is one click. Single active tunnel at a time (v1); switching port = stop + start.
- Download failure (offline/proxy) → clear error + retry, `.partial` cleanup.
- Tunnel dies (network change) → status flips to "stopped", one-click restart.
- Starting against a dead port → warn before spawn.
- A selection that does **not** match the host platform is download-only: the UI warns "binary tidak bisa jalan di mesin ini — unduh untuk dipindahkan ke perangkat lain", and `startTunnel` refuses to launch a non-host binary (only a host-compatible `cloudflared` runs the tunnel).
- *(v2, out of scope)* optional access token for the public URL; named tunnels (Cloudflare cert) for stable domains.

### B1. Client UI — `src/components/MobileWatching.tsx`

- **Button**: in the `Sidebar.tsx` footer row, immediately right of the day/night button (`Sidebar.tsx` ≈ line 938 block). Icon: `QrCode`/`Smartphone` (lucide, already a dependency). State badge: idle / downloading (progress %) / connecting / active (dot).
- **Popover** (opens above the footer, `bottom-full` like the Composer menus): **platform/arch picker** (Windows / Linux / macOS × x64 / arm64 / arm — pre-filled with the detected host, overridable; shows the exact asset name that will be downloaded), port picker (auto-detected + manual), large QR code, copyable link, "open in new tab" button, Stop button, public-URL warning.
- **Flow**: click → `GET /status` → pick platform + port → if not installed `POST /install { platform, arch }` (progress) → `POST /start { port }` → poll until `url` → render QR + link.
- `src/lib/api.ts`: typed `watchStatus / watchInstall / watchStart / watchStop / watchQr` helpers.
- State: component-local + a light `useStore` slice (`watchStatus`), polled while the popover is open or a tunnel is active.

### B2. Implementation order

1. **A0** foundation (tokens, safe-area, breakpoints, touch targets).
2. **A1** shell → Composer/Thread → dialogs → panels (in that order; each step spatial-checked).
3. **B0** server subsystem (cloudflared manager → ports → routes).
4. **B1** client button + popover + api helpers.
5. **A3 + manual device pass** (spatial runtime at all matrix viewports; real-phone test through the tunnel).

## Decisions & open points

**Confirmed 2026-10-06 (user):** the download target is **chosen explicitly** — the platform/arch picker sits in the Mobile Watching popover (Windows, Linux, macOS …), the host detection only pre-fills it. This prevents wrong-asset downloads.

| Decision | Recommendation |
| --- | --- |
| QR implementation | `qrcode` npm dep, SVG server-side (lean client). |
| Tunnel type v1 | Cloudflare **Quick Tunnel** (`trycloudflare.com`) — no account needed, matches "scan and open". |
| Default port | Prefer 5588 when listening, otherwise show the picker with manual entry. |
| Public-URL auth | Deferred to v2; v1 ships with a visible warning + one-click stop. |
