# PLAN — Upgrade Tools Agent Moriko: Kualitas Kode, Generasi, Baca Model, 3D/Game, Arsitektur

> Status: **SIAP DIKERJAKAN** · Penulis audit: Moriko (sesi 2026-10-10) · Target pelaksana: agent lain
> Lingkup: `server/agents/**`, `server/mcp/loop.ts`, `src/components/VisualCard.tsx` (hanya untuk F5.1)

---

## 0. Cara Memakai Dokumen Ini (WAJIB dibaca agent pelaksana)

1. Kerjakan **per fase, berurutan** (F0 → F7). Tiap fase punya: tujuan, file yang disentuh,
   spesifikasi, kriteria terima (Acceptance Criteria/AC), dan risiko.
2. Buat **Goal + Todos** di awal (satu goal per fase atau satu goal besar dengan todo per task).
3. Aturan repo (`AGENTS.md`) berlaku penuh:
   - Server ESM → import relatif **pakai ekstensi `.js`**.
   - `pnpm typecheck` wajib hijau di akhir (pakai `agent__typecheck`).
   - DILARANG `git push` tanpa izin. Commit lokal boleh.
   - UI: tanpa atribut `title` native, tanpa `localStorage`, pakai komponen tema (`Tip`, `Modal`, `showNotice`).
   - Jangan menambah fitur di luar plan ini.
4. **Kebijakan verifikasi**: jangan menjalankan test di tengah pekerjaan. Di akhir fase cukup
   `agent__typecheck` + test yang sudah ada (`agent__test_run`) **bila diminta user**. DILARANG
   menulis skrip E2E/manual-test buatan sendiri. Uji akhir = trial manual oleh user (daftar di §9).
5. **Dependensi baru** (npm) = titik keputusan → tanya user via `agent__ask_user` sebelum `pnpm add`.
   Dependensi yang sudah ada dan boleh dipakai: `typescript ^5.7.2`, `playwright-core 1.49.1`, `tsx`.
6. Setiap tool baru WAJIB melewati **Checklist Integrasi Tool** (§8).
7. Komentar kode: singkat, padat. Tanpa komentar bertele-tele.

---

## 1. Ringkasan Eksekutif

Harness Moriko sudah kuat di **keamanan edit** (read-receipt, vault, checkpoint, expectedReadHash,
syntax guard), **navigasi** (grep receipt, fold, tree index, LSP dasar), dan **UI spatial**. Kelemahan
utamanya:

| Area | Kondisi sekarang | Dampak |
| --- | --- | --- |
| Graph dependensi | `agent__deps` **salah** untuk server ESM (`.js` → `.ts` tidak dipetakan) | Blast radius = 0 padahal 25 file bergantung → agent mengubah API publik dengan percaya diri yang salah |
| LSP | versi script konstan, tanpa tsconfig, rename hanya listing | Hasil basi setelah edit; refactor manual dan rawan |
| Search | BM25 leksikal, tokenizer tidak memecah camelCase, label "semantic" menyesatkan | Query natural ("truncate output") gagal menemukan `truncateOutput` |
| Kualitas kode | Tidak ada lint, format, diagnostics per-file, metrics, review diff | Kualitas hasil generasi hanya dijaga `tsc` full di akhir |
| Syntax guard | Hanya `.json` dan `.js/.mjs/.cjs` | Edit `.ts/.tsx/.css/.html` yang rusak tetap tertulis |
| Test runner | Hanya `node --import tsx --test` | Proyek user dengan vitest/jest/pytest tidak bisa diuji |
| 3D / Game | Visual sandbox CSP `default-src 'none'` + cap 256 KB; runtime probe tanpa console/WebGL/FPS; `browser_*` mati total saat Web Access OFF (termasuk localhost) | Agent tidak bisa memverifikasi game/3D yang ia buat |
| Arsitektur | Tidak ada peta modul/layer, deteksi siklus, aturan layer, ADR, scaffold | Generasi kode tingkat tinggi tanpa pagar arsitektur |
| Registry tool | Catalogue 1343 baris + switch dispatcher + `READ_ONLY_TOOLS` manual di loop.ts | Tiga sumber kebenaran → drift setiap tool baru |

Rencana ini: **8 fase**, ±19 tool baru/upgrade, diurutkan dari perbaikan bug yang paling merusak
kepercayaan (F1) ke kapabilitas baru (F3–F6).

---

## 2. Inventaris Tools Saat Ini (hasil baca kode)

Lokasi: `server/agents/tools/*` (45 file), dirutekan oleh `dispatcher.ts` melalui `pipeline.ts`
(schemaValidator → spatialGate → auditHook), didefinisikan di `catalogue.ts`.

| Kategori | Tools | File utama |
| --- | --- | --- |
| Baca | list, grep, read_file (window/outline/fold), read_all, batch_read, glob, tree_outline/refresh, search | `read.ts`, `grep.ts`, `fold.ts`, `treeIndex.ts`, `search.ts` |
| Edit | edit_file, multi_edit, edit_lines, edit_between, insert_at_line, write, apply_patch | `edit-core.ts`, `edit-default.ts`, `patch.ts`, `edit-diagnostics.ts` |
| File ops | rename, move, copy, delete, vault_list/restore, checkpoint/undo/list | `transfer.ts`, `vault.ts`, `checkpoint.ts` |
| Navigasi kode | lsp_symbols, deps, explain_error | `lsp.ts`, `deps.ts`, `explain-error.ts` |
| Build/test | typecheck, test_run, run, git, task_start/output/stop | `typecheck.ts`, `test-run.ts`, `terminal.ts`, `bg-task.ts` |
| UI | spatial (map/check/diff/runtime/mockup), layout_edit, render_visual | `spatial.ts`, `spatial-runtime.ts`, `visual.ts` |
| Orkestrasi | exec (vm sandbox), goals, ask_user, remind, addon_manage | `exec.ts`, `goals.ts`, `ask.ts`, `addonManage.ts` |
| Web (gated) | 58 `browser_*`, fetch, download | `browser.ts`, `net.ts`, `web-access.ts` |
| Lain | backend (SQLite), image/image_models, vision, harness_reload, lockdown | `backend.ts`, `image.ts`, `vision.ts` |

---

## 3. Temuan Bug & Gap (dengan bukti)

> Semua bukti diverifikasi dengan membaca kode / menjalankan tool pada sesi audit.

### B1 — `agent__deps` salah total untuk TS ESM (KRITIS)
- **Bukti live**: `agent__deps server/agents/tools/shared.ts` → `imported by (0)`, `external packages: .png, node:path`.
  `agent__lsp_symbols references truncateOutput` pada file yang sama → **25 file** mengimpor.
