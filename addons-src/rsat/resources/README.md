# RSA/T — Realtime Shared Achievement Tracker

Gamified multi-agent achievement board for Moriko Studio (Addon v2 reference addon).

**Dogfooding**: RSA/T dibangun di atas Addon v2 platform dan membuktikan semua
kapabilitasnya — ctx tool per-sesi, guard `tool.call`, event `fs.change`,
`sessions.inject`, prompt fragment per-sesi, RPC klien, SSE bus, settings.

## Struktur

```
addon.json            manifest v2 (permissions, views, settings, statusItems)
server/main.ts        activate() — kabel semua registrasi
server/model.ts       RS-PRD v1: tipe, validasi, glob→RegExp, skor
server/store.ts       .moriko/rsat: atomic write, rev + antrean tulis, events.jsonl, ledger
server/engine.ts      state machine PRD/achievement (aturan user-only ditegakkan di sini)
server/tools.ts       11 tool agent (rsat_status … rsat_comment)
server/guard.ts       penjaga scope (advisory/strict) + anti-runaway
server/ledger.ts      fs.change → ledger file + ringkasan agent
server/sync.ts        presence, inject antar-sesi, prompt fragment, status item, toast
server/rpc.ts         aksi UI (Start/Pause user-only, review accept/reject, delete user-only)
server/i18n.ts        en + id
client/board.tsx      papan pixel (LangGate → PRD → grid → drawer)
client/activity.tsx   aktivitas live
client/shared.tsx     RPC + i18n + refresh
```

## Data

Semua data proyek di `<workspace>/.moriko/rsat/` (file di komputer user — tidak
ada browser storage). Folder itu ber-`.gitignore` lokal (`*`) sesuai keputusan
user: git mengabaikannya seluruhnya.

## PRD skala arsitektur

Selain field dasar (title/summary/goals/constraints/globalScope), RS-PRD v1
mendukung **struktur arsitektur** supaya satu PRD bisa memandu pekerjaan kecil
sampai besar:

- **`architecture`** — deskripsi lapisan, batas, dan alur data (teks bebas).
- **`modules[]`** — `{id,name,desc,scope}`: pecah proyek jadi bagian mandiri.
  Tiap achievement bisa `moduleId` untuk melekat ke satu modul → agent bekerja
  paralel tanpa tabrakan (modul beda = scope beda).
- **`milestones[]`** — `{id,title,goal}`: checkpoint delivery **terderivasi** —
  sebuah milestone dianggap selesai bila SEMUA achievement ber-`milestoneId` itu
  sudah `done`. `rsat_context` menampilkan status tiap milestone supaya
  orchestrator bisa melakukan sequencing (achievement bergantung pada achievement
  lain lewat `dependsOn` seperti biasa).
- **`nonFunctional[]`** — `{id,text,metric}`: syarat lintas-bagian yang terukur.
- **`risks[]`** — `{id,text,mitigation,severity}`: risiko + mitigasi, dibaca
  orchestrator saat menyusun urutan kerja.
- **`technicalDecisions[]`** — `{text,reason}`: keputusan teknis + alasannya.

Semua field ini tersedia di `rsat_prd` (create/update), ditampilkan di
`rsat_context`, di-injeksi ke prompt fragment agent yang aktif, dan dapat
diedit dari Base camp (form PRD) serta di-export/import antar proyek.

## Aturan penting

- **Start/Pause PRD** dan **delete achievement**: hanya user (UI). Agent hanya
  bisa mengusulkan (`review`) dan `drop` (recoverable).
- **done oleh agent** hanya bila SEMUA kotak acceptance tercentang (keputusan
  user); selain itu masuk `review` untuk keputusan user.
- **Guard** default `advisory` (edit di luar scope lolos dengan catatan di
  hasil tool); mode `strict` menolak. Shell (`run`/`git`/`exec`) tidak bisa
  dipagari — UI menyatakannya dengan jujur; ledger tetap mencatat.
- **LangGate**: papan tertutup sampai user memilih bahasa (en/id) — consent
  eksplisit, tidak pernah ditebak.

## Font pixel (opsional)

UI memakai `--f-rsat` (fallback `--f-mono`). Untuk font pixel sungguhan,
letakkan file berlisensi bebas (mis. Silkscreen, OFL) sebagai
`addons-src/rsat/resources/fonts/pixel.woff2` — di-load otomatis via
`/api/addons/rsat/client/resources/fonts/pixel.woff2`.
