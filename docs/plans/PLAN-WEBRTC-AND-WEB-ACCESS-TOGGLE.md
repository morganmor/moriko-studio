# PLAN — WebRTC Transport + Web Access Kill-Switch

> **Status**: ⚙️ IN PROGRESS — **Workstream A: pondasi + polish LANDED** (2026-10-01): CDP screencast DELETED, WebRTC signaling/capture/panel + status UI + cursor imperative landed, `pnpm typecheck` clean. **NO CDP fallback — by design.** Capture acquisition dipindah ke headless=new + fake UI berdasar diagnosis runtime (§2.7) — **belum diverifikasi runtime; trial manual user adalah penentu**. **Workstream B: LANDED** (2026-10-02): `webAccess` kill-switch — katalog filter (loop.ts), dispatcher guard (`web_access_off`, mencakup nested agent__exec), fetchEnabled AND, enforcement ≥2 override, toggle UI sidebar + Composer popover, prompt nudge + section Browser kondisional, journal `webAccess`. Default OFF. **Runtimes shutdown LANDED** (2026-10-02, §3.2a): toggle OFF → `POST /browser/web-access` → broadcast `shutdown` ke semua panel (tutup window sendiri, stop reconnect) + context Edge ditutup (`manager.setWebAccess/close`); gate `webAccessOn` memblokir relaunch dari panel socket & `ensureContext()`; `panel-url` 403 saat off.
> **Date**: 2026-10-01
> **Depends on**: `playwright-core` (installed), `ws` (installed), `agent__exec` orchestrator (landed) — **tanpa native WebRTC lib** (peer berjalan di dalam Chromium page, bukan Node)
> **Supersedes**: nothing — extends `docs/PLAN-BROWSER-HARNESS.md` §"Browser Panel WebSocket"

---

## 0. Ringkasan Eksekutif

Dua perubahan pada browser harness built-in:

1. **Workstream A — WebRTC Transport**: mengganti pipeline CDP JPEG screencast → base64 → WebSocket → `new Image()` → canvas dengan **Chromium getDisplayMedia (tab capture) → WebRTC P2P (server ↔ panel)**. Video track hardware-encoded (H.264/VP8/VP9), UDP/SRTP direct, tanpa JPEG artifact, tanpa bottleneck `screencastFrameAck`.
2. **Workstream B — Web Access Toggle**: menambah setting `webAccess` (default **off**) di sidebar Configuration → section Tools, sebagai kill-switch total seluruh akses web agent: `agent__browser_*`, `agent__fetch`, `agent__download`, tool proxy `webFetch`, dan auto-augmentasi link di chat.

---

## 1. Diagnosis Mekanisme Saat Ini (baseline)

### 1.1 Alur data panel hari ini

```
Chromium headless (msedge, channel persistent context)
  └─ CDP Page.startScreencast { jpeg, quality 60|80, maxWidth 1600|2560, everyNthFrame: 1 }
       └─ Page.screencastFrame (base64 JPEG string, 2560×1440 saat q80)
            └─ manager.broadcast() → JSON.stringify per subscriber → ws.send (TCP)
                 └─ panel: JSON.parse (MB-scale string, main thread)
                      └─ new Image() + onload → drawImage ke canvas 2560×1440
                           └─ CSS downscale ke window panel
  └─ Page.screencastFrameAck (fire-and-forget; telat = Chromium stop produksi frame)
```

### 1.2 Titik masalah terverifikasi di kode

| # | Titik | Lokasi | Masalah |
|---|---|---|---|
| Q1 | `deviceScaleFactor: 2` | `server/agents/browser/manager.ts:162` | 2560×1440 capture — 4× piksel, encode CPU naik 4×, JPEG ringing pada teks |
| Q2 | Adaptive quality drop | `manager.ts:504–547` | >3 subscriber atau frame >400 KB → q60/1600px → panel terlihat buram |
| Q3 | JPEG lossy | `manager.ts:731–737` | Garis tipis/UI teks = artifact paling jelek dari JPEG |
| Q4 | `new Image()` per frame | `src/browser-view-main.tsx:190–206` | base64 decode → allocate `HTMLImageElement` → tunggu `onload` async → draw. Tidak ada `createImageBitmap`, tidak ada frame skip |
| Q5 | `setState` per cursor | `browser-view-main.tsx:130–133,205` | React re-render seluruh panel hanya untuk posisi cursor |
| Q6 | `JSON.parse` MB/frame | `browser-view-main.tsx:99–105` | Parse string base64 megabyte-an di main thread setiap frame |
| Q7 | `everyNthFrame: 1` | `manager.ts:736` | Tak ada throttle; event loop server sibuk → ACK telat → stutter |
| Q8 | Headless software render | `manager.ts:158–170` | Tanpa `--use-gl=angle`/GPU raster → SwiftShader CPU + encode CPU di server |

