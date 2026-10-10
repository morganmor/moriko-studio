# PLAN-AGENT-DRIVEN-IMAGE-GENERATION.md

**`/image` digerakkan agent**: user mengetik `/image <deskripsi>` (± attachment
gambar untuk edit) di composer chat. LLM yang menyusun prompt final dan memanggil
model image generator yang tersedia — agent-lah yang memberi prompt ke generator
bukan user menulis prompt teknisnya. Dua mode otomatis dari konteks:

1. **Text-to-image murni** — tidak ada attachment gambar → LLM menyusun prompt
   dan submit T2I.
2. **Edit/ingpoising** — user melampirkan gambar (attachment) → LLM membaca
   gambar, menyusun instruksi edit dari permintaan user, dan submit permintaan
   edit dengan gambar referensi (referenced-guided editing).

## Status: RENCANA (belum diimplementasikan)

## Audit — fondasi yang sudah ada (state hari ini)

| Fakta | Detail | Relevansi |
| --- | --- | --- |
| Kontrak image async | `POST /api/images/generations` → `{taskId}`; `GET /api/images/tasks/:id` → `{status, images[], error?}`; hasil diunduh ke `imagesDir`, disajikan via `/api/images/local/...` (`server/index.ts:1186+`). | Jalur server→provider sudah ada; tool agent hanya perlu memanggil kontrak ini secara internal, TIDAK menulis ulang adapter. |
| Adapter & kredensial | `resolveImageAdapter` / `resolveImageTarget(providerId, apiKey?)` (`adapters/images/registry.js`), kredensial via `resolveCredentials(providerStore, providerId)`. | Tool memilih model generator yang dikonfigurasi, tidak perlu API key user. |
| Klasifikasi model | `classifyImageModel(model)` → `{modes: ('text-to-image'\|'edit')[], maxReferences}` (`adapters/images/modelCaps.ts`) — dipublikasikan ke UI via `imageCapabilities` di `ProviderPublic`. | Pemilihan mode (T2I vs edit) dan validasi "model ini bisa edit?" sudah tersedia server-side. |
| Injeksi attachment | `attachmentsInjection(paths, modelId)` (`agents/systemPrompt.ts:441`) — setiap file diberi nomor upload + tanggal, dan di-patch via `attachmentRefWireUrl`/`attachmentStore`. | Mode edit: LLM melihat gambar yang dilampirkan user (native image input), bisa memanggil tool dengan path attachment. |
| Attachment data | `attachmentStore.ts` — `attachmentRefWireUrl(hash, mime)` menghasilkan URL data: untuk wire. Wire user content (`src/lib/compaction.ts wireUserContent`) mengirim gambar inline `image_url` ke model. | LLM dengan `imageIn` melihat gambar user langsung di konteks — tidak perlu `agent__vision` sama sekali. |
| Polling & persist | `imageTasks` map + `persistImageTasks()` + jurnal JSONL + TTL 15 menit; hasil lokal via `saveImagesLocal`. | Tool harus melakukan poll hingga terminal di dalam satu panggilan (LLM berjalan sinkron per tool-call) — LLM tidak bisa "menunggu" async. |
| Pola tool agent | `AgentToolDef {wireName, description, inputSchema}` + handler `(args, ctx) => HarnessToolResult` (shared.ts). Katalog `listAgentToolDefs()` (catalogue.ts) + `callAgentTool` (dispatcher.ts). | Cukup tambahkan satu tool baru `agent__image` + def di catalogue. |
| Tool multimodal | `HarnessToolResult.images: ToolImage[]` — inline image yang dilihat model secara native setelah tool call (pola `read_file`/vision). | Setelah edit selesai, LLM melihat hasilnya sendiri untuk iterasi ("kurangi saturasi") tanpa user mengunggah ulang. |
| `/image` saat ini | Slash command Composer (`runSlashCommand` case '/image') hanya membuka Image Studio + prefill prompt via `imageStudioPromptWanted` (implementasi sesi lalu). | Perlu didefinisikan ulang: mode studio tetap ada, tapi jalur chat-driven harus ditambahkan. |
| Vision policy | `agent__vision` punya STRICT VISION POLICY (imageIn harus read_file dulu). | Tool baru harus menghormati kebijakan yang sama bila melihat gambar; sebaiknya tidak bergantung pada `agent__vision`. |
| E2E debug | `POST /api/agent/call {tool, args, sessionId}` menjalankan tool tunggal di luar percakapan. | Path pengujian tanpa harus melewati LLM loop penuh. |

## Desain target

### Alur user

```
User: /image kucing astronot neon di atas bukit, gaya watercolor
  ↓ (tanpa attachment → T2I)
Agent: memanggil agent__image { request: "kucing astronot neon …" }
  → menyusun prompt final (enhancement) → submit → poll → hasil
Agent: "Selesai — <deskripsi>. Hasilnya disimpan di /api/images/local/xxx.png"

User: [melampirkan kucing.png] /image jadikan burung hantu
  ↓ (ada attachment gambar → mode EDIT)
Agent: melihat kucing.png (native image input dari wire)
  → agent__image { request: "...", referencePaths: ["uploads/kucing.png"] }
  → edit prompt + images[] → poll → hasil
```