- **Penyebab 1** (`server/agents/deps.ts`, resolver relatif): spesifier `./shared.js` tidak
  dipetakan ke `shared.ts` (konvensi TS ESM / `moduleResolution: NodeNext|Bundler`).
- **Penyebab 2** (`extractSpecifiers`, baris 89–104): setelah kata `export`, scanner mengambil
  **string pertama** di baris yang sama walaupun tidak ada `from` → `export const X = new Set(['.png', …])`
  tercatat sebagai import `.png`.
- **Penyebab 3**: tidak membaca `tsconfig.json` `paths`/`baseUrl` (alias `@/…` di SPA).

### B2 — LSP basi & terbatas (TINGGI)
- `server/agents/tools/lsp.ts:36` `getScriptVersion: () => '1'` konstan + service di-cache selamanya
  (`cachedService`, tanpa invalidasi). Setelah edit, DocumentRegistry boleh memakai SourceFile lama →
  posisi/referensi melenceng.
- `getCompilationSettings` hardcoded (jsx `React`, tanpa `paths`) — tidak membaca tsconfig proyek.
- Mode `rename` hanya mendaftar lokasi; tidak menerapkan edit. Tidak ada `hover`, `diagnostics`,
  `implementations`, `type_definition`, `call_hierarchy`.

### B3 — Search tidak benar-benar "semantic" (SEDANG)
- `server/agents/search.ts:76` tokenizer `split(/[^a-z0-9_]+/)` setelah lowercase → `truncateOutput`
  menjadi satu token `truncateoutput`; `snake_case` juga tidak terpecah.
- `MAX_INDEX_FILES = 1500` (baris 21), invalidasi = rebuild penuh (baris 149).
- Deskripsi catalogue/prompt menyebut "semantic" padahal leksikal → model salah ekspektasi.

### B4 — Parser typecheck sempit (SEDANG)
- `server/agents/tools/typecheck.ts:24` regex hanya format `file(l,c): error TSxxxx`. Perintah custom
  dengan `--pretty` (format `file:l:c - error TSxxxx`) → 0 error terparse, model melihat raw output.

### B5 — Test runner satu ekosistem (SEDANG)
- `server/agents/tools/test-run.ts:123` selalu `node --import tsx --test`. Hitungan hanya `# pass`/`# fail`
  (baris 26–27); `skip`/`todo`/`cancelled` hilang. Tidak ada deteksi vitest/jest/pytest/cargo/go.

### B6 — Syntax guard tidak mencakup TS/TSX/CSS/HTML (TINGGI untuk kualitas generasi)
- `server/agents/tools/edit-core.ts:310–337` hanya `.json` + `.js/.mjs/.cjs`. `typescript` sudah ada
  di dependencies → `ts.createSourceFile` + `parseDiagnostics` bisa memvalidasi `.ts/.tsx/.mts/.cts/.jsx`
  in-process tanpa spawn.

### B7 — Fold tidak mengenal shader/game script
- `server/agents/fold.ts:57–66`: brace-languages tanpa `.glsl .vert .frag .wgsl .hlsl .shader .compute`;
  indent-languages hanya `.py/.pyi` (tanpa `.gd` GDScript). `.lua` tidak ada.

### B8 — Visual sandbox tidak bisa 3D nyata
- `server/agents/tools/visual.ts`: CSP `default-src 'none'` + cap 256 KB. three.js minified > 600 KB →
  mustahil diinline. Hanya WebGL mentah yang mungkin → kualitas demo 3D buruk.

### B9 — Runtime probe buta terhadap error & GPU
- `server/agents/spatial-runtime.ts`: tidak ada listener `console`/`pageerror` (grep 0 match),
  tidak ada info WebGL, FPS, canvas-blank detection. Channel `msedge` hardcoded (baris 297) tanpa
  fallback `chromium`.

### B10 — Web Access OFF mematikan pengujian localhost
- `server/agents/tools/web-access.ts:15–17`: semua `agent__browser_*` dianggap web publik. Saat OFF,
  agent tidak bisa membuka dev server **localhost** miliknya sendiri (hanya `spatial runtime`).

### B11 — Tiga sumber kebenaran registry
- `catalogue.ts` (definisi), `dispatcher.ts` (switch), `server/mcp/loop.ts:604` (`READ_ONLY_TOOLS`
  manual), `web-access.ts` (prefix), `terminal.ts:241` (`isTerminalTool`). Tool baru gampang lupa
  didaftarkan di salah satunya (mis. read-only tapi tidak diparalelkan, atau web tapi tidak di-gate).

### Gap fitur (tidak ada sama sekali)
- G1 Lint / format / diagnostics per file / post-edit diagnostics.
- G2 Code metrics (kompleksitas, panjang fungsi, hotspot), dead-code / unused export.
- G3 Refactor otomatis (rename lintas file, move file + update import).
- G4 Review diff sesi (checklist statis sebelum "done").
- G5 Peta arsitektur (layer, siklus, fan-in/out), aturan layer, ADR, scaffold template.
- G6 Baca berbasis simbol (`read_symbol`), context pack (simbol + tipe + pemanggil).
- G7 3D/game: game probe, shader check, asset inspect (glTF/GLB/tekstur), library vendor untuk visual,
  domain prompt pack.

---

## 4. Prinsip Desain

1. **Output ringkas & terstruktur** — setiap tool baru mengembalikan header 1 baris + daftar
   `path:line:col  pesan` + footer saran langkah berikut. Patuhi `truncateOutput` / `MAX_OUTPUT_CHARS`.
2. **Read receipt** — tool yang mengembalikan isi kode (read_symbol, context_pack) WAJIB memberi receipt
   via read-policy (`recordRead`-equivalent) agar bisa langsung diedit.
3. **Tanpa dependensi baru secara default** — pakai `typescript` Compiler API & `playwright-core`.
   Linter/formatter/test runner proyek user dideteksi dan dipanggil lewat `runProcess` bila ada,
   dilewati dengan pesan jelas bila tidak.