### 1.3 Kenapa WebRTC menang (ringkasan dari riset G12)

- **Latency 30–80 ms** (UDP/SRTP + jitter buffer adaptif) vs 150–350 ms+ (akumulasi CDP → WS TCP → encode ulang → decode).
- **Encode di GPU browser** (NVENC/QSV/MediaFoundation) — server hanya signaling. CPU server turun drastis.
- **`contentHint: "detail"`** pada video track → teks statis tajam, tanpa double-compression generation loss.
- **Tanpa ACK gate** → tidak ada anjloknya FPS saat server sesek sibuk.
- Input takeover tetap lewat WebSocket (JSON kecil) — tidak ikut dipindah; latency input vs feedback visual jadi sinkron karena frame datang via UDP.

---

## 2. WORKSTREAM A — Migrasi ke WebRTC

### 2.1 Arsitektur LANDED (pondasi)

```
┌──────────────────────────── Panel (browser-view.html) ───────────────────────────┐
│  <video autoplay muted playsinline> ← MediaStream dari RTCPeerConnection          │
│  overlay: harness cursor div, ripple, annotation (tetap DOM overlay, bukan video) │
│  input takeover: mouseMove/click/scroll/keyboard → WS JSON (tetap TCP, murah)     │
└──────────────┬─────────────────────────────────────────────────────┬─────────────┘
               │ RTCPeerConnection (receiver, iceServers: [])         │ WebSocket /api/browser/ws
               │ media: UDP/SRTP H.264/VP8, hardware-encoded          │ (signaling + input + status + tabs)
               ▼                                                     ▼
┌──────────────────── Server (Node) ───────────────────────────────────────────────┐
│  webrtc.ts: signaling relay — SDP/ICE antara page ↔ panel, retarget tab switch     │
│  manager.ts: headed offscreen window + GPU flags + DPR 1 + attachSignaling(page)   │
│  Tab capture: ACTIVE PAGE CAPTURES ITSELF via getDisplayMedia (tab-capture.ts       │
│    init script di dalam page — RTCPeerConnection hidup di dalam Chromium page).     │
│    TIDAK ADA native WebRTC lib di Node (@roamhq/wrtc dsb. tidak diperlukan).        │
│  CDP SCREENCAST: DIHAPUS TOTAL. TIDAK ADA FALLBACK CDP — video = WebRTC atau nihil. │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**Kunci desain (berbeda dari draft awal — lebih sederhana & tanpa native dep):**
- **Peer WebRTC hidup DI DALAM page Chromium** (init script `TAB_CAPTURE_SCRIPT`), bukan di Node. Page aktif mem-capture dirinya sendiri (`getDisplayMedia` `preferCurrentTab`) lalu streaming langsung ke panel — Node hanya relay SDP/ICE via `page.evaluate` + `exposeFunction`. Zero native binary risk di Windows.
- **CDP screencast dihapus total** — `startScreencast/stopScreencast/adaptQuality/noteFrameSize/castQuality/BROWSER_CAPTURE/screencastOn` tidak ada lagi. Gagal WebRTC = panel tanpa video (state `rtc-error`), BUKAN fallback JPEG.
- **Panel render `<video>` langsung** — zero decode JS, zero JSON frame, zero canvas. Cursor/ripple/annotation tetap overlay DOM.
- **Input takeover tetap WS** (payload kecil, latency TCP ~0 di localhost).
- **Koordinat tetap CSS px 1280×720** (`BROWSER_VIEWPORT`) — `deviceScaleFactor: 1`, input tools & overlay tidak berubah.

### 2.2 Status implementasi per file (pondasi LANDED)

| File | Status | Implementasi |
|---|---|---|
| `server/agents/browser/manager.ts` | ✅ LANDED | Launch `headless: false` + offscreen `--window-position=-32000,-32000` + GPU flags (`--use-gl=angle`, `--enable-gpu-rasterization`) + `--autoplay-policy=no-user-gesture-required`; `deviceScaleFactor: 1`; SEMUA mesin CDP screencast DIHAPUS (`startScreencast/stopScreencast/adaptQuality/noteFrameSize/castQuality/BROWSER_CAPTURE/screencastOn/cdp/cdpPage`); baru: `registerTransport()` hook, `emitSignaling(page, msg)`, `attachSignaling(page)` (addInitScript + exposeFunction `__morikoRtcSignal`), `retargetCapture()` dipanggil di openInNewTab/switchTo/closePage; `ScreencastSubscriber` → `PanelSubscriber`. |
| `server/agents/browser/tab-capture.ts` (BARU) | ✅ LANDED | `TAB_CAPTURE_SCRIPT` — init script in-page: `window.__morikoRtc = { start, accept, addIce, stop, setStreamId }`; acquisition berurutan (streamId extension → `preferCurrentTab` → plain getDisplayMedia); `contentHint='detail'`; ICE queue sebelum remote description; stats 5 s (`fps/kbps/width/height`); `track.onended` → `rtc-ended`. |
| `server/agents/browser/webrtc.ts` (BARU) | ✅ LANDED | `browserRTC` singleton: `startForPanel` (stop peer lama → getActivePage → evaluate `start()`), `stopForPanel` (ws close), `answer(sdp)`, `ice(candidate)` (evaluate ke page), `onSignaling` (page→panel relay, hanya peer page AKTIF dihormati via stamp `__page`), `retarget()` (tab switch → offer baru). Register ke manager via `registerTransport`. |
| `server/agents/browser/ws.ts` | ✅ LANDED | On connect: `ensureContext().then(() => browserRTC.startForPanel(subscriber))`; snapshot JPEG hello DIHAPUS; handler baru `rtc-answer`/`rtc-ice`/`rtc-restart`; close → `stopForPanel`; header protokol ter-update. Handler input takeover tak tersentuh. |
| `src/browser-view-main.tsx` | ✅ LANDED | canvas/CAPTURE/imgRef/drawFrame DIHAPUS → `<video autoPlay muted playsInline>`; handler `rtc-offer` (RTCPeerConnection `iceServers:[]` → setRemote → createAnswer → kirim `rtc-answer`; ontrack → `srcObject`; onicecandidate → `rtc-ice`; gagal → `rtc-restart`), `rtc-ice`; cleanup menutup pc; `toViewport`/`focusPanel` pakai `videoRef`. Overlay cursor/ripple/annotation tetap. |
| `src/styles/browser-view.css` | ✅ LANDED | `.bp-frame canvas` → `.bp-frame video` (+ `object-fit: contain`, background hitam). |
| `package.json` | ✅ TIDAK BERUBAH | Tidak ada dependency baru — peer di dalam Chromium page. |

### 2.3 Protocol WS (final, landed)

```
SERVER → PANEL
  rtc-offer  { sdp }                          — WebRTC offer dari in-page peer
  rtc-ice    { candidate }                    — ICE (page → panel)
  rtc-state  { state }                        — pc.connectionState / 'capture-ended'
  rtc-stats  { fps, kbps, width, height }     — tiap 5 s
  rtc-error  { error }                        — capture/negotiation gagal
  (pesan lain tetap: hello, statusChange, tabList, cursorUpdate,
   cursorClick, cursorDrag, annotation, scrolled)

