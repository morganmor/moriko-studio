# Spatial Harness Plan — Moriko Studio

## 0. Dokumen Sumber & Ruang Lingkup

Rencana ini menggabungkan empat masukan:

1. **Dokumen Gemini** (`.attachments/…/001-…Gemini….txt`) — visi harness 4 pilar: Frontend Visual Feedback, Backend Ephemeral Runtime, Orkestrasi, Human-in-the-Loop.
2. **Audit harness Moriko (hasil turn audit)** — ~45% ide dokumen terpenuhi: kuat di orkestrasi file/kode (`deps.ts`, `fold.ts`, checkpoint/vault, permissions/sandbox/read-policy, `typecheck`/`test_run`, `journal.ts`), **kosong** di seluruh lapisan frontend-visual (grep `playwright|screenshot|a11y|openapi|sqlite` → 0 match) dan backend-runtime.
3. **Dua masalah konkret yang harus diselesaikan:**
   - **P1** — Saat user meminta model memindah/mengedit panel, koordinat sering kacau dan saling bertabrakan.
   - **P2** — Hasil edit sering merusak fungsi/visual lain, dan agent tidak mengetahuinya sampai user melihat sendiri tabrakannya.
4. **Desain spatial mechanism (turn diskusi)** — prinsip: *"edit di ruang intent, verifikasi di ruang metrik"* melalui **Layout IR** sebagai bahasa perantara piksel ⇄ model.

**Ruang lingkup:** Frontend penuh; backend *as-is* (modul opsional). Non-sasaran: penilaian estetika, pixel-perfect mockup fidelity, multi-browser, interaction-trace lintas stack penuh.

---

## 1. Akar Masalah

**P1** bukan bug model, melainkan bug representasi: model mengedit layout dalam gelap — ia tidak tahu posisi panel saat ini, jadi menebak angka piksel dan menulis `position:absolute` + magic numbers. Dokumen Gemini hanya menyediakan *diff post-edit* (reaktif); tidak ada *injeksi konteks pre-edit* maupun *gate overlap* — dua komponen yang justru paling krusial.

**P2** adalah bug feedback loop: typecheck/unit test **tidak gagal** untuk kolisi visual, jadi satu-satunya detektor adalah mata user. Penutupnya = pipeline yang di-*enforce* (bukan fitur lepas): `typecheck → test → build → spatial-check` wajib hijau sebelum agent boleh lapor selesai, plus diff semantik dengan baseline.

---

## 2. Prinsip Desain

1. **Edit di ruang intent, verifikasi di ruang metrik.** Model menyatakan kemauan layout; harness menghitung geometri secara deterministik dan mengukur hasilnya.
2. **Ground truth DOM > perkiraan vision.** Ekstraksi runtime eksak; vision hanya input sekunder (mockup).
3. **Satu IR, dua arah.** Representasi perantara yang sama untuk konteks pre-edit dan laporan verifikasi post-edit.
4. **Gate, bukan saran.** Pipeline dijalankan otomatis; hasil di-push ke agent sebelum "selesai".
5. **No-op untuk workspace non-UI.** Gate diam saat tidak ada file/route frontend.
6. **Bertumpu pada pola Moriko yang ada:** apply-gate `reload.ts`, structured tools (`typecheck`/`test_run`), read-receipt policy.

---

## 3. Spesifikasi Layout IR

```jsonc
{
  "canvas": { "w": 1440, "h": 900, "grid": { "cols": 12, "gap": 16 } },
  "regions": [{
    "id": "FilterPanel", "role": "complementary",
    "rect": { "x": 260, "y": 0, "w": 180, "h": 640 },
    "gridPos": "2/4",
    "constraint": "grid-area",          // flex | grid | absolute (+magicNumbers: true)
    "zIndex": 0,
    "neighbors": { "left": "Sidebar", "right": "Canvas" },
    "collidesWith": []
  }],
  "collisions": [{
    "a": "PanelB", "b": "PanelC",
    "overlap": { "x": 20, "y": 10, "w": 180, "h": 40 },
    "severity": "hard"                  // hard | soft
  }]
}
```

Aturan token: format ringkas, grid-relatif ("kolom 2 dari 4"), bukan piksel absolut. Elemen ber-role `dialog|tooltip|popover` dikecualikan dari deteksi overlap (overlay memang menimpa).

---

## 4. Arsitektur & Tool Surface

**Lapis A — Ekstraksi:** Tier 1 statis (parse JSX/CSS, tanpa browser) → Tier 2 runtime (Playwright: bounding box + a11y tree eksak) → Tier 3 vision (segmentasi mockup → IR target, via `vision.ts`).

**Lapis B — Query tools** (dirakit jadi satu tool bermode, hemat tool-surface):

- `agent__spatial { mode: "map", files?|route? }` — peta ruang saat ini; disuntik **sebelum** edit.
- `agent__spatial { mode: "check" }` — laporan tabrakan terstruktur (pasangan overlap + rect irisan + severity), viewport overflow, tap-target < 44px.
- `agent__spatial { mode: "diff", baseline }` — diff semantik: "Sidebar bergeser +140px (diminta ✔) / OVERLAP BARU: PanelB ∩ PanelC (liar ✘)".

**Lapis C — Intent layer:**

- `agent__layout_edit { intent }` dengan intent: `move-right-of | move-below | swap | resize-relative | align`. **Tool** menghitung koordinat (ubah flex order / grid area), model tidak pernah menulis angka piksel.
- Linter rule pada hasil edit agent: flag `position:absolute` + magic pixel number.

**Lapis D — Gate pasca-edit:** setiap edit yang menyentuh `*.tsx|*.css` → rebuild → ekstrak ulang → `check` → jika ada overlap/overflow baru, laporan terstruktur dikirim balik ke agent **sebelum** ia boleh lapor selesai. Perluasan apply-gate `harness_reload`.