### Keputusan desain

1. **Tool tunggal, dua mode otomatis** — `agent__image` dengan input sederhana:
   - `request: string` (wajib) — permintaan user, apa adanya.
   - `referencePaths?: string[]` (opsional) — path workspace/attachment yang
     jadi sumber edit; jika ada → mode edit.
   - `mode?: 'text-to-image' | 'edit' | 'auto'` (default `auto`: edit jika ada
     `referencePaths`, selain itu T2I).
   - `aspectRatio?: string`, `sizeMode`? — opsional; default mengikuti
     Image Studio saved settings.
   Tool memilih model generator: pakai konfigurasi image Studio tersimpan
   (`imageProviderId`/`imageModel` di store user) atau parameter opsional
   `model?: string`.
2. **LLM sebagai prompt-engineer** — system prompt injection baru (mis.
   `imageGenInjection()`) memberitahu LLM: bila user meminta gambar, susun
   prompt final yang kaya (subject, gaya, komposisi, pencahayaan) lalu panggil
   `agent__image`. Untuk mode edit: instruksikan membaca gambar referensi
   dengan `read_file` dulu (kebijakan vision), deskripsikan perubahan yang
     diminta user, dan panggil tool dengan `referencePaths`.
3. **Loop poll di dalam tool** — tool submit lalu mem-poll `poll(taskId)`
   hingga terminal (cap ~15 menit, hormati `IMAGE_TASK_TTL_MS`), sehingga LLM
   menerima hasil dalam satu tool-call. Untuk sinkronisasi UI: hasil disimpan
   ke Image Session/Gallery seperti Image Studio (ops terintegritas dengan
   yang sudah ada: sesi `addSessionItem`/`setImageStudioOutput`).
4. **Hasil inline untuk iterasi** — `HarnessToolResult.images` membawa hasil
   ke konteks model, jadi percakapan lanjutan ("ganti jadi malam hari") bisa
     dilakukan tanpa re-upload: agent memanggil `agent__image` lagi dengan
     `referencePaths` menunjuk hasil lokal.
5. **Kompatibilitas slash UI** — `/image` di composer di-retain tapi sekunder:
   - `/image <teks>` tanpa attachment → kirim sebagai pesan chat biasa
     ber-prefix instruksi (bukan buka Studio) → LLM menjalankan alur di atas.
   - `/image <teks>` + attachment gambar → sama, attachment ikut sebagai
     turn attachment biasa.
   - Plus menu "Generate image" (PlusMenuRow onStudio) tetap membuka Image
     Studio manual — dua pintu, satu mesin.
6. **Tone & permisi** — tool diizinkan secara default di agent mode (seperti
   tool lain); bila model tidak dikonfigurasi → hasil `isError` dengan teks
   instruksi "Ask the user to configure Image Studio first" (mirip
   `visionUnconfigured()`).

### Pilihan model generator (yang tersedia)

- Sumber: provider dengan `imageCapabilities` (via `imageCapabilitiesOrNull`)
  — daftar model diperoleh dari `imageCapabilities.models` map (model yang
  klasifikasinya cocok mode). Provider default: saved Studio
  (`imageProviderId`/`imageModel`) → fallback: provider image pertama yang
  terkonfigurasi + model T2I-nya.
- Validasi edit: `classifyImageModel(model).modes.includes('edit')` — jika
  model tidak mendukung edit dan user melampirkan referensi, tool mengembalikan
  error yang readable, bukan gagal diam-diam.

### Rangkaian panggilan tool (server-side)

```
agent__image(args, ctx)
  1. resolve target: providerId/model = saved image settings | explicit args
  2. classify model → butuh mode apa; resolveImageTarget(providerId)
  3. reference images: referencePaths → resolveImageSource-like (path
     workspace / data: URL) → images[] (validasi maxReferences)
  4. adapter.submit({model, prompt, images?...}) → taskId
  5. loop poll (interval ~2s, cap 15m): PENDING/RUNNING → terminal
  6. terminal SUCCEED → saveImagesLocal (sudah di route poll) → kumpulkan
     URL lokal → HarnessToolResult { ok, text, images: ToolImage[] }
  7. FAILED → { ok:false, isError, text: failure readable }
```

Catatan: langkah 5-6 saat ini hidup di route `GET /api/images/tasks/:id`
(marco `server/index.ts`); untuk tool, ekstrak bagian poll+persist ke fungsi
shared (`server/images/tasks.ts` baru atau export dari index.ts) supaya route
dan tool memakai satu implementasi (no duplication).

## Architecture (file & lokasi)