PANEL → SERVER
  rtc-answer  { sdp }
  rtc-ice     { candidate }
  rtc-restart                                  — minta offer ulang
```

`?transport=cdp` debug param: TIDAK ADA — CDP dihapus total.

### 2.4 Urutan implementasi & SISA PEKERJAAN (untuk agent lanjutan)

Pondasi (A1 + A3 + A4 tanpa fallback) sudah landed. Sisa:

1. **[LANDED] A1 — GPURamp**: headed offscreen + GPU flags + DPR 1 + CDP dihapus total. ✅
2. **[LANDED] A3/A4 — pipeline penuh**: tab-capture.ts + webrtc.ts + ws signaling + panel `<video>`. ✅ (typecheck clean; runtime belum diverifikasi)
3. **[LANDED, belum terverifikasi runtime] A2 — capture acquisition**: manager sekarang `headless: true` (new) + `--use-fake-ui-for-media-stream` — getDisplayMedia auto-accept terhadap virtual display browser sendiri, tanpa picker, dan tidak ada desktop user yang bisa terekam (privacy-safe by construction). Diagnosis pendukung: run e2e pertama (headed offscreen) menunjukkan `start()` menggantung selamanya di picker dialog (hello sampai, offer/error tidak pernah datang). KONFIGURASI INI BELUM DIVERIFIKASI RUNTIME — trial manual user adalah penentu.
4. **[LANDED] Multi-panel (satu arah)**: panel baru menerima stream, panel lama menerima `rtc-state: 'superseded'` + banner. Fan-out penuh per-panel tetap TODO jika diperlukan.
5. **[LANDED] Cursor imperative**: `cursorUpdate`/`userCursor`/`hello` menggerakkan overlay via `ref.style` langsung — nol re-render per pergerakan cursor.
6. **[LANDED] Panel status UI**: overlay "Connecting video…" / error + tombol Retry (`rtc-restart`), stats `fps · Mbps · resolusi` di menu panel.
7. **[TODO] Verifikasi runtime oleh user** (manual trial): buka panel, cek video hidup, ketajaman teks, latency takeover, stats di menu. `scripts/test-browser-rtc.mjs` tersedia di repo — dijalankan HANYA bila user memintanya.

### 2.5 Testing Workstream A

- **Manual E2E (primary)**: buka panel, verifikasi (a) ketajaman teks pada halaman padat teks (mis. docs site), (b) latency ketik saat takeover < ~100 ms terasa, (c) scroll halus 60 fps pada halaman animasi, (d) reconnect setelah `harness_reload`, (e) multi-tab: `browser_switch_tab` harus re-negotiate capture tanpa panel refresh.
- **A3 gate**: script e2e `scripts/test-browser-rtc.mjs` (pattern `scripts/test-reload-e2e.mjs`): spawn server, headless client WS, assert `iceConnectionState === 'connected'` ≤ 5 s dan ≥1 video frame stat > 0 dalam 10 s.
- **Diag**: `browser_debug` panel harus menampilkan `{transport, fps, bitrate, resolution, rtt}` dari `getStats` — user bisa lihat angka sendiri.
- **DILARANG menutup riset hanya dengan e2e** — validasi akhir adalah trial manual user (sesuai aturan kerja).

### 2.6 Risiko & mitigasi (diperbarui — CDP fallback DIHAPUS)

| Risiko | Mitigasi |
|---|---|
| **getDisplayMedia picker/user-gesture di headed offscreen** (TITIK RISIKO UTAMA — §2.7) | Acquisition terisolasi di `acquire()` (tab-capture.ts) — tiga jalur dicoba berurutan + hook `setStreamId` untuk extension path; kalau picker muncul, window perlu di-un-park sementara ATAU pakai extension + `chromeMediaSourceId` |
| WebRTC gagal total | TIDAK ADA fallback CDP (keputusan user) — panel menampilkan `rtc-error`; debugging via DevTools panel + `browser_debug` |
| `headless: false` menampilkan window | `--window-position=-32000,-32000`; verifikasi taskbar saat runtime |
| ICE di localhost | `iceServers: []` di kedua sisi — host candidates langsung connect |
| FPS drop (GPU lemah) | `contentHint='motion'` fallback; `maxFramerate` 30 → 24 → 15 via `applyConstraints` |
| Peer tidak dibersihkan saat page crash/navigasi | `stopActive()` silent-catch + `track.onended` → `rtc-ended`; panel bisa kirim `rtc-restart` |

### 2.7 OPEN POINT — capture acquisition (DIAGNOSIS DIPEROLEH, config dipindah ke headless=new + fake UI)

**Temuan runtime (e2e 1 Okt, headed offscreen):** `hello` diterima, tetapi TIDAK ada `rtc-offer` dan TIDAK ada `rtc-error` — `start()` menggantung tanpa batas di dalam `getDisplayMedia` karena picker dialog terbuka di window offscreen `-32000` yang tidak pernah bisa dijawab. Headed tanpa mekanisme auto-pick = dead end.

**Konfigurasi sekarang (manager.ts):** `headless: true` (Chromium **new** headless) + `--use-fake-ui-for-media-stream` — getDisplayMedia di-auto-accept terhadap virtual display yang hanya berisi browser itu sendiri, sehingga:
- Tidak ada picker yang bisa menggantung.
- Tidak ada desktop user yang bisa terekam — privacy aman secara konstruksi, bukan by trust.
- GPU flags tetap terpasang; hardware encode di headless=new mengikuti ketersediaan GPU, software (SwiftShader) sebagai bawahannya — localhost tetap murah.

**Status: BELUM TERVERIFIKASI RUNTIME.** Verifikasi adalah trial manual user (buka panel → video hidup? teks tajam? latency oke? stats muncul di menu?). Jika headless=new ternyata menolak getDisplayMedia (error `NotAllowedError`/`NotFoundError` di `rtc-error` panel), jalur cadangan yang sudah disiapkan:

- **B. Extension + desktopCapture**: unpacked extension via `--load-extension` (persistent context); `chrome.desktopCapture.chooseDesktopMedia(['tab'])` + `--auto-select-desktop-capture-source=<label>`; sambungkan via `__morikoRtc.setStreamId(id)` (hook sudah ada di tab-capture.ts).
- **C. Un-park window on picker**: headed + pindahkan window on-screen sementara saat picker muncul.

JANGAN pernah memakai `--use-fake-ui-for-media-stream` di mode **headed** tanpa isolasi display — di headed, auto-accept bisa menangkap desktop sungguhan user (privacy). Di headless ia aman karena virtual display-nya kosong.

---

## 3. WORKSTREAM B — Toggle On/Off Web Access di Sidebar Configuration

### 3.1 Masalah

Agent "pecandu web" terus membuka situs meski dilarang via prompt. Enforcement level sudah mematikan `fetchWeb`+`agentMode` di level ≥2, tapi tidak ada tombol sederhana & permanen yang mematikan **semua** jalur web sekaligus — dan yang ada sekarang (`fetchWeb`) hanya mengontrol proxy `webFetch`, **bukan** `agent__browser_*` maupun `agent__fetch`/`agent__download`.

### 3.2 Desain setting baru

```ts
// src/types.ts (ChatSettings)
/**
 * Master switch untuk SEMUA akses web agent: browser tools
 * (agent__browser_*), fetch (agent__fetch), download (agent__download),
 * dan augmentasi link otomatis di chat. Off = kill-switch keras.
 */