---

## 5. Fase Implementasi

| Fase | Isi | File | Menyelesaikan | Estimasi |
|---|---|---|---|---|
| **F0** Fondasi | Tipe IR, parser statis JSX/CSS, detektor overlap, flag absolute+magic | `server/agents/spatial.ts` (baru), `tests/spatial.test.ts` (baru) | fondasi P1 | S |
| **F1** Tool + Prompt | `agent__spatial` (3 mode), routing, bagian baru di system prompt (wajib map pre-edit; flex/grid) | `server/agents/tools/spatial.ts` (baru), `routes.ts`, `systemPrompt.ts` (diubah) | P1 (pre-edit context) | S–M |
| **F2** Intent layer | `agent__layout_edit`, intent→geometri deterministik, linter rule | `server/agents/tools/layout-edit.ts` (baru), `edit-diagnostics.ts`/`pipeline.ts` (diubah) | **P1 penuh** | M |
| **F3** Gate | Hook pasca-edit UI, pipeline wajib `typecheck→test→spatial-check`, push laporan | `pipeline.ts`, `reload.ts` (diubah) | **P2 (loop kode)** | M |
| **F4** Runtime truth | Konektor Playwright headless (entri exec-allowlist + izin), DOM bbox + a11y → IR eksak, screenshot sekunder, baseline store | `server/agents/spatial-runtime.ts` (baru) | **P2 (loop visual)** | M–L |
| **F5** Backend as-is (opsional) | Ephemeral SQLite file-per-branch + auto-rollback, contract enforcer (jika OpenAPI ada), `harness.seed({...})` | `server/agents/backend/*.ts` (baru) | P2 sisi backend | M |
| **F6** Ekstensi jangka panjang | Checkpoint menyertakan UI-state (IR snapshot per route), vision segmentasi mockup→IR target | `checkpoint.ts`, `vision.ts` (diubah) | mockup workflow | L |

Urutan kritikal: **F0 → F1 → F2 menutup P1**; **F3 → F4 menutup P2**. F5/F6 menyusul.

---

## 6. Strategi Pengujian

- **Unit:** geometri murni (irisan rect, containment, overflow) — `tests/spatial.test.ts`, dijalankan via `agent__test_run`.
- **Fixture:** JSX/CSS sampel berisi kasus tabrakan yang diketahui (absolute overlap, grid benar) → extractor harus mengklasifikasikan benar.
- **Gate e2e:** skrip ala `scripts/test-*-e2e.mjs` — edit yang memicu overlap baru harus di-block/flag oleh gate.
- **Verifikasi harness:** `agent__typecheck` (`pnpm typecheck`) setelah setiap fase.

---

## 7. Risiko & Mitigasi

| Risiko | Mitigasi |
|---|---|
| Ekstraktor statis meleset (media query, styled-runtime) | Tier 1 = heuristik; kebenaran penuh lewat F4 runtime |
| Playwright di Windows + sandbox/allowlist | F4 = dependensi opsional; install lewat gerbang izin `permissions.ts` |
| Biaya token injeksi IR | Format ringkas, on-demand, cache per-route |
| Overlap yang disengaja (modal, dropdown) | Role-based exemption (`dialog|tooltip|popover`), severity soft/hard |
| Workspace non-UI | Gate no-op bila tak ada file/route frontend |

---

## 8. Traceability ke Dokumen Gemini

| Ide Gemini | Status | Fase |
|---|---|---|
| Visual regression & DOM diffing (a11y+bbox) | diadopsi | F0–F4 |
| Console/network interceptor | diadopsi (murah, kandidat menempel di F3) | F3 |
| Component sandbox auto-mock | defer (di luar P1/P2 inti) | — |
| Ephemeral DB | diadopsi kondisional (backend as-is) | F5 |
| API contract enforcer | diadopsi kondisional | F5 |
| Deterministic seeder | diadopsi kondisional | F5 |
| Architecture map | **sudah ada** (`deps.ts`, `lsp_symbols`, tree index) | — |
| Self-healing loop | **ada parsial**; diperkuat gate F3 | F3 |
| Time-travel debugging | parsial via `journal.ts`; interaction-trace defer | F6 |
| Checkpoint & rollback | **sudah ada** (file); UI-state di F6 | F6 |
| Intent vs execution inspector | **sudah ada** (`ask_user`, goals); + `layout_edit` intent | F2 |
| Agent jail | **sudah ada & solid** | — |

---

## 9. Kriteria Penerimaan

**P1 —** Skenario: user minta memindah FilterPanel ke kanan Canvas. Agent memanggil `spatial map` → `layout_edit {move-right-of}` → gate: overlap baru = 0, panel benar-benar pindah → laporan diff semantik hijau. Tanpa satu pun angka piksel yang ditulis model. Metrik: frekuensi edit UI yang menghasilkan overlap baru turun > 90% pada fixture.

**P2 —** Skenario: edit di PaymentModal yang merusak Navbar. Pipeline: typecheck/test hijau (regresi logika tertangkap), `spatial-check` menangkap overlap/ketidaksesuaian layout, console-interceptor menangkap error runtime Navbar → semuanya di-push ke agent sebelum laporan "selesai". Metrik: tidak ada regresi visual yang pertama kali ditemukan oleh user pada suite uji.

---

## 10. Keputusan yang Dibutuhkan

1. Mulai F0 sekarang atau tunggu review plan ini? *(default: mulai F0)*
2. Tool: satu `agent__spatial` bermode vs tiga tool terpisah? *(default: satu bermode)*
3. F4 Playwright: optional-extra sekarang atau langsung? *(default: optional-extra)*