4. **Degradasi halus** — playwright/browser tidak ada → pesan instalasi, bukan throw.
5. **Windows-first** — path `\`/`/`, `.cmd` shim (`npx.cmd`, `pnpm.cmd`), CRLF.
6. **Workspace jail** — semua path lewat `resolveWithPermission`; probe hanya `localhost`/private.
7. **Satu sumber kebenaran** — metadata tool (readOnly, web, terminal, category) hidup bersama definisinya (F0).

---

## 5. Roadmap Fase

| Fase | Nama | Prioritas | Estimasi | Bergantung |
| --- | --- | --- | --- | --- |
| F0 | Tool registry terpadu | Tinggi (fondasi) | 0.5–1 hari | — |
| F1 | Perbaikan bug (B1–B7, B11) | KRITIS | 1–1.5 hari | F0 (B11) |
| F2 | Kualitas baca model | Tinggi | 1 hari | F1 (LSP) |
| F3 | Kualitas kode & verifikasi | Tinggi | 1.5 hari | F1, F2 |
| F4 | Arsitektur tingkat tinggi | Sedang | 1.5 hari | F1 (deps) |
| F5 | 3D & Game | Sedang | 2 hari | F1 (B9), keputusan dep |
| F6 | Prompt & panduan generasi | Sedang | 0.5 hari | F2–F5 |
| F7 | Dokumentasi & penutupan | — | 0.25 hari | semua |

---

## F0 — Tool Registry Terpadu

**Tujuan**: metadata tool di satu tempat; tool baru cukup didaftarkan sekali.

**File baru**: `server/agents/tools/registry.ts`

```ts
export interface ToolSpec {
  def: AgentToolDef;                 // wireName, description, inputSchema
  handler: (args: Record<string, unknown>, ctx: AgentToolContext) => Promise<HarnessToolResult>;
  readOnly?: boolean;                // boleh paralel di loop
  web?: boolean;                     // di-gate Web Access
  terminal?: boolean;                // di-gate Terminal mode
  category: 'read' | 'edit' | 'nav' | 'quality' | 'arch' | 'game' | 'ui' | 'orchestration' | 'web' | 'misc';
}
export function defineTool(spec: ToolSpec): ToolSpec;
export function registeredTools(): ToolSpec[];
export function toolByName(wireName: string): ToolSpec | undefined;
```

**Langkah (inkremental, JANGAN big-bang)**:
1. Buat `registry.ts`. Tool BARU di plan ini wajib memakai `defineTool` di file masing-masing dan
   diimpor sekali dari `tools/index.ts` (side-effect import list).
2. `catalogue.ts`: di akhir `listAgentToolDefs()` gabungkan `registeredTools().map(t => t.def)`.
3. `dispatcher.ts`: sebelum `switch`, cek `toolByName('agent__' + call.name)` → panggil handler.
4. `loop.ts`: `isParallelSafe` = `READ_ONLY_TOOLS.has(name) || toolByName(name)?.readOnly === true`.
5. `web-access.ts` `isWebTool` dan `terminal.ts` `isTerminalTool`: tambahkan `|| toolByName(name)?.web/terminal`.
6. Migrasi tool lama ke registry = **opsional, di luar plan** (catat sebagai follow-up).

**AC**: tool dummy tidak perlu dibuat; cukup typecheck hijau dan semua tool baru F1–F5 terdaftar hanya via `defineTool`.

**Risiko**: urutan import (registry kosong saat catalogue dipanggil) → pastikan `tools/index.ts` mengimpor modul tool baru sebelum ekspor `listAgentToolDefs`.

---

## F1 — Perbaikan Bug

### F1.1 `deps.ts` (B1)
- **Resolver**: untuk spesifier relatif berakhiran `.js/.jsx/.mjs/.cjs`, coba berurutan: path apa adanya →
  ganti ekstensi ke `.ts/.tsx/.mts/.cts` → `index.*`. Tanpa ekstensi: `.ts .tsx .js .jsx .mjs .cjs` lalu `/index.*`.
- **Extractor**: ganti scanner manual dengan `ts.preProcessFile(source, true, true)` (TypeScript API,
  mengembalikan `importedFiles` termasuk dynamic import & require). Hapus false-positive `export const … '.png'`.
- **tsconfig paths**: baca `tsconfig*.json` terdekat (pakai `ts.readConfigFile` + `ts.parseJsonConfigFileContent`),
  dukung `baseUrl` + `paths` (wildcard `*`).
- Tambahkan di output: `unresolved (n)` untuk spesifier relatif yang gagal di-resolve (sekarang hilang diam-diam).
- **AC**: `agent__deps server/agents/tools/shared.ts` → importedBy ≥ 20, externals tidak memuat `.png`.

### F1.2 `lsp.ts` (B2)
- Versi script: `Map<fileName, {version, mtimeMs}>`; `getScriptVersion` = `String(mtimeMs)` dari `statSync`
  (murah, otomatis basi-aman). Alternatif: increment versi dari `recordAfterWrite` (read-policy).
- Konfigurasi: cari tsconfig terdekat dari file target (`ts.findConfigFile`), parse, cache per-tsconfig
  (bukan per-root) → SPA (`tsconfig.json`) dan server (`tsconfig.server.json` bila ada) benar.
- Pindahkan pembuatan service ke `server/agents/lsp-service.ts` (dipakai ulang F2/F3): ekspor
  `getLanguageService(absFile)`, `invalidateFile(absFile)`.
- Mode baru: `hover` (quickInfo + dokumentasi JSDoc), `diagnostics` (syntactic+semantic satu file),
  `implementations`, `type_definition`, `call_hierarchy` (incoming/outgoing, depth 1).
- Mode `rename`: tetap listing; penerapan dipindah ke `agent__refactor` (F3.5).
- **AC**: setelah `edit_file` menambah baris di atas simbol, `references` mengembalikan baris yang sudah bergeser.

### F1.3 `search.ts` (B3)
- Tokenizer: pecah camelCase/PascalCase/snake/kebab/dot + simpan token utuh:
  `truncateOutput` → `truncateoutput, truncate, output`. Stemming ringan (hapus `s`, `ing`, `ed` bila panjang > 4).
- Boost: kecocokan pada **path** ×2, pada **nama simbol yang dideklarasikan** (regex `function|class|interface|type|const X`) ×3.
- Snippet: pilih jendela dengan kepadatan term query tertinggi (bukan baris awal blok).
- Invalidasi inkremental: `invalidateSearchIndex(root, relPath?)` → re-index satu dokumen bila path diberikan.
- Naikkan `MAX_INDEX_FILES` ke 4000 dengan batas total byte (mis. 40 MB) sebagai pengaman.
- Ubah deskripsi catalogue: "Lexical BM25 search (camelCase-aware) by keywords/meaning" — hilangkan klaim "semantic".
- **AC**: query `truncate output` menempatkan `server/agents/tools/shared.ts` di 3 besar.

### F1.4 `typecheck.ts` (B4)
- Tambah regex kedua `^(.+?):(\d+):(\d+) - (error|warning) (TS\d+): (.+)$` dan strip ANSI (`/\x1b\[[0-9;]*m/g`).
- Bila 0 error terparse tetapi exit ≠ 0 → tampilkan 40 baris terakhir raw output (bukan seluruhnya).
- Opsi `paths?: string[]` → filter hasil ke file tersebut (untuk fokus pada file yang disentuh).

### F1.5 `test-run.ts` (B5)
- Deteksi runner (urutan): arg `runner` eksplisit → `package.json` scripts/devDeps (`vitest`, `jest`) →
  `pytest.ini|pyproject [tool.pytest]` → `Cargo.toml` → `go.mod` → default `node --test` (tsx).
- Parser per runner: vitest/jest `--reporter=json` / `--json`; pytest `-q -rA` summary; node TAP (yang ada) +
  `# skipped`, `# todo`, `# cancelled`.
- Output seragam: `PASS n · FAIL n · SKIP n` + per kegagalan `file › nama test` + 8 baris pesan.
- Windows: gunakan `npx.cmd` / `pnpm.cmd` via `shell: true` seperti `terminal.ts`.

### F1.6 Syntax guard TS/TSX/CSS/HTML (B6) — `edit-core.ts` `verifyWrittenSyntax`
- `.ts/.tsx/.mts/.cts/.jsx`: `ts.createSourceFile(name, text, ScriptTarget.Latest, true, kind)` lalu
  `(sf as any).parseDiagnostics` → bila ada, gagal dengan 3 pesan pertama `line:col message`.
  (Gunakan `ts.transpileModule(text, { reportDiagnostics: true })` sebagai alternatif API publik.)
- `.css`: cek keseimbangan `{}` dan komentar tertutup (heuristik ringan; jangan false-fail pada `@layer`).
- `.html`: lewati (terlalu toleran untuk divalidasi) — dokumentasikan.
- **Wajib**: tetap tidak pernah false-fail; error internal → `{}`.
- **AC**: `edit_file` yang meninggalkan `}` hilang di `.tsx` di-rollback dengan pesan baris.

### F1.7 Fold untuk shader/game (B7) — `fold.ts`
- Brace: `.glsl .vert .frag .geom .comp .wgsl .hlsl .fx .shader .compute .cginc .gdshader`.
- Indent: `.gd` (GDScript, kolon + indent seperti Python).
- `.lua`: block `function … end` — implementasi heuristik keyword (`function|if|for|while|do` ↔ `end`) atau
  tunda (tandai TODO di plan, bukan di kode).

### F1.8 Sinkronisasi registry (B11)
- Setelah F0, audit `READ_ONLY_TOOLS` di `loop.ts:604`: pastikan `agent__lsp_symbols`, `agent__glob`,
  `agent__tree_outline`, `agent__checkpoint_list`, `agent__goal_list` ada bila memang read-only (cek handler
  tidak menulis apa pun). Tool baru read-only memakai flag registry.

---

## F2 — Kualitas Baca Model

### F2.1 `agent__read_symbol` (BARU, readOnly)
Membaca **tepat** rentang sebuah simbol, bukan jendela baris tebakan.

```jsonc
{ "path": "server/agents/tools/lsp.ts", "symbol": "getService",   // atau "Class.method"
  "include": ["jsdoc", "signature-only"?],                         // opsional
  "maxLines": 400 }
```
- TS/JS: AST (`lsp-service.ts`) → `NavigationTree` cari nama (dukung `A.b`, overload → semua).
- Bahasa lain: pakai `fold.ts` (blok dengan header cocok nama).
- Output = format `read_file` (bernomor) + receipt untuk rentang itu + breadcrumb `Class › method`.
- Bila tidak ditemukan: 5 kandidat fuzzy (`fuzzy.ts`).

### F2.2 `agent__context_pack` (BARU, readOnly)
Satu panggilan → konteks minimal untuk mengubah sebuah simbol dengan aman.

```jsonc
{ "path": "...", "symbol": "finishEdit", "budgetChars": 12000,
  "include": ["body", "types", "callers", "callees", "tests"] }
```
- `body`: isi simbol (dengan receipt).
- `types`: deklarasi tipe yang dirujuk di signature (via `getTypeDefinitionAtPosition`), **signature saja**.
- `callers`: `findReferences` → per pemanggil 1 baris + nama fungsi pembungkus (maks 15).
- `callees`: fungsi yang dipanggil di dalam body → signature.
- `tests`: file `*.test.*`/`*.spec.*` yang menyebut simbol.
- Pengisian rakus sampai `budgetChars`; bagian yang terpotong diberi tanda `[+N more, call read_symbol]`.

### F2.3 Grep beranotasi simbol
- `grep.ts`: opsi `enclosing: true` (default ON untuk TS/JS bila hasil ≤ 50) → setiap hit diberi
  `⟨in function foo⟩` dari fold/AST. Memperjelas konteks tanpa membaca file.

### F2.4 Outline AST untuk TS/JS
- `read.ts` mode `outline` untuk `.ts/.tsx/.js/.jsx`: pakai `NavigationTree` (akurat untuk arrow function
  `const x = () =>`, method objek, overload, enum) sebagai ganti regex `outlineEntry`. Fallback regex tetap.

### F2.5 Panduan prompt baca
- `systemPrompt.ts` bagian Reading: tambahkan baris "simbol diketahui → `read_symbol`; akan mengubah API → `context_pack`".

**AC F2**: model dapat mengedit fungsi di file 1500+ baris dengan 1 panggilan `read_symbol` + 1 edit (tanpa fold manual).

---

## F3 — Kualitas Kode & Verifikasi

### F3.1 `agent__diagnostics` (BARU, readOnly)
Diagnostik TypeScript **per file** dalam milidetik (tanpa `tsc` penuh).
```jsonc
{ "paths": ["src/a.tsx"], "scope": "touched" | "paths", "semantic": true }
```
- `scope: "touched"` → file yang diedit di sesi ini (dari audit/journal sesi).
- Output dikelompokkan per file, `TSxxxx` + 1 baris kode sumber.

### F3.2 Post-edit diagnostics hook (pipeline)
- `pipeline.ts`: hook baru `diagnosticsHook` (setelah edit tool sukses pada `.ts/.tsx`) → tambahkan ke
  hasil tool blok `⚠ N new diagnostic(s)` (hanya **baru** dibanding sebelum edit, maks 5) dari `lsp-service`.
- Bisa dimatikan via setting `agentSettings.postEditDiagnostics` (default ON). Timeout keras 1.5 s → lewati.
- Ini **bukan** menjalankan test; hanya analisis statis file yang baru ditulis.

### F3.3 `agent__lint` (BARU)
```jsonc
{ "paths": ["src/**"], "fix": false }
```
- Deteksi: `biome.json` → `biome check`; `eslint.config.*`/`.eslintrc*` → `eslint -f json`; `oxlint` di devDeps;
  Python `ruff check --output-format json`. Tidak ada → `No linter configured` + saran (tanpa memasang).
- `fix: true` dianggap tool mutasi (tidak readOnly) dan menyimpan snapshot vault setiap file yang berubah.

### F3.4 `agent__format` (BARU, mutasi)
- Prettier/biome/ruff format bila terkonfigurasi; snapshot vault sebelum tulis; output = daftar file berubah + diff stat.

### F3.5 `agent__refactor` (BARU, mutasi)
```jsonc
{ "mode": "rename", "path": "...", "line": 10, "column": 5, "newName": "x", "dryRun": true }
{ "mode": "move_file", "from": "src/a.ts", "to": "src/lib/a.ts", "dryRun": true }
{ "mode": "organize_imports", "path": "..." }
```
- `rename`: `findRenameLocations` → kumpulkan edit → terapkan atomik via mesin `patch.ts` (vault, all-or-nothing),
  hormati read-policy (file yang belum dibaca tetap boleh karena edit dihasilkan compiler — catat di audit).
- `move_file`: `getEditsForFileRename` + pindahkan file (`transfer.ts`), pertahankan ekstensi `.js` di import server.
- `organize_imports`: `organizeImports` LS.
- `dryRun` default **true** → menampilkan unified diff.

### F3.6 `agent__code_metrics` (BARU, readOnly)
```jsonc
{ "subpath": "src", "top": 15, "sort": "complexity" | "length" | "hotspot" }
```
- Per fungsi (TS AST): panjang baris, cyclomatic (if/for/while/case/&&/||/?:/catch), kedalaman nesting, jumlah parameter.
- Per file: LOC, jumlah ekspor, fan-in/out (dari deps F1.1).
- `hotspot` = churn git (`git log --since=90.days --name-only`) × LOC.
- Ambang peringatan default: fungsi > 80 baris, cyclomatic > 15, nesting > 4, file > 800 LOC.

### F3.7 `agent__dead_code` (BARU, readOnly)
- Ekspor yang tidak punya importer (deps graph) **dan** tidak punya referensi LS di luar filenya.
- Kecualikan entry point (`main`, `bin`, `exports` package.json, `vite.config`, file route, `register.ts` addon).
- Output: `path:line  export name  (0 refs)` — tanpa auto-hapus.

### F3.8 `agent__review_diff` (BARU, readOnly)
Checklist statis atas perubahan sesi (`scope: "session"`, dari vault/journal) atau `git diff` (`scope: "git"`):
- Sisa `console.log`/`debugger`, `TODO`/`FIXME` baru, `any` baru, `@ts-ignore` baru, `eslint-disable` baru.
- Fungsi baru melewati ambang F3.6.
- Import tidak terpakai (LS `unusedIdentifier` diagnostics 6133).
- Aturan repo (dibaca dari `AGENTS.md` bila ada pola yang bisa dideteksi): atribut `title=` di TSX, `localStorage.`,
  import server tanpa `.js`.
- three.js: `new THREE.*Geometry|Material|Texture` tanpa `.dispose()` di file yang sama (heuristik, F5).
- Output: `✗ n issue(s)` per kategori + lokasi. Tidak memodifikasi apa pun.

### F3.9 `agent__verify` (BARU, komposit, readOnly kecuali tidak)
Satu pintu verifikasi **di akhir pekerjaan**:
```jsonc
{ "level": "quick" | "full" }
```
- `quick`: diagnostics(touched) → lint(touched) → review_diff(session).
- `full`: + typecheck penuh + test yang terdampak (file test yang termasuk blast radius deps dari file touched).
- Ringkasan satu tabel status + daftar masalah teratas. Prompt menegaskan: dipanggil **sekali di akhir**, bukan per edit.

**AC F3**: setelah tugas edit multi-file, satu `agent__verify quick` memberi status lengkap < 10 s pada repo ini.

---

## F4 — Arsitektur Tingkat Tinggi

### F4.1 `agent__arch_map` (BARU, readOnly)
```jsonc
{ "subpath": "server", "depth": 2, "format": "text" | "mermaid", "focus": "server/agents" }
```
- Agregasi deps graph (F1.1) ke level **modul** (folder pada `depth`): edge berbobot, fan-in/fan-out,
  instability `I = out/(in+out)`.
- **Siklus**: Tarjan SCC di level file & modul; laporkan siklus terpendek per SCC.
- `format: mermaid` → blok ```mermaid graph LR``` (bisa langsung dirender user / dimasukkan ke docs).
- Opsional `render: true` → kirim ke `render_visual` sebagai diagram SVG inline (tanpa library: layout layer sederhana).

### F4.2 `agent__arch_rules` (BARU)
File aturan proyek: `.moriko/architecture.json`
```jsonc
{
  "layers": [
    { "name": "ui",       "paths": ["src/components/**"] },
    { "name": "state",    "paths": ["src/store/**", "src/hooks/**"] },
    { "name": "lib",      "paths": ["src/lib/**"] },
    { "name": "server",   "paths": ["server/**"] }
  ],
  "allow": { "ui": ["state", "lib"], "state": ["lib"], "lib": [], "server": [] },
  "forbid": [{ "from": "src/**", "to": "server/**", "reason": "SPA tidak boleh impor server" }],
  "maxFileLines": 1200,
  "noCycles": true
}
```
- Mode `init` (mutasi): usulkan file dari `arch_map` (layer = folder top-level) → dryRun default.
- Mode `check` (readOnly): laporkan pelanggaran edge, siklus, file kebesaran.
- Integrasi: `agent__verify full` menjalankan `arch_rules check` bila file aturan ada.

### F4.3 `agent__adr` (BARU)
- `docs/adr/NNNN-judul.md` template (Context / Decision / Consequences / Alternatives / Status).
- Mode `new { title, context, decision, ... }`, `list`, `read { id }`, `supersede { id, by }`.
- `systemPrompt` arsitektur: keputusan struktural besar (pola state, pemisahan modul, pilihan engine) → tawarkan ADR.

### F4.4 `agent__scaffold` (BARU, mutasi)
```jsonc
{ "template": "react-feature", "dest": "src/features/gallery", "vars": { "name": "Gallery" }, "dryRun": true }
```
- Template disimpan di `server/agents/templates/<id>/` (file `*.tpl` dengan `{{name}}`, `{{Name}}`, `{{name_kebab}}`).
- Template awal:
  - `react-feature` (komponen + hook + types + index barrel),
  - `express-route` (router + validator + handler, ekstensi `.js` di import),
  - `addon` (addon.json + register.ts + client/index.tsx — sesuai pola Moriko),
  - `three-vite` (F5), `canvas2d-game` (F5), `phaser-game` (F5, butuh dep milik proyek user).
- Menolak menimpa file yang ada; semua file baru melewati `write` path (read-policy, vault).
- `agent__scaffold { "list": true }` → daftar template + variabel.

### F4.5 Panduan arsitektur di prompt (F6)
- Sebelum membuat > 3 file baru atau modul baru → `arch_map` dulu; patuhi `architecture.json` bila ada.

**AC F4**: `arch_map server --format mermaid` menghasilkan graf valid; `arch_rules check` dengan aturan
`src/** ↛ server/**` melaporkan 0 pelanggaran di repo ini (atau pelanggaran nyata bila ada).

---

## F5 — 3D & Game

### F5.1 Vendor library untuk `render_visual` (KEPUTUSAN USER DIPERLUKAN)
**Masalah**: CSP `default-src 'none'` + cap 256 KB → three.js tidak bisa dipakai.

**Desain** (CSP tetap ketat, tanpa network di iframe):
1. Parameter baru `libs?: Array<"three" | "three-addons-orbit" | "pixi" | "matter" | "moriko-gl">` pada `render_visual`.
2. Server menyediakan bundle vendor **lokal** di `GET /api/visual-vendor/:lib` (same-origin harness), dibangun dari
   `node_modules` dengan esbuild (sudah tersedia: `.esbuild/`) menjadi IIFE global (`window.THREE`, dsb.)
   oleh skrip `scripts/build-visual-vendor.mjs`, disimpan di cache MORIKO home.
3. **Client** (`VisualCard.tsx`): sebelum membuat `srcDoc`, fetch teks bundle (cache in-memory per lib) lalu sisipkan
   `<script>…bundle…</script>` di awal `<head>` dokumen model. Bundle **tidak** ikut tersimpan di attachment/percakapan
   (hanya nama `libs`), tidak terhitung dalam cap 256 KB.
4. Iframe tetap `sandbox="allow-scripts"` tanpa `allow-same-origin`, CSP tetap `default-src 'none'` + `script-src 'unsafe-inline'`
   (cek CSP aktual di `VisualCard.tsx` sebelum mengubah apa pun).
5. Opsi tanpa dependensi: `moriko-gl` — helper WebGL2 mini (≤ 15 KB) ditulis di repo
   (`server/agents/vendor/moriko-gl.js`): renderer, kamera perspektif, orbit kontrol, primitive (box/sphere/plane),
   material Lambert/unlit, loop `requestAnimationFrame` + resize + DPR cap 2.

**Pertanyaan ke user** (via `ask_user`): tambahkan `three` (+ `pixi.js`, `matter-js`) sebagai devDependency untuk
dibundel? Jika ditolak → kerjakan hanya `moriko-gl`.

**AC**: `render_visual { libs: ["three"], source }` menampilkan scene three.js berputar; ukuran attachment tersimpan tetap < 256 KB.

### F5.2 `agent__game_probe` (BARU, readOnly, TIDAK di-gate Web Access karena localhost-only)
Menjalankan aplikasi game/3D **milik workspace** di Chromium headless dan melaporkan fakta runtime.
```jsonc
{ "url": "http://localhost:5173", "durationMs": 4000, "viewport": { "w": 1280, "h": 720 },
  "actions": [ { "type": "key", "key": "ArrowRight", "holdMs": 500 }, { "type": "click", "x": 640, "y": 360 } ],
  "screenshots": 3 }
```
- Implementasi di `server/agents/game-probe.ts`, reuse `loadPlaywright` + `assertAllowedTarget` (`allowPublic` **tidak** didukung).
- Launch: coba channel `msedge`, fallback `chromium` (perbaiki juga B9 di `spatial-runtime.ts`), args
  `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist` agar WebGL jalan headless.
- Kumpulkan:
  - `console` (error/warning, dedupe, maks 30), `pageerror` (stack), request gagal (`requestfailed`, 4xx/5xx aset).
  - WebGL: per `<canvas>` → konteks (`webgl2|webgl|2d|webgpu`), `UNMASKED_RENDERER`, ukuran drawing buffer vs CSS × DPR,
    `gl.getError()` setelah sampling, context lost.
  - **FPS**: injeksi `requestAnimationFrame` sampler sebelum load (`addInitScript`) → rata-rata, p95 frame time, jumlah long frame (> 50 ms).
  - **Canvas blank detection**: `toDataURL` kecil / `readPixels` sampel 16 titik → variansi 0 = layar hitam/kosong.
  - three.js hook opsional: bila halaman mengekspos `window.__MORIKO_PROBE__ = { renderer, scene }`, laporkan
    `renderer.info` (draw calls, triangles, geometries, textures) dan jumlah objek scene.
  - Memori: `performance.memory` (bila ada) awal vs akhir → indikasi leak.
  - Screenshot N frame tersebar → disimpan di MORIKO home, path dikembalikan; untuk model ber-vision, kembalikan
    1 screenshot sebagai image part (ikuti pola `read_file` gambar).
- Output ringkas: `✓ running · 58.9 fps (p95 21 ms) · 0 errors · canvas webgl2 1280×720 (DPR 1) · 142 draw calls · 88k tris`.
- **B10**: tool ini sengaja terpisah dari `browser_*` sehingga tersedia saat Web Access OFF; host dibatasi localhost/private.

### F5.3 `agent__shader_check` (BARU, readOnly)
```jsonc
{ "path": "src/shaders/water.frag", "stage": "vertex" | "fragment" | "compute",
  "lang": "glsl" | "wgsl", "glslVersion": "300 es", "defines": { "USE_FOG": 1 },
  "prelude": "three" }
```
- GLSL: halaman kosong di Chromium headless (instance browser di-reuse ±60 s), `gl.shaderSource/compileShader`,
  parse `getShaderInfoLog` → `ERROR: 0:LINE: msg` dipetakan ke baris file (kompensasi baris prelude/defines).
- `prelude: "three"` → sisipkan uniform/attribute bawaan three.js `ShaderMaterial` (`projectionMatrix`, `modelViewMatrix`,
  `position`, `uv`, `normal`, …) agar shader three tidak gagal karena deklarasi hilang.
- WGSL: `navigator.gpu` bila tersedia → `device.createShaderModule().getCompilationInfo()`; bila tidak, kembalikan
  "WebGPU not available headless" (jangan false-fail).
- Ekstraksi shader inline: bila `path` adalah `.ts/.js`, opsi `exportName` untuk mengambil template literal shader.

### F5.4 `agent__asset_inspect` (BARU, readOnly, tanpa dependensi)
```jsonc
{ "path": "public/models/robot.glb", "budget": { "triangles": 100000, "textureMax": 2048, "bytes": 10485760 } }
```
- **glTF/GLB**: parse header GLB (magic `glTF`, chunk JSON + BIN), ringkas: scenes, nodes, meshes (primitives,
  triangles dari accessor index count/3), materials (PBR, alphaMode), textures/images (mime, ukuran bila embedded PNG/JPEG
  dari header), animations (channels, durasi dari accessor max), skins, extensions (`KHR_draco_mesh_compression`,
  `EXT_meshopt_compression`, `KHR_texture_basisu`), bounding box dari accessor min/max `POSITION`.
- **Gambar**: PNG (IHDR), JPEG (SOF), WebP (VP8/VP8L/VP8X), KTX2 (header) → dimensi, power-of-two, perkiraan VRAM
  (w×h×4×1.33 dengan mip).
- **Audio**: WAV (header) durasi/sample rate; OGG/MP3 → ukuran saja.
- Peringatan budget: tekstur non-POT/terlalu besar, mesh tanpa index, tanpa kompresi, file > budget.
- Folder: `path` direktori → tabel ringkas semua aset + total.

### F5.5 Template game (dipakai `agent__scaffold`)
- `canvas2d-game` (tanpa dependensi): loop **fixed timestep** (akumulator, `dt = 1/60`, clamp 250 ms), input map
  (keyboard/pointer), state machine scene (`boot → menu → play → pause`), entity sederhana, resize + DPR, pause saat tab tersembunyi.
- `three-vite`: renderer + kamera + resize + DPR cap, `OrbitControls`, loader GLTF, `dispose()` util, `__MORIKO_PROBE__` hook
  hanya di `import.meta.env.DEV`, struktur `src/{core,systems,entities,assets,shaders}`.
- `phaser-game`: scene boot/preload/play, config scale FIT.
- Semua template memasang hook probe dev-only agar F5.2 dapat membaca statistik.

### F5.6 Fold & review untuk game
- F1.7 (fold shader/GDScript).
- `review_diff` (F3.8) aturan game: `dispose` hilang, `new` di dalam loop render/update (alokasi per frame, heuristik:
  `new THREE.Vector3|Matrix4|Color` di dalam fungsi bernama `update|animate|tick|render|loop`), `setPixelRatio(window.devicePixelRatio)`
  tanpa `Math.min`, `requestAnimationFrame` tanpa jalur pembatalan.

**AC F5**: pada proyek three-vite hasil scaffold, `game_probe` melaporkan fps > 0, 0 error, canvas non-blank;
`shader_check` pada shader dengan typo melaporkan baris yang benar; `asset_inspect` pada GLB melaporkan jumlah segitiga.

---

## F6 — Prompt & Panduan Generasi

File: `server/agents/systemPrompt.ts` (+ `writingRules.ts` bila relevan). Tetap hemat token: catalogue tetap 1 baris per tool.

1. **Reading** (ganti/ tambah ±3 baris): `read_symbol` untuk simbol yang diketahui, `context_pack` sebelum mengubah API,
   `search` adalah leksikal.
2. **Quality** (bagian baru, ±6 baris): pakai `refactor` alih-alih rename manual; jangan biarkan diagnostic baru dari
   post-edit hook; panggil `verify quick` **sekali di akhir**; jangan menulis skrip test sendiri.
3. **Architecture** (bagian baru, ±5 baris): `arch_map` sebelum membuat modul baru; patuhi `.moriko/architecture.json`;
   tawarkan ADR untuk keputusan struktural; scaffold dari template bila tersedia.
4. **Domain packs (injeksi kondisional)** — fungsi `domainPackInjections(root)`:
   - Deteksi 3D/game: `package.json` deps `three|@react-three/fiber|babylonjs|@babylonjs/core|pixi.js|phaser|matter-js|cannon-es|rapier`,
     atau file `project.godot`, `*.uproject`, `ProjectSettings/ProjectVersion.txt` (Unity), `Cargo.toml` berisi `bevy`.
   - Isi pack "Domain · 3D/Game" (≤ 25 baris): fixed timestep, pisahkan update/render, hindari alokasi per frame,
     `dispose` resource GPU, DPR cap 2, resize handler, budget aset (cek `asset_inspect`), shader → `shader_check`,
     verifikasi akhir → `game_probe`, hook `__MORIKO_PROBE__` dev-only.
   - Pack "Domain · Architecture" aktif bila repo > 150 file sumber atau ada `architecture.json`.
   - Pack di-cache per workspace + mtime `package.json`; tampil sebagai `harness_injection` (terlihat user).
5. Update daftar tools di prompt otomatis (sudah dari registry) — pastikan kategori baru muncul.

---

## F7 — Dokumentasi & Penutupan
- `docs/ARCHITECTURE.md`: tambah bagian "Agent tool registry" (F0) dan "Quality/Arch/Game tools".
- Tandai item follow-up (migrasi tool lama ke registry, `.lua` fold, WGSL headless) di akhir dokumen ini.
- `agent__list { mode: "touched" }` untuk audit jejak sesi; `agent__typecheck` hijau.

---

## 6. Ringkasan Tool Baru / Upgrade

| Tool | Status | Fase | readOnly | Gate |
| --- | --- | --- | --- | --- |
| `agent__deps` | upgrade (fix) | F1.1 | ✓ | — |
| `agent__lsp_symbols` (+hover/diagnostics/impl/typeDef/callHierarchy) | upgrade | F1.2 | ✓ | — |
| `agent__search` (camelCase, boost, inkremental) | upgrade | F1.3 | ✓ | — |
| `agent__typecheck` (pretty format, filter paths) | upgrade | F1.4 | ✗ (spawn) | — |
| `agent__test_run` (multi-runner) | upgrade | F1.5 | ✗ | — |
| syntax guard TS/TSX/CSS | upgrade | F1.6 | — | — |
| `agent__read_symbol` | baru | F2.1 | ✓ | — |
| `agent__context_pack` | baru | F2.2 | ✓ | — |
| `agent__diagnostics` + post-edit hook | baru | F3.1–3.2 | ✓ | — |
| `agent__lint` | baru | F3.3 | ✓ (fix=false) | — |
| `agent__format` | baru | F3.4 | ✗ | — |
| `agent__refactor` | baru | F3.5 | ✗ | — |
| `agent__code_metrics` | baru | F3.6 | ✓ | — |
| `agent__dead_code` | baru | F3.7 | ✓ | — |
| `agent__review_diff` | baru | F3.8 | ✓ | — |
| `agent__verify` | baru | F3.9 | ✗ | — |
| `agent__arch_map` | baru | F4.1 | ✓ | — |
| `agent__arch_rules` | baru | F4.2 | check ✓ / init ✗ | — |
| `agent__adr` | baru | F4.3 | list/read ✓ | — |
| `agent__scaffold` | baru | F4.4 | ✗ | — |
| `agent__render_visual` `libs` | upgrade | F5.1 | — | — |
| `agent__game_probe` | baru | F5.2 | ✓ | localhost-only |
| `agent__shader_check` | baru | F5.3 | ✓ | — |
| `agent__asset_inspect` | baru | F5.4 | ✓ | — |

> `readOnly` = boleh paralel di `loop.ts`. Tool yang spawn proses berat (typecheck/test/lint) **jangan** di-paralel
> walaupun tidak menulis file — CPU contention pada Windows.

---

## 7. Struktur File Baru yang Diharapkan

```
server/agents/
├─ lsp-service.ts          # F1.2 — LanguageService per tsconfig + invalidasi
├─ ts-ast.ts               # F2/F3 — helper AST bersama (cari simbol, metrics, enclosing)
├─ arch.ts                 # F4.1–4.2 — agregasi modul, Tarjan SCC, cek aturan
├─ game-probe.ts           # F5.2
├─ shader-check.ts         # F5.3
├─ asset-inspect.ts        # F5.4 — parser GLB/PNG/JPEG/WebP/KTX2/WAV
├─ domain-packs.ts         # F6.4
├─ templates/<id>/**.tpl   # F4.4, F5.5
├─ vendor/moriko-gl.js     # F5.1 (opsi tanpa dependensi)
└─ tools/
   ├─ registry.ts          # F0
   ├─ read-symbol.ts  context-pack.ts                    # F2
   ├─ diagnostics.ts  lint.ts  format.ts  refactor.ts    # F3
   ├─ metrics.ts  dead-code.ts  review-diff.ts  verify.ts
   ├─ arch-map.ts  arch-rules.ts  adr.ts  scaffold.ts    # F4
   └─ game-probe.ts  shader-check.ts  asset-inspect.ts   # F5
scripts/build-visual-vendor.mjs                          # F5.1 (bila dep disetujui)
```

---

## 8. Checklist Integrasi Tool (untuk SETIAP tool baru)

1. Handler di `server/agents/tools/<nama>.ts` dengan signature `(args, ctx) => Promise<HarnessToolResult>`; tidak pernah throw
   (bungkus error → `{ ok:false, isError:true, text }`).
2. `defineTool({ def, handler, readOnly, web, terminal, category })` — deskripsi **1 baris**, parameter hint pendek
   (aturan header `catalogue.ts`).
3. Argumen dibaca dengan helper `str/num/bool` (`shared.ts`); key camelCase (pipeline sudah menormalkan snake_case).
4. Path selalu lewat `resolveWithPermission` / `requireWorkspace`.
5. Output lewat `truncateOutput`; header + daftar + footer langkah berikut.
6. Tool yang mengembalikan isi kode → beri read receipt (pola `grep` receipt / `read_file`).
7. Tool mutasi → vault snapshot sebelum tulis + `recordAfterWrite` + invalidasi search/LSP/deps cache.
8. File UI yang ditulis → pastikan spatial gate `pipeline.ts` (`collectGateFiles`) mengenali tool baru bila relevan.
9. Tambah baris panduan di `systemPrompt.ts` hanya bila workflow baru (bukan mengulang deskripsi).
10. Import relatif ber-ekstensi `.js`. `agent__typecheck` hijau.

---

## 9. Daftar Trial Manual untuk User (setelah implementasi)

| # | Skenario | Harapan |
| --- | --- | --- |
| 1 | Minta agent: "siapa saja yang memakai `shared.ts`?" | `deps` menyebut ≥ 20 file, tanpa `.png` |
| 2 | Edit fungsi lalu minta "cari referensi fungsi X" | Nomor baris referensi mutakhir |
| 3 | `search "truncate output"` | `shared.ts` di 3 besar |
| 4 | Minta agent rename sebuah fungsi lintas file | `refactor rename` dryRun → diff → apply atomik |
| 5 | Agent mengedit `.tsx` dan sengaja meninggalkan kurung | Edit di-rollback dengan pesan baris |
| 6 | Akhir tugas multi-file | Satu `verify quick` dengan tabel status |
| 7 | "Petakan arsitektur server" | Graf mermaid + daftar siklus |
| 8 | "Buat game 2D canvas sederhana" | Scaffold → jalan → `game_probe` fps & 0 error |
| 9 | "Buat demo 3D di visual" | `render_visual libs:["three"]` (atau `moriko-gl`) tampil |
| 10 | Shader dengan typo | `shader_check` menunjuk baris yang tepat |
| 11 | Aset `.glb` | `asset_inspect` melaporkan mesh/tris/texture & peringatan budget |
| 12 | Web Access OFF + dev server localhost | `game_probe` tetap jalan; `browser_*` tetap terblokir |

---

## 10. Risiko & Mitigasi

| Risiko | Mitigasi |
| --- | --- |
| LanguageService memakan RAM besar (repo besar) | Cache per tsconfig, LRU maks 2 service, `skipLibCheck`, dispose saat ganti workspace |
| Post-edit hook memperlambat edit | Timeout 1.5 s, hanya file yang diedit, bisa dimatikan |
| SwiftShader lambat → fps rendah palsu | Laporkan renderer (`SwiftShader`) di output dan beri catatan "software GPU — fps bukan ukuran performa nyata" |
| Bundle vendor besar di client | Fetch sekali per sesi, cache in-memory, tidak dipersist ke chat |
| Refactor otomatis merusak import `.js` server | `move_file` pasca-proses: pertahankan ekstensi sesuai gaya file asal; dryRun default |
| Linter proyek user tidak ada | Pesan jelas, tidak memasang apa pun tanpa izin |
| Drift registry selama transisi F0 | Checklist §8 + typecheck; migrasi tool lama ditunda sebagai follow-up |

---

## 11. Definition of Done (keseluruhan)

- Semua AC fase F0–F6 terpenuhi; `agent__typecheck` hijau.
- Tidak ada skrip test/E2E buatan agent yang ditambahkan.
- `docs/ARCHITECTURE.md` diperbarui (F7).
- Ringkasan akhir ke user: daftar tool baru/upgrade, keputusan dependensi (F5.1), item follow-up, dan daftar trial §9.

## 12. Follow-up (di luar lingkup)
- Migrasi seluruh tool lama ke `defineTool` dan menghapus switch dispatcher.
- Fold `.lua`, WGSL headless tanpa WebGPU.
- Embedding search sungguhan (butuh model lokal — keputusan user).
- Integrasi engine non-web (Godot CLI `--check-only`, Unity batchmode) untuk `game_probe` versi native.

## 13. Status Eksekusi (sesi 2026-10-10)
- F0–F6 diimplementasikan; typecheck hijau saat penutupan.
- Keputusan F5.1 (user): devDependency `three` + `pixi.js` + `matter-js` DIPASANG dan dibundel via `scripts/build-visual-vendor.mjs` (bundle di `~/.moriko-studio/visual-vendor/`, dev-only, tidak masuk bundle produksi). `moriko-gl.js` juga tersedia.
- Verifikasi akhir = trial manual user (§9). Tidak ada skrip test/E2E buatan yang ditambahkan.