webAccess: boolean;   // DEFAULT: false (opt-in)
```

**Semantik `webAccess: false`** (enforcement sisi server, bukan sekadar prompt):

| Jalur | Efek off |
|---|---|
| `agent__browser_*` (20 tool) | Tidak masuk katalog tool (dicegat di `loop.ts` filter, seperti pola `isTerminalTool`) → model tidak melihat tool sama sekali |
| `agent__fetch` / `agent__download` | Sama — di luar katalog |
| Dispatcher call langsung (termasuk dari `agent__exec` nested) | `callAgentTool` menolak dengan pesan `"Web access is OFF — enable it in Configuration → Tools"` (belt-and-suspenders; exec nested tidak lewat katalog) |
| `webFetch` proxy augmentasi link | `fetchEnabled` di `server/index.ts:497` juga di-AND dengan `settings.webAccess` |
| Browser panel WS | **Hard-off (§3.2a, LANDED)**: saat toggle OFF, server broadcast `shutdown` ke semua panel → panel menutup window-nya sendiri & berhenti reconnect (`browser-view-main.tsx`); context Edge ditutup (`manager.setWebAccess(false)` → `close()`); socket panel baru ditolak + `ensureContext()`/`panel-url` digate `webAccessOn` — tidak ada runtime yang selamat di background |
| `spatial runtime` / mockup (pakai browserManager) | Tetap boleh — bukan akses web eksternal (file:// + workspace); hanya navigasi URL publik yang dicegat |

### 3.3 Perubahan per file

| File | Perubahan | Sifat |
|---|---|---|
| `src/types.ts:210` (dekat `fetchWeb`) | Tambah `webAccess: boolean` + doc comment di atas | KECIL |
| `src/store/useStore.ts:38` (`DEFAULT_SETTINGS`) | `webAccess: false` | KECIL |
| `server/contracts.ts:176` (ChatSettingsDTO) | Tambah field DTO + normalisasi (`=== true`), default false saat undefined (migrasi conversation lama aman) | KECIL |
| `server/agents/tools/catalogue.ts` / **BARU** `server/agents/tools/webTools.ts` | Ekspor `isWebTool(wireName)` — list wireName semua `agent__browser_*` + `agent__fetch` + `agent__download` (sumber kebenaran satu tempat, pattern `isTerminalTool` di `terminal.ts:148`) | KECIL |
| `server/mcp/loop.ts:323` | Filter katalog: `.filter(def => !isWebTool(def.wireName) || settings.webAccess !== false)` — digabung filter existing terminal | KECIL |
| `server/agents/tools/dispatcher.ts:50` (`callAgentTool`) | Guard di routing: `if (isWebTool(wireName) && webAccessOff(ctx)) return { ok:false, isError:true, text: 'Web access is OFF — the user disabled it in Configuration → Tools. Do not attempt web tools.' }` — perlu `webAccess` masuk `AgentToolContext`/settings route (lihat baris berikut) | SEDANG |
| `server/index.ts:497` | `fetchEnabled` di-AND: `settings.webAccess !== false && (...)` | KECIL |
| `server/index.ts:484–486` (enforcement override) | Level ≥2 & ≥3 juga memaksa `webAccess: false` (konsisten dengan `fetchWeb: false` yang sudah ada) | KECIL |
| `src/components/SettingsPanel.tsx:410–426` (section Tools) | Tambah `<ToolToggle label="Web Access" checked={settings.webAccess} onChange={(v) => updateSettings({ webAccess: v })} />` di **posisi paling atas** section Tools (master switch); sub-copy ToolToggle menerima `hint?: string` → "Browser, fetch & download tools for the agent" | KECIL |
| `src/components/SettingsPanel.tsx:1066` (stepper copy) | Level 2 "Constrained" hint update: "Agent tools + web access off; MCP may stay." | KECIL |
| `server/agents/systemPrompt.ts:652` (blok `if (settings.agentMode)`) | Saat `webAccess === false` + agentMode on → injeksi satu kalimat ke system prompt: "Web access is disabled by the user — do not attempt to open websites, fetch, or download" (prompt-layer nudge, enforcement tetap di dispatcher) | SEDANG |
| `server/agents/journal.ts:79–106` | Persist `webAccess` di journal record (pattern `agentMode` yang sudah ada) | KECIL |

### 3.4 UX sidebar (section Tools — hasil akhir)

```
Tools
  ────────────────────────────────
  Web Access              [ ●──OFF ]   ← master switch, paling atas
    Browser, fetch & download tools for the agent
  Structured Outputs      [ ──○ ]
  Use MCP                 [ ──○ ]
  Fetch Web               [ ──○ ]   ← tetap ada, tapi otomatis
                                     redundant saat Web Access off
                                     (disabled + dim, tooltip
                                     "Covered by Web Access off")