| Piece | Where | Notes |
| --- | --- | --- |
| Tool handler | `server/agents/tools/image.ts` (baru) | `imageTool(args, ctx)` + schema; menandai `agent__image` sebagai tool di catalogue (`catalogue.ts` push def) + dispatcher switch case. |
| Shared poll/persist | refactor dari `server/index.ts` → `server/images/taskRunner.ts` (baru) | `submitAndPollImage(...)` dipakai route browser (bukan — route tetap) dan tool. Route tetap memakai fungsi shared untuk poll. |
| Prompt injection | `server/agents/systemPrompt.ts` → `imageGenInjection()` | Ditambahkan saat `settings.agentMode` (di sebelah agentHarnessInjection) — hanya jika image provider terkonfigurasi. |
| UI: tool result | `Thread.tsx` tool-call card render | Kartu hasil `agent__image` menampilkan gambar hasil (src `/api/images/local/...`) — pola `ToolCallCard` + `visual`/`images` sudah ada; hanya perlu UI mini (thumbnail + link) bila belum. |
| Composer `/image` | `src/components/Composer.tsx` runSlashCommand | Ganti aksi: dari "buka Studio + prefill" → "kirim pesan chat" (biarkan attachment ikut). Tanpa attachment pun LLM bisa T2I. |
| Store | `src/store/useStore.ts` | Tidak ada slice baru; ImageStudio state tetap. `imageStudioPromptWanted` bisa di-deprecate (atau dipertahankan untuk prefill studio manual). |
| Catalog pesan | `src/lib/messageCatalog.ts` | Tambah id untuk notice (mis. `image.agentQueued`, `image.agentFailed`) bila perlu notice client-side. |
| Vision policy | Tidak berubah | Tool baru tidak memanggil `agent__vision`; LLM memakai native image input (read_file attachment) sesuai kebijakan. |

## Fase implementasi

### Fase 1 — Fondasi server (tool + runner)
1. Ekstrak poll/persist image task ke modul shared
   (`server/images/taskRunner.ts`): `submitImageRequest(req)` +
   `pollImageTask(taskId)` → dipakai route & tool. (Route HTTP tetap,
   kontrak client tidak berubah.)
2. `server/agents/tools/image.ts`: handler `agent__image` penuh
   (resolve target → validate mode → submit → poll → result + inline images).
3. `catalogue.ts` + `dispatcher.ts`: def & case. `permissions.ts` — aman
   (network ke provider image, mirip webFetch) → default allow di agent mode.

### Fase 2 — Integrasi LLM (prompt + hasil)
4. `imageGenInjection()`: instruksi "bila user meminta gambar → susun prompt &
   panggil agent__image; bila ada attachment gambar → read_file dulu, mode
   edit dengan referencePaths; hasil iterate dengan referensi hasil
   sebelumnya". Hanya aktif bila ada provider image terkonfigurasi.
5. Thread.tsx: render kartu `agent__image` (nama tool human-readable
   "Generate image", thumbnail hasil, status poll).

### Fase 3 — Composer `/image` & UX
6. Composer `runSlashCommand('/image')`: alih-alih membuka Studio, kirim pesan
   chat `"[image request] <args>"`... atau lebih baik: kirim draft asli apa
   adanya (`/image ...` → onSend(text)) dan biarkan server-side turn
   interception mem-patch? TIDAK — lebih sederhana: onSend(draft) biasa.
   Server (send flow) tidak perlu tahu; LLM melihat teks `/image ...` +
   injection mengambil alih. Sederhana dan robust.
7. Plus menu "Generate image" tetap → Image Studio (pintu manual).

### Fase 4 — Hardening
8. Batas: 1 panggilan `agent__image` aktif per sesi (guard sederhana), prompt
   ≤ 1000 char (sudah di adapter civitai; klamp di tool), max 4 iterasi edit
   berantai.
9. Catalog messages + notice bila `/image` dipakai tanpa provider image
   terkonfigurasi (client notice, bukan tool error).

## Open decisions (perlu jawaban user)

1. **Simpan hasil ke Gallery/Sessions otomatis?** Saran: YA — hasil agent
   muncul di Image History seperti Image Studio manual (konsisten, tidak ada
   "gambar hilang").
2. **Model image default**: pakai `imageProviderId`/`imageModel` (saved Studio)
   atau biarkan agent memilih dari daftar model tersedia per request?
   Saran: default saved model; agent boleh menimpa dengan args `model` bila
   user menyebut gaya/model tertentu.
3. **Streaming hasil**: saat poll berjalan, tampilkan kartu tool-call live
   ("Menghasilkan gambar…" + spinner) seperti tool lain — cukup via status
   tool-call card yang sudah ada. OK?

## Testing (ringkas)

- Unit: `submitAndPoll` happy path + FAILED + TTL expiry (node:test via
  `agent__run`? — repo pakai `node --import tsx --test`); mock adapter.
- E2E debug: `POST /api/agent/call { tool: 'image', args: {request:'...'} }`
  dengan provider terkonfigurasi → verify taskId flow + result images.
- Manual (user): `/image unta astronot watercolor` → lihat LLM menyusun
  prompt → hasil muncul di thread; attach gambar + `/image jadikan sore` →
  mode edit; lanjutkan "lebih gelap" → iterasi dari hasil lokal.