```

Detail kecil: ketika `webAccess === false`, toggle `Fetch Web` dirender `disabled` + `opacity-50` + `Tip` penjelasan — konsisten dengan perilaku enforcement (fetchWeb tak berpengaruh saat master off). Ketika `webAccess === true`, `Fetch Web` aktif normal seperti hari ini (fetchWeb mengontrol augmentasi link, webAccess mengontrol tool).

### 3.5 Urutan implementasi Workstream B

1. **B1**: `webTools.ts` (`isWebTool`) + `contracts.ts` DTO + `types.ts` + `DEFAULT_SETTINGS` — type foundation.
2. **B2**: enforcement server: `loop.ts` filter + `dispatcher.ts` guard + `index.ts` fetchEnabled AND + enforcement override. *Sampai sini kill-switch sudah berfungsi penuh via API/manual settings.*
3. **B3**: sidebar UI toggle + disabled-state Fetch Web + stepper copy.
4. **B4**: system-prompt nudge + journal persistence.
5. **B5**: spatial/browser-view.md docs update + `BROWSER-TOOLS-ROADMAP.md` entri baru.

### 3.6 Testing Workstream B

- **Unit-style e2e script** (`scripts/test-webaccess-e2e.mjs`, pattern `test-fetchweb-e2e.mjs` yang sudah ada): POST `/api/chat` dengan settings `webAccess: false` + pesan "open https://example.com" → assert response tool catalogue TIDAK berisi `agent__browser_open`/`agent__fetch`; lalu `webAccess: true` → berisi.
- **Dispatcher guard**: panggilan `agent__exec` nested yang memanggil `tools.browser_open` harus balik `ok:false` dengan pesan kill-switch, bukan error crash.
- **Manual E2E (final gate)**: user mematikan toggle → chat "buka google.com" → agent harus menjawab verbal bahwa web access off (terlihat dari prompt nudge) dan TIDAK ada tool call attempt yang lolos; nyalakan → agent bisa `browser_open` normal.

### 3.7 Risiko & mitigasi

| Risiko | Mitigasi |
|---|---|
| Model "kecanduan" tetap menulis URL di jawaban (tanpa tool) | Prompt nudge (B4) + itu di luar scope tool enforcement — teks bebas, tool terbunuh total |
| Percakapan lama tanpa field `webAccess` | Normalisasi DTO default `false` — konservatif (opt-in), tidak membuka akses diam-diam |
| `spatial-runtime`/mockup rusak oleh guard | `isWebTool` hanya menarget `agent__browser_*` wire tools — spatial internal server-side tidak lewat dispatcher catalogue |
| User lupa toggle off tapi butuh web saat agent jalan | Toggle bersifat per-conversation settings; berubah langsung efektif pada round tool-catalogue BERIKUTNYA (dokumentasikan di hint) |

---

## 4. Urutan Global (interleaved)

```
B1 → B2 → B3 → A1 → B4 → A2 → A3 → A4 → B5 → A5
```

**Rasional**: Workstream B kecil, zero-dependency, langsung menghilangkan rasa sakit user ("agent pecandu web"). Workstream A bertahap: A1/A2 quick wins murah sebelum infrastruktur WebRTC (A3–A5) yang lebih besar.

## 5. Definition of Done

- [ ] `webAccess` toggle tampil & berfungsi di sidebar Configuration → Tools (B3)
- [ ] Dengan off: katalog tool tanpa web tool, dispatcher guard balik pesan jelas, fetchWeb augmentasi mati (B2)
- [ ] Dengan on: perilaku browser/fetch/download identik hari ini
- [ ] Panel transport WebRTC connected (`transport: 'webrtc'` di panel status + `browser_debug` menampilkan fps/rtt)
- [ ] Teks pada panel tajam pada DPR tinggi tanpa q60 fallback (Q2/Q3/Q4 hilang)
- [ ] Latency typing takeover terasa < ~100 ms; scroll 60 fps mulus (verifikasi manual user — bukan hanya e2e)
- [ ] Fallback CDP tetap berfungsi (uji dengan `?transport=cdp`)
- [ ] `pnpm typecheck` bersih; e2e scripts `test-webaccess-e2e.mjs` + `test-browser-rtc.mjs` hijau
- [ ] Docs: `BROWSER-TOOLS-ROADMAP.md` + section baru di `PLAN-BROWSER-HARNESS.md` (§21 "WebRTC transport") ter-update

## 6. Open Questions (keputusan saat implementasi)

1. **Browser context saat `webAccess` off** — cukup sembunyikan tool, atau juga tutup context Chromium untuk hemat RAM? (Default plan: sembunyikan tool saja; context idle murah karena tak ada screencast saat tanpa subscriber.)
2. **`@roamhq/wrtc` vs `node-datachannel`** — pilih berdasar ketersediaan prebuilt Windows x64 pada saat implementasi; keduanya di-desain swappable di `webrtc.ts`.
3. **HiDPI panel** — dengan `deviceScaleFactor: 1` + video scaler, apakah cukup tajam di laptop HiDPI? Jika tidak: capture 2× + `video.width = 2560` dengan bitrate naik — putus setelah A4 dibandingkan manual.
