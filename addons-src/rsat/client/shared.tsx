/**
 * RSA/T client state — rebuild dari nol (menggantikan shared.tsx lama yang dihapus).
 * State board live via host (fetch sekali + invalidasi SSE), RPC, dan i18n mini.
 */
import { useCallback } from 'react';
import { invoke, useAddonState } from '@moriko/host';

export interface Presence {
  sessionId: string;
  model?: string;
}

export interface RsatState {
  displayName?: string;
  presence?: Presence[];
  language?: string;
}

const EMPTY: RsatState = { displayName: 'Rizky', presence: [], language: '' };

/** State board RSA/T yang hidup (SSE invalidation dari server addon). */
export function useBoard(): RsatState {
  return useAddonState<RsatState>('rsat', EMPTY, useCallback(() => null, []));
}

/** RPC addon (server membungkus {result}|{error}). */
export async function rpc(name: string, body: Record<string, unknown> = {}): Promise<unknown> {
  return invoke('rsat', name, body);
}

const L: Record<string, Record<string, string>> = {
  en: { actingAs: 'Acting as', start: 'Start', pause: 'Pause', resume: 'Resume', exportL: 'Export',
    activeNow: 'Active quests', nextUp: 'Next up', scopeGlobal: 'Global scope', constraints: 'Constraints',
    points: 'Emeralds', s_available: 'Available', s_in_progress: 'In progress', s_review: 'In review',
    none: 'Nobody', stale: 'stale', s_locked: 'Locked', s_claimed: 'Claimed', s_done: 'Done',
    s_blocked: 'Blocked', s_dropped: 'Dropped', all: 'All', search: 'Search quests…', tree: 'Skill tree',
    interlinked: 'Interlinked', archScale: 'Architecture & Layers', contracts: 'Contracts', blastRadius: 'Blast radius',
    agentDsl: 'Agent @RSLK v1', nodeCanvas: 'Node Graph',
    holder: 'Held by', deps: 'Depends on', newQuest: 'New quest',
    emptyBoard: 'No quests match the filters.',
    activity: 'Live feed', injD: 'What other agents received', files: 'Inventory', awaiting: 'awaiting summary',
    op_add: 'Added', op_mod: 'Modified', op_del: 'Deleted', op_ref: 'Refactored', op_ren: 'Renamed',
    settings: 'Options', language: 'Language', guard: 'Agent guard', toastsL: 'Achievement pop-ups',
    importL: 'Import', danger: 'Danger zone', delPrd: 'Delete PRD', userOnly: 'Only the user can do this.',
    detail: 'Detail', scope: 'Scope', comments: 'Comments', filesT: 'Files', accept: 'Acceptance criteria',
    newPrd: 'New PRD', editPrd: 'Edit PRD',
    tech: 'Technical notes', claim: 'Claim', release: 'Release', submit: 'Submit for review', approve: 'Mark done',
    reopen: 'Request changes', drop: 'Drop', widen: 'Widen scope', narrow: 'Narrow scope',
    comment: 'Add a comment…', send: 'Send', takeover: 'Take over',
    ilScan: 'Scan workspace', ilScanning: 'Scanning…', ilRescan: 'Rescan', ilInspector: 'Inspector', ilHide: 'Hide',
    ilLegend: 'LEGENDS', ilLegendTitle: 'LEGENDS & CONTROLS',
    ilNoData: 'No architecture scanned yet',
    ilNoDataDesc: 'Interlinked scans the active workspace — the project you are building (src/, server/, …), not the RSA/T addon\'s own code.',
    ilNoWs: 'No workspace bound — pick one in the board header.',
    ilClickDetail: '(click for details)', ilFanIn: 'fan-in', ilFanOut: 'fan-out',
    ilDeps: 'dependents', ilUnassigned: 'Unassigned',
    ilWireInsp: 'INTERLINK WIRE INSPECTOR', ilNodeInsp: 'NODE ARCHITECTURAL INSPECTOR',
    ilSource: 'Source:', ilTarget: 'Target:', ilBlast: 'BLAST RADIUS', ilInstab: 'INSTABILITY',
    ilOpenRslk: 'Open Full @RSLK Agent View', ilShowFull: 'Show Full Graph',
    ilCopy: 'Copy @RSLK Payload', ilCopied: 'Copied @RSLK',
    ilHintInspect: 'Click a Node or Wire on the canvas to inspect symbol contracts, quest ownership, and blast radius.',
    ilCtl1: 'Scroll = zoom in/out · Drag canvas = pan',
    ilCtl2: 'Drag node = rearrange (snap 8px) · Click node/wire = details',
    ilWire: 'WIRE', ilNode: 'NODE', ilRuntime: 'Runtime Import', ilType: 'Type / Interface Contract',
    ilActive: 'Live Agent Touch (Flowing)', ilCross: 'Cross-Agent Dependency', ilBroken: 'Layer / Contract Violation',
    ilFilterPh: 'Filter file or symbol…', ilReset: 'Reset Layout', ilClearSpot: 'Clear Spotlight',
    ilRslkDesc: 'Token-dense deterministic format delivered to the Agent via the rsat_interlink tool so it sees every symbol wire, module layer rules, and cross-Agent blast radius without bloating the context window.',
    ilToggleInsp: 'Toggle inspector panel', ilViewMode: 'View mode', ilWireFilter: 'Wire filter',
    ilResetPos: 'Reset node positions', ilNodesL: 'nodes', ilWiresL: 'wires',
    fActive: 'Active Pulse', fCross: 'Cross-Agent', fAlerts: 'Alerts',
    prdw: 'Guided Workbench', prdwStep: 'Step', prdwOf: 'of',
    prdwWrite: 'Write', prdwPreview: 'Preview', prdwClose: 'Close', prdwCancel: 'Cancel',
    prdwPrev: 'Previous', prdwNext: 'Next', prdwSeePrev: 'See preview',
    prdwExample: 'Fill example', prdwSave: 'Save PRD', prdwSaveAnyway: 'Save anyway',
    prdwFix: 'Fix now', prdwIncomplete: 'sections incomplete:',
    prdwDone: 'Complete', prdwPartial: 'Partial', prdwEmpty: 'Empty',
    prdwComplete: 'Completeness', prdwAuto: 'Draft saved to board on save · completeness',
    prdwAddRow: 'Add row', prdwAddGoal: 'Add goal', prdwAddCon: 'Add constraint',
    prdwAddMod: 'Add module', prdwAddRisk: 'Add risk', prdwDelete: 'Delete row',
    prdwDelMod: 'Delete module', prdwDelRisk: 'Delete risk',
    prdwAgentText: 'Agent text', prdwCopy: 'Copy', prdwBack: 'Back to writing',
    prdwEdit: 'Edit', prdwEmptyL: 'Empty', prdwOther: 'Add another module to link',
    prdwAllows: 'Allows importing from', prdwMatrix: 'Layer matrix (auto)',
    prdwAll: '— (all modules)', prdwScope: 'Scope:', prdwStrictT: 'Strict', prdwAdvisory: 'Advisory',
    prdwStrictHint: 'Strict blocks the agent when violated. Advisory is a reminder only.',
    prdwTitlePh: 'Team notes app — collaboration without overlap',
    prdwSumPh: 'A web app for small teams to write and share notes.',
    prdwSumHint: 'At least one full sentence for this section to count as complete.',
    prdwTitleHint: 'One line, recognizable in the document list.',
    prdwGoalPh: 'Users can finish the main flow without help',
    prdwConPh: 'No new dependencies may be added',
    prdwArchPh: 'Single-page app with a central store; UI reads only from the store.',
    prdwArchHint: 'High level is enough. Per-module details go in the next step.',
    prdwModDescPh: 'Responsibility: keeps PRD & quest state',
    prdwRiskPh: 'Schedule too tight', prdwMitPh: 'Mitigation: cut secondary features if late',
    prdwPairPh1: 'Stage name', prdwPairPh2: 'Checkable goal',
    prdwNfrPh1: 'Requirement', prdwNfrPh2: 'Measurable target',
    prdwTechPh1: 'Decision', prdwTechPh2: 'Reason',
    prdwScopeInc: 'Global scope · include (one glob per line)', prdwScopeExc: 'Global scope · exclude',
    secSum: 'Identity & Summary', secGoals: 'Goals', secCons: 'Constraints', secArch: 'Architecture',
    secMods: 'Module Layer Matrix', secMiles: 'Milestones', secNfr: 'Non-functional', secRisks: 'Risk Register', secTech: 'Tech Decisions',
    whySum: 'Title & summary are the document identity — the agent uses them to name quests and grasp the project intent.',
    whyGoals: 'Checkable objectives. The agent derives quest acceptance criteria from this list.',
    whyCons: 'Ground rules. STRICT constraints are enforced by the guard to block violating agent actions; Advisory is only a reminder.',
    whyArch: 'High-level picture — context for the agent before touching code. Per-module details go in the next step.',
    whyMods: 'Module & layer map. The Interlinked panel uses it for node clusters, layer-violation detection, and blast radius.',
    whyMiles: 'Verifiable delivery checkpoints. Quests can depend on these milestones.',
    whyNfr: 'Measurable targets (performance, security, etc.) judged during review.',
    whyRisks: 'Risks + mitigations help the agent pick a safe work order.',
    whyTech: 'Technical decisions + reasons — keeps the agent from overriding agreed choices.',
    sevHigh: 'High', sevMedium: 'Medium', sevLow: 'Low',
    prdwSections: 'Sections', prdwTitleL: 'Project title', prdwSummaryL: 'Summary', prdwArchL: 'Architecture overview',
    prdwUnnamed: '(unnamed)', prdwDraftL: 'Draft', prdwModName: 'Module name', prdwModDesc: 'Module description',
    prdwLayer: 'Layer', prdwRiskL: 'Risk', prdwMit: 'Mitigation',
    prdwModNamePh: 'Module name, e.g. Core Store', prdwUntitledL: '(untitled)',
  },
  id: { actingAs: 'Bertindak sebagai', start: 'Mulai', pause: 'Jeda', resume: 'Lanjutkan', exportL: 'Ekspor',
    activeNow: 'Quest aktif', nextUp: 'Berikutnya', scopeGlobal: 'Scope global', constraints: 'Batasan',
    points: 'Emerald', s_available: 'Tersedia', s_in_progress: 'Dikerjakan', s_review: 'Direview',
    none: 'Belum ada', stale: 'basi', s_locked: 'Terkunci', s_claimed: 'Diambil', s_done: 'Selesai',
    s_blocked: 'Terblokir', s_dropped: 'Dibatalkan', all: 'Semua', search: 'Cari quest…', tree: 'Pohon skill',
    interlinked: 'Interlinked', archScale: 'Arsitektur & Layer', contracts: 'Kontrak Simbol', blastRadius: 'Radius Dampak',
    agentDsl: 'Format Agent @RSLK v1', nodeCanvas: 'Graf Node',
    holder: 'Dipegang', deps: 'Bergantung pada', newQuest: 'Quest baru',
    emptyBoard: 'Tidak ada quest yang cocok dengan filter.',
    activity: 'Aktivitas langsung', injD: 'Yang diterima agent lain', files: 'Inventaris', awaiting: 'menunggu ringkasan',
    op_add: 'Ditambah', op_mod: 'Diubah', op_del: 'Dihapus', op_ref: 'Direfactor', op_ren: 'Diganti nama',
    settings: 'Opsi', language: 'Bahasa', guard: 'Penjaga agent', toastsL: 'Pop-up achievement',
    importL: 'Impor', danger: 'Zona bahaya', delPrd: 'Hapus PRD', userOnly: 'Hanya user yang dapat melakukan ini.',
    detail: 'Detail', scope: 'Scope', comments: 'Komentar', filesT: 'File', accept: 'Kriteria penerimaan',
    newPrd: 'PRD baru', editPrd: 'Ubah PRD',
    tech: 'Catatan teknis', claim: 'Ambil', release: 'Lepas', submit: 'Ajukan review', approve: 'Tandai selesai',
    reopen: 'Minta perubahan', drop: 'Batalkan', widen: 'Perluas scope', narrow: 'Perkecil scope',
    comment: 'Tulis komentar…', send: 'Kirim', takeover: 'Ambil alih',
    ilScan: 'Pindai workspace', ilScanning: 'Memindai…', ilRescan: 'Pindai ulang', ilInspector: 'Inspektor', ilHide: 'Sembunyikan',
    ilLegend: 'LEGENDA', ilLegendTitle: 'LEGENDA & KONTROL',
    ilNoData: 'Belum ada arsitektur yang dipindai',
    ilNoDataDesc: 'Interlinked memindai workspace aktif — proyek yang sedang Anda bangun (src/, server/, …), bukan kode addon RSA/T sendiri.',
    ilNoWs: 'Tidak ada workspace terikat — pilih satu di header papan.',
    ilClickDetail: '(klik untuk detail)', ilFanIn: 'fan-in', ilFanOut: 'fan-out',
    ilDeps: 'dependen', ilUnassigned: 'Belum ditugaskan',
    ilWireInsp: 'INSPEKTOR BENANG INTERLINK', ilNodeInsp: 'INSPEKTOR NODE ARSITEKTURAL',
    ilSource: 'Sumber:', ilTarget: 'Target:', ilBlast: 'RADIUS DAMPAK', ilInstab: 'KETIDAKSTABILAN',
    ilOpenRslk: 'Buka Tampilan Agent @RSLK Penuh', ilShowFull: 'Tampilkan Graf Penuh',
    ilCopy: 'Salin Payload @RSLK', ilCopied: 'Tersalin @RSLK',
    ilHintInspect: 'Klik sebuah Node atau Benang di kanvas untuk menginspeksi kontrak simbol, kepemilikan quest, dan radius dampak.',
    ilCtl1: 'Scroll = zoom in/out · Seret kanvas = pan',
    ilCtl2: 'Seret node = susun ulang (snap 8px) · Klik node/benang = detail',
    ilWire: 'BENANG', ilNode: 'NODE', ilRuntime: 'Impor Runtime', ilType: 'Kontrak Tipe / Interface',
    ilActive: 'Sentuhan Agent Langsung (mengalir)', ilCross: 'Dependensi Lintas-Agent', ilBroken: 'Pelanggaran Layer / Kontrak',
    ilFilterPh: 'Filter file atau simbol…', ilReset: 'Reset Tata Letak', ilClearSpot: 'Bersihkan Sorotan',
    ilRslkDesc: 'Format deterministik padat-token yang dikirim ke Agent lewat tool rsat_interlink agar Agent melihat seluruh benang simbol, aturan layer modul, dan blast-radius lintas-Agent tanpa membengkakkan context window.',
    ilToggleInsp: 'Buka/tutup panel inspektor', ilViewMode: 'Mode tampilan', ilWireFilter: 'Filter benang',
    ilResetPos: 'Reset posisi node', ilNodesL: 'node', ilWiresL: 'benang',
    fActive: 'Pulsa Aktif', fCross: 'Lintas-Agent', fAlerts: 'Peringatan',
    prdw: 'Workbench Terpandu', prdwStep: 'Langkah', prdwOf: 'dari',
    prdwWrite: 'Tulis', prdwPreview: 'Pratinjau', prdwClose: 'Tutup', prdwCancel: 'Batal',
    prdwPrev: 'Sebelumnya', prdwNext: 'Berikutnya', prdwSeePrev: 'Lihat pratinjau',
    prdwExample: 'Isi contoh', prdwSave: 'Simpan PRD', prdwSaveAnyway: 'Simpan tetap',
    prdwFix: 'Perbaiki sekarang', prdwIncomplete: 'bagian belum lengkap:',
    prdwDone: 'Lengkap', prdwPartial: 'Sebagian', prdwEmpty: 'Kosong',
    prdwComplete: 'Kelengkapan', prdwAuto: 'Draft tersimpan di papan saat disimpan · kelengkapan',
    prdwAddRow: 'Tambah baris', prdwAddGoal: 'Tambah tujuan', prdwAddCon: 'Tambah batasan',
    prdwAddMod: 'Tambah modul', prdwAddRisk: 'Tambah risiko', prdwDelete: 'Hapus baris',
    prdwDelMod: 'Hapus modul', prdwDelRisk: 'Hapus risiko',
    prdwAgentText: 'Teks agent', prdwCopy: 'Salin', prdwBack: 'Kembali menulis',
    prdwEdit: 'Ubah', prdwEmptyL: 'Kosong', prdwOther: 'Tambah modul lain untuk menghubungkan',
    prdwAllows: 'Boleh mengimpor dari', prdwMatrix: 'Matriks layer (otomatis)',
    prdwAll: '— (semua modul)', prdwScope: 'Scope:', prdwStrictT: 'Ketat', prdwAdvisory: 'Saran',
    prdwStrictHint: 'Ketat memblokir agent saat dilanggar. Saran hanya pengingat.',
    prdwTitlePh: 'Aplikasi catatan tim — kolaborasi tanpa tumpang tindih',
    prdwSumPh: 'Aplikasi web untuk tim kecil menulis dan berbagi catatan.',
    prdwSumHint: 'Minimal satu kalimat penuh agar bagian ini dianggap lengkap.',
    prdwTitleHint: 'Satu baris, mudah dikenali di daftar dokumen.',
    prdwGoalPh: 'Pengguna bisa menyelesaikan alur utama tanpa bantuan',
    prdwConPh: 'Tidak boleh menambah dependency baru',
    prdwArchPh: 'Aplikasi satu halaman dengan store terpusat; UI hanya membaca dari store.',
    prdwArchHint: 'Cukup tingkat tinggi. Rincian per modul di langkah berikutnya.',
    prdwModDescPh: 'Tanggung jawab: menyimpan state PRD dan quest',
    prdwRiskPh: 'Jadwal terlalu padat', prdwMitPh: 'Mitigasi: potong fitur sekunder bila terlambat',
    prdwPairPh1: 'Nama tahap', prdwPairPh2: 'Tujuan yang bisa dicek',
    prdwNfrPh1: 'Kebutuhan', prdwNfrPh2: 'Target terukur',
    prdwTechPh1: 'Keputusan', prdwTechPh2: 'Alasan',
    prdwScopeInc: 'Scope global · include (satu glob per baris)', prdwScopeExc: 'Scope global · exclude',
    secSum: 'Identitas & Ringkasan', secGoals: 'Tujuan', secCons: 'Batasan', secArch: 'Arsitektur',
    secMods: 'Matriks Modul & Layer', secMiles: 'Milestone', secNfr: 'Non-fungsional', secRisks: 'Daftar Risiko', secTech: 'Keputusan Teknis',
    whySum: 'Judul & ringkasan menjadi identitas dokumen — agent memakainya untuk menamai quest dan memahami maksud proyek.',
    whyGoals: 'Tujuan yang bisa dicek. Agent menurunkan kriteria penerimaan quest dari daftar ini.',
    whyCons: 'Aturan main. Batasan KETAT dipakai guard untuk memblokir aksi agent yang melanggar; Saran hanya pengingat.',
    whyArch: 'Gambaran tingkat tinggi — konteks bagi agent sebelum menyentuh kode. Rincian per modul di langkah berikutnya.',
    whyMods: 'Peta modul & layer. Panel Interlinked memakainya untuk cluster node, deteksi pelanggaran layer, dan radius dampak.',
    whyMiles: 'Checkpoint pengiriman yang bisa diverifikasi. Quest dapat bergantung pada milestone ini.',
    whyNfr: 'Target terukur (kinerja, keamanan, dsb.) yang dinilai saat review.',
    whyRisks: 'Risiko + mitigasinya membantu agent memilih urutan kerja yang aman.',
    whyTech: 'Keputusan teknis + alasannya — mencegah agent mengganti pilihan yang sudah disepakati.',
    sevHigh: 'Tinggi', sevMedium: 'Sedang', sevLow: 'Rendah',
    prdwSections: 'Bagian', prdwTitleL: 'Judul proyek', prdwSummaryL: 'Ringkasan', prdwArchL: 'Gambaran arsitektur',
    prdwUnnamed: '(tanpa nama)', prdwDraftL: 'Draf', prdwModName: 'Nama modul', prdwModDesc: 'Deskripsi modul',
    prdwLayer: 'Layer', prdwRiskL: 'Risiko', prdwMit: 'Mitigasi',
    prdwModNamePh: 'Nama modul, mis. Core Store', prdwUntitledL: '(tanpa judul)',
  },
};

/** Terjemahan key sederhana (peta L dari desain topbar). */
export function tr(lang: string | undefined, key: string): string {
  return (lang && L[lang]?.[key]) || L.en[key] || key;
}

/** CSS UI RSA/T — port 1:1 design/split (self-contained, di-inject board.tsx). */
export const RSAT_CSS = `
.rsat{--al:234 88 12;--ad:249 115 22;
  --f-px:"Moriko Pixel","Silkscreen","Pixelify Sans",ui-monospace,"Cascadia Code",Consolas,monospace;
  --f-body:"Moriko Pixel Body","Pixelify Sans",ui-monospace,"Cascadia Code",Consolas,monospace;
  --f-mono:ui-monospace,"Cascadia Code",Consolas,monospace;--step:steps(6,end);
  --c-canvas:246 244 241;--c-panel:255 255 255;--c-elev:255 237 224;--c-field:250 248 246;
  --c-line:232 226 220;--c-ink:30 24 20;--a-muted:.7;--a-faint:.5;--c-accent:var(--al);--c-accent-ink:255 255 255;
  --c-rsat-face:222 214 204;--c-rsat-slot:196 187 176;--c-rsat-hi:255 255 255;--c-rsat-lo:146 134 122;--c-rsat-edge:30 24 20;--c-rsat-shine:255 255 255;
  --c-rsat-skin:214 150 110;--c-rsat-hair:98 64 38;--c-rsat-stone:140 140 140;--c-rsat-stone-dk:104 104 104;--c-rsat-mod:2 132 199;--c-rsat-xp:110 205 30;--c-rsat-add:22 163 74;--c-rsat-del:220 38 38;--c-rsat-ref:124 58 237;--c-rsat-done:22 163 74;
  --c-rsat-gold:190 138 12;--c-rsat-claimed:2 132 199;--c-rsat-available:22 163 74;--c-rsat-review:124 58 237;--c-warn:217 119 6;--c-danger:220 38 38;--c-rsat-locked:140 146 158;
  --c-rsat-bronze:176 108 54;--c-rsat-silver:120 128 142;--c-rsat-diamond:10 150 170;--c-rsat-blocked:220 38 38;--c-rsat-running:var(--c-accent);
  --c-rsat-il-bg:226 220 212;--c-rsat-il-grid:172 162 150;--c-rsat-il-node:248 244 238;--c-rsat-il-head:228 220 210;
  --c-rsat-wire-data:2 132 199;--c-rsat-wire-type:124 58 237;--c-rsat-wire-active:22 163 74;
  --c-rsat-wire-cross:217 119 6;--c-rsat-wire-broken:220 38 38;--c-rsat-pin-bg:255 255 255;
  --c-rsat-toast-bg:30 24 40;--c-rsat-toast-title:255 214 64;--c-rsat-toast-title-ch:196 160 255;
  --c-accent-soft:color-mix(in srgb,rgb(var(--c-accent)) 16%,rgb(var(--c-rsat-shine)));
  --c-rsat-tip-bg:26 12 40;--c-rsat-tip-edge:110 56 210;--c-rsat-toast-ink:255 250 242;
  --muted:rgb(var(--c-ink)/var(--a-muted));--faint:rgb(var(--c-ink)/var(--a-faint));--line:rgb(var(--c-line));
  --o3:0 -3px 0 0 rgb(var(--c-rsat-edge)),0 3px 0 0 rgb(var(--c-rsat-edge)),-3px 0 0 0 rgb(var(--c-rsat-edge)),3px 0 0 0 rgb(var(--c-rsat-edge));
  --o3a:0 -3px 0 0 rgb(var(--c-accent)),0 3px 0 0 rgb(var(--c-accent)),-3px 0 0 0 rgb(var(--c-accent)),3px 0 0 0 rgb(var(--c-accent));
  --up3:inset 3px 3px 0 rgb(var(--c-rsat-hi)),inset -3px -3px 0 rgb(var(--c-rsat-lo));
  --o2a:0 -2px 0 0 rgb(var(--c-accent)),0 2px 0 0 rgb(var(--c-accent)),-2px 0 0 0 rgb(var(--c-accent)),2px 0 0 0 rgb(var(--c-accent));
  --dn3:inset 3px 3px 0 rgb(var(--c-rsat-lo)),inset -3px -3px 0 rgb(var(--c-rsat-hi)/.55);
  --o2:0 -2px 0 0 rgb(var(--c-rsat-edge)),0 2px 0 0 rgb(var(--c-rsat-edge)),-2px 0 0 0 rgb(var(--c-rsat-edge)),2px 0 0 0 rgb(var(--c-rsat-edge));
  --up2:inset 2px 2px 0 rgb(var(--c-rsat-hi)),inset -2px -2px 0 rgb(var(--c-rsat-lo));
  --dn2:inset 2px 2px 0 rgb(var(--c-rsat-lo)),inset -2px -2px 0 rgb(var(--c-rsat-hi)/.55);
  height:100%;min-height:100%;display:flex;flex-direction:column;
  background-color:rgb(var(--c-canvas));
  background-image:conic-gradient(rgb(var(--c-ink)/.035) 25%,transparent 0 50%,rgb(var(--c-ink)/.035) 0 75%,transparent 0);background-size:8px 8px;
  color:rgb(var(--c-ink));font:13px/1.45 var(--f-body);-webkit-font-smoothing:none;text-rendering:optimizeSpeed}
.dark .rsat{--c-canvas:13 13 13;--c-panel:26 26 26;--c-elev:38 38 38;--c-field:17 17 17;--c-line:44 44 44;--c-ink:236 236 236;--a-muted:.66;--a-faint:.42;--c-accent:var(--ad);--c-accent-ink:24 12 4;
  --c-rsat-face:58 58 58;--c-rsat-slot:22 22 22;--c-rsat-hi:104 104 104;--c-rsat-lo:12 12 12;--c-rsat-edge:0 0 0;--c-rsat-stone:126 126 126;--c-rsat-stone-dk:90 90 90;--c-rsat-xp:126 230 40;--c-rsat-done:74 222 128;
  --c-rsat-gold:240 190 60;--c-rsat-claimed:56 189 248;--c-rsat-available:74 222 128;--c-rsat-review:167 139 250;--c-warn:251 191 36;--c-danger:248 113 113;--c-rsat-add:74 222 128;--c-rsat-mod:56 189 248;--c-rsat-del:248 113 113;--c-rsat-ref:167 139 250;--c-rsat-locked:96 100 112;--c-rsat-toast-bg:20 16 28;--c-accent-soft:color-mix(in srgb,rgb(var(--c-accent)) 22%,rgb(var(--c-canvas)));--c-rsat-tip-bg:16 8 28;--c-rsat-tip-edge:130 80 240;--c-rsat-toast-ink:255 250 242;--c-rsat-toast-title:255 214 64;--c-rsat-toast-title-ch:196 160 255;
  --c-rsat-bronze:205 140 84;--c-rsat-silver:178 186 200;--c-rsat-diamond:90 220 235;--c-rsat-blocked:248 113 113;
  --c-rsat-il-bg:14 16 22;--c-rsat-il-grid:42 48 64;--c-rsat-il-node:26 30 40;--c-rsat-il-head:36 42 56;
  --c-rsat-wire-data:56 189 248;--c-rsat-wire-type:167 139 250;--c-rsat-wire-active:74 222 128;
  --c-rsat-wire-cross:251 191 36;--c-rsat-wire-broken:248 113 113;--c-rsat-pin-bg:18 20 28}
.mocha .rsat{--c-canvas:24 19 17;--c-panel:38 31 28;--c-elev:54 43 38;--c-field:28 23 20;--c-line:64 52 46;--c-ink:240 228 216;--a-muted:.66;--a-faint:.42;--c-accent:var(--ad);--c-accent-ink:24 12 4;
  --c-rsat-face:78 64 56;--c-rsat-slot:30 24 21;--c-rsat-hi:124 106 94;--c-rsat-lo:16 12 10;--c-rsat-edge:0 0 0;--c-rsat-stone:130 120 112;--c-rsat-stone-dk:94 86 80;--c-rsat-xp:126 230 40;--c-rsat-done:74 222 128;
  --c-rsat-gold:240 190 60;--c-rsat-claimed:56 189 248;--c-rsat-available:74 222 128;--c-rsat-review:167 139 250;--c-warn:251 191 36;--c-danger:248 113 113;--c-rsat-add:74 222 128;--c-rsat-mod:56 189 248;--c-rsat-del:248 113 113;--c-rsat-ref:167 139 250;--c-rsat-locked:112 100 92;--c-rsat-toast-bg:28 20 22;--c-accent-soft:color-mix(in srgb,rgb(var(--c-accent)) 26%,rgb(var(--c-canvas)));--c-rsat-tip-bg:24 12 30;--c-rsat-tip-edge:140 90 230;--c-rsat-toast-ink:255 250 242;--c-rsat-toast-title:255 214 64;--c-rsat-toast-title-ch:196 160 255;
  --c-rsat-bronze:205 140 84;--c-rsat-silver:178 186 200;--c-rsat-diamond:90 220 235;--c-rsat-blocked:248 113 113;
  --c-rsat-il-bg:20 16 15;--c-rsat-il-grid:62 50 44;--c-rsat-il-node:36 29 26;--c-rsat-il-head:50 40 35;
  --c-rsat-wire-data:56 189 248;--c-rsat-wire-type:192 132 252;--c-rsat-wire-active:74 222 128;
  --c-rsat-wire-cross:251 191 36;--c-rsat-wire-broken:248 113 113;--c-rsat-pin-bg:24 19 17}
.rsat *{box-sizing:border-box}
.rsat button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer;text-align:inherit;border-radius:0}
.rsat select,.rsat input{font:inherit;color:inherit;border-radius:0}
.rsat :focus-visible{outline:3px solid rgb(var(--c-accent));outline-offset:3px}
.rsat .mono{font-family:var(--f-mono)}.rsat .muted{color:var(--muted)}.rsat .faint{color:var(--faint)}
.rsat .row{display:flex;align-items:center;gap:8px}
.rsat .trunc{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rsat .eyebrow{font:700 10.5px/1 var(--f-px);letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.rsat .i{width:18px;height:18px;flex:none;fill:none;stroke:currentColor;stroke-width:2.6;stroke-linecap:square;stroke-linejoin:miter;shape-rendering:crispEdges;display:block}
/* Ikon DI DALAM kontrol: ukur dinamis unit em — mengikuti ukuran font tombol,
   bukan px fixed. Di luar kontrol (.fe .fi, .lrow .op) tetap 18/14px. */
.rsat .btn .i,.rsat .chip .i,.rsat .tab .i,.rsat .slot .i{width:1.35em;height:1.35em}
.rsat .btn.sm .i,.rsat .chip .i,.rsat .tab .i{width:1.25em;height:1.25em}
.rsat .icon-btn .i{width:1.7em;height:1.7em}
.rsat .spr{display:block;width:100%;height:100%;shape-rendering:crispEdges;image-rendering:pixelated;overflow:visible}
.rsat .spr .k{fill:rgb(var(--c-rsat-edge))}.rsat .spr .g{fill:rgb(var(--c-rsat-stone))}.rsat .spr .h{fill:rgb(var(--c-rsat-stone-dk))}
.rsat .spr .a{fill:var(--sa,rgb(var(--c-accent)))}
.rsat .spr .b{fill:color-mix(in srgb,var(--sa,rgb(var(--c-accent))) 58%,rgb(var(--c-rsat-edge)))}
.rsat .spr .c{fill:color-mix(in srgb,var(--sa,rgb(var(--c-accent))) 55%,rgb(var(--c-rsat-shine)))}
.rsat .spr .w{fill:rgb(var(--c-rsat-shine))}.rsat .spr .s{fill:rgb(var(--c-rsat-skin))}.rsat .spr .y{fill:rgb(var(--c-rsat-hair))}
.rsat .spr .m{fill:color-mix(in srgb,rgb(var(--c-rsat-skin)) 55%,rgb(var(--c-rsat-edge)))}
.rsat .face{width:18px;height:18px;display:inline-block;flex:none;vertical-align:middle;--sa:rgb(var(--c-rsat-mod))}
.rsat .btn{height:34px;padding:0 14px;margin:2px;border:0;border-radius:0;display:inline-flex;align-items:center;gap:8px;font:700 11.5px var(--f-px);letter-spacing:.05em;text-transform:uppercase;white-space:nowrap;
  background:rgb(var(--c-rsat-face));box-shadow:var(--o2),var(--up2);text-shadow:1px 1px 0 rgb(var(--c-ink)/.12)}
.rsat .btn:hover{background:rgb(var(--c-elev))}
.rsat .btn:active{box-shadow:var(--o2),var(--dn2);transform:translateY(2px)}
.rsat .btn.sm{height:28px;padding:0 10px;font-size:10.5px}
.rsat .btn.ghost{background:none;box-shadow:none}
.rsat .btn.ghost:hover{background:rgb(var(--c-ink)/.08)}
.rsat .btn[disabled]{opacity:.45;pointer-events:none;filter:grayscale(1)}
.rsat .field{height:34px;margin:2px;padding:0 10px;min-width:0;border:0;border-radius:0;width:auto;border:0;background:rgb(var(--c-rsat-slot));box-shadow:var(--o2),var(--dn2)}
.rsat .sw{width:20px;height:20px;margin:2px;--sa:var(--ac);background:rgb(var(--sa));box-shadow:var(--o2);border-radius:0}
.rsat .sw[aria-pressed=true]{box-shadow:var(--o2),0 0 0 4px rgb(var(--c-ink))}
.rsat .sw[data-accent=ember]{--ac:234 88 12}
.rsat .sw[data-accent=sakura]{--ac:219 39 119}
.rsat .sw[data-accent=matcha]{--ac:22 163 74}
.rsat .sw[data-accent=ocean]{--ac:2 132 199}
.rsat .sw[data-accent=violet]{--ac:124 58 237}
.rsat .seg-ctl{display:inline-flex;gap:4px}
.rsat .seg-ctl button{height:30px;margin:2px;padding:0 12px;font:700 11px var(--f-px);color:var(--muted);background:rgb(var(--c-rsat-face));box-shadow:var(--o2),var(--up2)}
.rsat .seg-ctl button[aria-pressed=true]{background:rgb(var(--c-accent));color:rgb(var(--c-accent-ink));box-shadow:var(--o2),var(--dn2)}
.rsat .topbar{display:flex;align-items:center;gap:10px;height:auto;position:relative;padding:10px 16px;background:rgb(var(--c-rsat-face));border-bottom:3px solid rgb(var(--c-rsat-edge));flex-wrap:wrap}
.rsat .crumb{display:flex;align-items:center;gap:6px;height:auto;padding:0;border:0;border-radius:0;color:var(--muted);font:600 12px var(--f-px)}
.rsat .crumb b{color:rgb(var(--c-ink))}
/* icon-btn topbar (desain baris 149): tombol sidebar buka/tutup dock.
   DOM di dalam .crumb (permintaan user); absolut ke pojok kanan topbar. */
.rsat .icon-btn{position:absolute;top:3px;right:6px;width:20px;height:20px;margin:2px;display:grid;place-items:center;color:var(--muted);flex:none;border:0;border-radius:0;background:rgb(var(--c-rsat-face));box-shadow:var(--o2),var(--up2);z-index:2}
.rsat .icon-btn:hover{color:rgb(var(--c-ink));box-shadow:var(--o2a),var(--up2)}
.rsat .icon-btn:active,.rsat .icon-btn[aria-expanded=true]{box-shadow:var(--o2),var(--dn2)}
/* Tombol host-sidebar: in-flow di KIRI topbar (bukan absolut). */
.rsat .icon-btn.host-toggle{position:static;top:auto;right:auto;width:34px;height:34px}
.rsat .demo{display:flex;align-items:center;gap:6px;margin-left:auto;margin-right:40px;flex-wrap:wrap}
.rsat .app{position:relative;z-index:auto;display:flex;flex:1;min-width:0;min-height:0;height:auto;padding:14px}
.rsat .work{position:relative;flex:1;min-width:0;display:flex;flex-direction:column;background:rgb(var(--c-panel));border:0;border-radius:0;box-shadow:var(--o3),var(--up3);overflow:hidden}
.rsat .view{position:relative;inset:auto;display:block;flex:1;min-height:0;overflow:auto;padding:22px clamp(14px,3vw,32px) 150px;scroll-behavior:smooth}
.rsat .view-in{height:100%;min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;border:3px dashed var(--line);position:relative}
.rsat .canvas-hint{display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center;padding:24px;max-width:420px}
.rsat .canvas-hint b{font:700 14px var(--f-px);letter-spacing:.03em;text-transform:uppercase}
.rsat .canvas-hint p{margin:0;color:var(--muted);font-size:12.5px}
.rsat .chips{display:flex;gap:6px;flex-wrap:wrap;justify-content:center}
.rsat .chip{font:700 9.5px var(--f-px);letter-spacing:.05em;text-transform:uppercase;padding:2px 7px;background:rgb(var(--c-rsat-slot));box-shadow:inset 0 0 0 2px rgb(var(--c-rsat-lo));color:var(--muted);display:inline-block;height:auto;border:0;border-radius:0;max-width:none}
/* ── HUD (rsat-panel-hud.html) ─────────────────────────────────────────── */
.rsat .pn{background:rgb(var(--c-rsat-face));box-shadow:var(--o3),var(--up3);position:relative}
.rsat .seg{display:flex;gap:2px;padding:2px;border:0;border-radius:0;background:rgb(var(--c-rsat-edge));--sc:var(--c-accent)}
.rsat .seg i{flex:1;height:8px;background:rgb(var(--c-rsat-slot));box-shadow:inset 0 -2px 0 rgb(var(--c-rsat-lo)/.6)}
.rsat .seg i.on{background:rgb(var(--sc));box-shadow:inset 0 2px 0 rgb(var(--c-rsat-shine)/.4),inset 0 -2px 0 rgb(var(--c-rsat-edge)/.3)}
.rsat .seg.xp{--sc:var(--c-rsat-xp)}
.rsat .hud{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);z-index:20;display:flex;flex-direction:column;align-items:center;gap:4px;pointer-events:none}
.rsat .hud>*{pointer-events:auto}
.rsat .xpw{width:min(440px,72vw);display:flex;flex-direction:column;align-items:center;gap:3px}
.rsat .lvn{font:700 18px/1 var(--f-px);color:rgb(var(--c-rsat-xp));text-shadow:2px 0 0 rgb(var(--c-rsat-edge)),-2px 0 0 rgb(var(--c-rsat-edge)),0 2px 0 rgb(var(--c-rsat-edge)),0 -2px 0 rgb(var(--c-rsat-edge))}
.rsat .xpw .seg{width:100%}
.rsat .hotbar{display:flex;gap:6px;padding:8px;margin:4px 3px 0}
.rsat .slot{position:relative;width:46px;height:46px;margin:2px;display:grid;place-items:center;flex:none;color:var(--muted);background:rgb(var(--c-rsat-slot));box-shadow:var(--o2),var(--dn2)}
.rsat .slot:hover{color:rgb(var(--c-ink));box-shadow:var(--o2a),var(--dn2)}
.rsat .slot[aria-current=page]{color:rgb(var(--c-accent));box-shadow:var(--dn2),0 0 0 2px rgb(var(--c-rsat-edge)),0 0 0 5px rgb(var(--c-ink)),0 0 0 7px rgb(var(--c-rsat-edge))}
.rsat .slot .i{width:22px;height:22px}
.rsat .slot kbd{position:absolute;left:2px;top:1px;padding:0;font:700 9px var(--f-px);color:var(--muted)}
.rsat .slot .badge{position:absolute;right:-3px;bottom:-3px}
.rsat .badge{min-width:18px;height:18px;padding:0 4px;border:0;border-radius:0;top:auto;left:auto;background:rgb(var(--c-accent));color:rgb(var(--c-accent-ink));font:700 10.5px/18px var(--f-px);text-align:center;box-shadow:0 0 0 2px rgb(var(--c-rsat-edge))}
/* ── DOCK (rsat-panel-dock.html) ───────────────────────────────────────── */
.rsat .grow{flex:1;min-width:0}
.rsat .col{display:flex;flex-direction:column;gap:8px}
.rsat .i.sm{width:14px;height:14px}
.rsat .spr.off .w{opacity:0}
.rsat .hearts{display:inline-flex;gap:2px;vertical-align:middle}
.rsat .hearts .spr{width:14px;height:12px;filter:drop-shadow(1px 1px 0 rgb(var(--c-rsat-edge)))}
.rsat .st-ok{--pc:rgb(var(--c-rsat-done))}
.rsat .st-warn{--pc:rgb(var(--c-warn))}
.rsat .st-muted{--pc:rgb(var(--c-rsat-locked))}
.rsat .pill{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 7px;font:700 10px var(--f-px);letter-spacing:.05em;text-transform:uppercase;white-space:nowrap;
  border:0;border-radius:0;max-width:none;
  background:color-mix(in srgb,var(--pc) 20%,rgb(var(--c-rsat-slot)));color:rgb(var(--c-ink));box-shadow:inset 0 0 0 2px var(--pc)}
.rsat .pill:hover{color:rgb(var(--c-ink));border-color:transparent}
.rsat .seg.done{--sc:var(--c-rsat-done)}
/* Dock: panel MELAYANG (absolute di kanan) — tidak mendorong Canvas utama,
   hanya overlay di atasnya. Default tertutup; toggle dari Topbar. */
.rsat .dock{position:absolute;top:26px;right:26px;bottom:26px;width:340px;display:flex;flex-direction:column;gap:22px;overflow-x:hidden;overflow-y:auto;padding:3px;z-index:30;opacity:1;transform:translateX(0);
  transition:opacity .25s var(--step),transform .25s var(--step),visibility 0s}
.rsat .dock[data-open="false"]{opacity:0;transform:translateX(14px);visibility:hidden;pointer-events:none;
  transition:opacity .25s var(--step),transform .25s var(--step),visibility 0s .25s}
.rsat .dock-card{background:rgb(var(--c-rsat-face));box-shadow:var(--o3),var(--up3);position:relative;padding:14px;height:auto;overflow:visible;width:334px;flex:none}
.rsat .ag-ic{width:32px;height:32px;padding:5px;display:grid;place-items:center;flex:none;background:rgb(var(--c-rsat-slot));box-shadow:inset 0 0 0 2px rgb(var(--c-rsat-lo));color:rgb(var(--c-accent))}
/* ── BASECAMP (rsat-panel-basecamp.html) ───────────────────────────────── */
.rsat .view-in.live{height:auto;min-height:100%;align-items:stretch;justify-content:flex-start;gap:24px;border:0;max-width:1180px;margin:0 auto}
.rsat h1,.rsat h2,.rsat h3{margin:0;font-family:var(--f-px);letter-spacing:.02em;font-weight:700;text-shadow:1px 1px 0 rgb(var(--c-ink)/.14)}
.rsat h1{font-size:22px;line-height:1.2}.rsat h2{font-size:14px;text-transform:uppercase}.rsat h3{font-size:13px}
.rsat .card{background:rgb(var(--c-rsat-face));box-shadow:var(--o3),var(--up3);position:relative;padding:16px;border:0;border-radius:0;overflow:visible}
.rsat .btn.pri{background:rgb(var(--c-accent));color:rgb(var(--c-accent-ink));text-shadow:1px 1px 0 rgb(var(--c-rsat-edge)/.45)}
.rsat .btn.pri:hover{filter:brightness(1.08)}
.rsat .pn.in{background:rgb(var(--c-rsat-slot));box-shadow:var(--o3),var(--dn3)}
.rsat .pn.hov{cursor:pointer;transition:transform .12s var(--step)}
.rsat .pn.hov:hover{transform:translateY(-3px);box-shadow:var(--o3a),var(--up3)}
.rsat .pn.in.hov:hover{box-shadow:var(--o3a),var(--dn3)}
.rsat .st-claimed{--pc:rgb(var(--c-rsat-claimed))}
.rsat .st-in_progress{--pc:rgb(var(--c-rsat-running))}
.rsat .st-review{--pc:rgb(var(--c-rsat-review))}
.rsat .st-blocked{--pc:rgb(var(--c-rsat-blocked))}
.rsat .st-danger{--pc:rgb(var(--c-danger))}
.rsat .seg.thin i{height:5px}
.rsat .mw{position:relative;display:inline-grid;flex:none}
.rsat .medal{--mc:var(--c-rsat-bronze);--u:4px;--bd:3px;--sz:48px;--s0:var(--u);--st:var(--s0);width:var(--sz);height:var(--sz);flex:none;position:relative;display:grid;place-items:center;
  background:rgb(var(--c-rsat-edge));color:rgb(var(--c-rsat-edge))}
.rsat .medal::before,.rsat .medal::after{content:"";position:absolute;inset:var(--bd);--st:calc(var(--s0) - var(--bd))}
.rsat .medal::before{background:rgb(var(--mc))}
.rsat .medal::after{box-shadow:inset 3px 3px 0 rgb(var(--c-rsat-shine)/.5),inset -3px -3px 0 rgb(var(--c-rsat-edge)/.28)}
.rsat .medal,.rsat .medal::before,.rsat .medal::after{clip-path:polygon(0 var(--st),var(--st) var(--st),var(--st) 0,calc(100% - var(--st)) 0,calc(100% - var(--st)) var(--st),100% var(--st),100% calc(100% - var(--st)),calc(100% - var(--st)) calc(100% - var(--st)),calc(100% - var(--st)) 100%,var(--st) 100%,var(--st) calc(100% - var(--st)),0 calc(100% - var(--st)))}
.rsat .medal .spr,.rsat .medal .i{position:relative;z-index:1;width:56%;height:56%}
.rsat .medal.t-silver{--mc:var(--c-rsat-silver)}.rsat .medal.t-gold{--mc:var(--c-rsat-gold);--s0:calc(var(--u)*2)}.rsat .medal.t-diamond{--mc:var(--c-rsat-diamond);--s0:calc(var(--u)*3)}
.rsat .medal.lock{--mc:var(--c-rsat-locked)}
.rsat .medal.sm{--sz:32px;--u:3px;--bd:2px}.rsat .medal.lg{--sz:64px;--u:5px;--bd:4px}
.rsat .medal.glow,.rsat .medal.shine{animation:flash 1.2s steps(2) infinite}
.rsat .bdg{position:absolute;right:-6px;bottom:-6px;width:20px;height:20px;padding:3px;background:rgb(var(--c-rsat-edge));z-index:2}
.rsat .mw.sm .bdg{width:16px;height:16px;padding:2px;right:-4px;bottom:-4px}
.rsat .pip{position:absolute;right:-4px;top:-4px;width:14px;height:14px;background:var(--pc);box-shadow:0 0 0 2px rgb(var(--c-rsat-edge));z-index:2;animation:blink 1.2s steps(2) infinite}
.rsat .mw.sm .pip{width:10px;height:10px}
.rsat .hero{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:22px;align-items:center;padding:22px;text-align:left}
.rsat .dropw{width:84px;display:flex;flex-direction:column;align-items:center}
.rsat .drop{position:static;inset:auto;opacity:1;pointer-events:auto;transition:none;border:0;background:none;color:inherit;font-weight:normal;display:block;gap:0;width:72px;height:64px;animation:bob 1.6s steps(4) infinite}
.rsat .dropw::after{content:"";width:44px;height:6px;margin-top:8px;background:rgb(var(--c-rsat-edge)/.28)}
.rsat .hero .meta{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;margin-left:0}
.rsat .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:18px}
.rsat .stat{padding:14px;display:flex;flex-direction:column;gap:8px;border:0;border-radius:0;font-size:inherit;font-weight:inherit;color:inherit;white-space:normal}.rsat .stat b{font:700 28px/1 var(--f-px);font-variant-numeric:tabular-nums}
.rsat .two{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:22px}.rsat .two>*{min-width:0}
.rsat .qrow{display:flex;align-items:center;gap:10px;padding:8px 10px}.rsat .qseg{width:84px}
.rsat .avatar{width:36px;height:36px;margin:2px;padding:5px;display:grid;place-items:center;flex:none;background:rgb(var(--c-rsat-face));box-shadow:var(--o2),var(--up2)}
.rsat .avatar .face{width:24px;height:24px}
.rsat img.face{object-fit:contain;image-rendering:pixelated;background:rgb(var(--c-rsat-face))}
.rsat button.avatar{cursor:pointer}
.rsat .holder{display:inline-flex;align-items:center;gap:6px;font-size:12px;flex-wrap:wrap}
.rsat .tag{font:700 10.5px var(--f-px);padding:3px 7px;background:rgb(var(--c-rsat-slot));box-shadow:inset 0 0 0 2px rgb(var(--c-rsat-lo));color:var(--muted)}
.rsat .tag.in{box-shadow:inset 0 0 0 2px rgb(var(--c-rsat-available))}.rsat .tag.ex{box-shadow:inset 0 0 0 2px rgb(var(--c-rsat-blocked))}
.rsat .empty{padding:40px 16px;text-align:center;color:var(--muted);border:3px dashed var(--line)}
/* ── QUEST BOARD (rsat-panel-quest-board.html) ─────────────────────────── */
.rsat .toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.rsat .search{display:flex;align-items:center;gap:8px;height:34px;margin:2px;padding:0 10px;
  background:rgb(var(--c-rsat-slot));box-shadow:var(--o2),var(--dn2);color:var(--muted);
  border:0;border-radius:0;max-width:none;animation:none;transition:none}
.rsat .search input{flex:1;min-width:0;border:0;background:none;outline:0;border-radius:0;color:rgb(var(--c-ink));font:inherit}
.rsat .toolbar .chip{height:28px;margin:2px;padding:0 10px;font:700 10.5px var(--f-px);letter-spacing:.04em;
  text-transform:uppercase;color:var(--muted);display:inline-flex;align-items:center;gap:6px;
  background:rgb(var(--c-rsat-face));box-shadow:var(--o2),var(--up2);border:0;border-radius:0;
  max-width:none;animation:none;transition:none;flex:none}
.rsat .toolbar .chip:hover{color:rgb(var(--c-ink))}
.rsat .toolbar .chip[aria-pressed=true]{background:rgb(var(--c-accent-soft));color:rgb(var(--c-ink));box-shadow:var(--o2a),var(--dn2)}
.rsat .dot{width:10px;height:10px;background:var(--pc);box-shadow:0 0 0 2px rgb(var(--c-rsat-edge));flex:none}
.rsat .group-h{display:flex;align-items:center;gap:10px;margin:6px 0 16px}
.rsat .group-h .line{flex:1;height:0;border-top:3px dashed var(--line)}
.rsat .board{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:22px}
.rsat .ach{display:flex;flex-direction:column;gap:10px;padding:14px;width:100%}
.rsat .ach h3{font-size:13px;line-height:1.3}
.rsat .ach .top{display:flex;gap:14px;align-items:flex-start}
.rsat .ach .foot{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);flex-wrap:wrap}
.rsat .ach.locked{filter:saturate(.3);opacity:.8}
.rsat .st-locked{--pc:rgb(var(--c-rsat-locked))}
.rsat .st-available{--pc:rgb(var(--c-rsat-available))}
.rsat .st-done{--pc:rgb(var(--c-rsat-done))}
.rsat .st-dropped{--pc:rgb(var(--c-rsat-locked))}
/* ── SKILL TREE (rsat-panel-skill-tree.html) ───────────────────────────── */
.rsat .legend{display:flex;gap:14px;flex-wrap:wrap;font:600 11px var(--f-px);color:var(--muted)}
.rsat .legend span{display:inline-flex;align-items:center;gap:6px}
/* Latar kayu birch (SVG contoh user): base #E8D78F + serat #D6C47A + sorot
   #F4E8B0; serat ditarik 6px dari tepi tile → repeat mulus, tidak ada serat
   terpotong di sambungan. Seluruh pn in treewrap terisi; border pn = batas. */
.rsat .treewrap{position:relative;overflow:hidden;height:clamp(380px,62vh,660px);padding:3px;touch-action:none;cursor:grab;user-select:none;
  background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='128' height='128'%3E%3Crect width='128' height='128' fill='%23E8D78F'/%3E%3Crect x='12' y='10' width='34' height='4' fill='%23D6C47A'/%3E%3Crect x='70' y='22' width='26' height='4' fill='%23D6C47A'/%3E%3Crect x='96' y='46' width='22' height='4' fill='%23D6C47A'/%3E%3Crect x='18' y='58' width='30' height='4' fill='%23D6C47A'/%3E%3Crect x='64' y='78' width='34' height='4' fill='%23D6C47A'/%3E%3Crect x='8' y='98' width='24' height='4' fill='%23D6C47A'/%3E%3Crect x='100' y='104' width='20' height='4' fill='%23D6C47A'/%3E%3Crect x='44' y='34' width='8' height='4' fill='%23F4E8B0'/%3E%3Crect x='84' y='66' width='8' height='4' fill='%23F4E8B0'/%3E%3Crect x='30' y='112' width='8' height='4' fill='%23F4E8B0'/%3E%3C/svg%3E") repeat;
  background-size:128px 128px}
.rsat .treewrap.grabbing{cursor:grabbing}
/* tree-in = lapisan kamera: mengisi PERSIS area treewrap (inset:0); dunia
   (.world) berukuran map dan dipusatkan di dalamnya → achievement bercabang
   dari tengah. */
.rsat .tree-in{position:absolute;inset:0;transform-origin:0 0}
.rsat .world{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%)}
.rsat .tree-in svg.lines{position:absolute;left:0;top:0;pointer-events:none}
.rsat .ln{fill:none;stroke:rgb(var(--c-rsat-locked));stroke-width:4;shape-rendering:crispEdges;stroke-linejoin:miter}
.rsat .ln.on{stroke:rgb(var(--c-rsat-done))}
.rsat .nd{position:absolute;width:64px;display:flex;flex-direction:column;align-items:center;gap:6px}
.rsat .nd:hover,.rsat .nd:focus-visible{z-index:30}
.rsat .nd .nl{font:700 10px var(--f-px);color:var(--muted)}
/* Tip node: reset total bocoran .tip host (fixed/opacity:0/radius8/ink) */
.rsat .tip{display:none;position:absolute;left:calc(100% + 14px);top:0;width:236px;padding:8px 10px;
  flex-direction:column;gap:4px;text-align:left;font-size:12px;font-weight:400;line-height:1.35;
  pointer-events:none;max-width:none;opacity:1;transform:none;border-radius:0;border:0;transition:none;
  background:rgb(var(--c-rsat-tip-bg)/.97);color:rgb(var(--c-rsat-toast-ink));
  box-shadow:0 0 0 3px rgb(var(--c-rsat-tip-edge)),0 0 0 6px rgb(var(--c-rsat-edge));z-index:25}
.rsat .nd:hover .tip,.rsat .nd:focus-visible .tip{display:flex}
.rsat .tt{font:700 12.5px var(--f-px)}
.rsat .tt.t-bronze{color:rgb(var(--c-rsat-bronze))}.rsat .tt.t-silver{color:rgb(var(--c-rsat-silver))}.rsat .tt.t-gold{color:rgb(var(--c-rsat-gold))}.rsat .tt.t-diamond{color:rgb(var(--c-rsat-diamond))}
.rsat .tm{color:rgb(var(--c-rsat-toast-ink)/.7);font-size:11px}
/* ── LIVE FEED (rsat-panel-live-feed.html) ─────────────────────────────── */
.rsat .chat{display:flex;flex-direction:column;gap:2px;padding:10px 12px;background:rgb(var(--c-rsat-tip-bg)/.94);color:rgb(var(--c-rsat-toast-ink));box-shadow:var(--o3);font-family:var(--f-mono);font-size:12.5px;max-height:560px;overflow:auto;border:0;border-radius:0}
.rsat .fe{display:flex;gap:10px;padding:3px 4px;animation:fin .3s steps(4) both}
.rsat .fe:hover{background:rgb(var(--c-rsat-shine)/.08)}
.rsat .fe .ts{color:rgb(var(--c-rsat-toast-ink)/.55);flex:none}
.rsat .fe .fi{color:rgb(var(--c-accent));flex:none}
@keyframes fin{from{opacity:0;transform:translateX(-12px)}}
.rsat .gres{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;margin:2px;background:rgb(var(--c-rsat-slot));box-shadow:var(--o2);font-size:12.5px}
.rsat .gres .dot{margin-top:4px}
/* .hint host = opacity:0 (elemen pemandu) — di-reset supaya terlihat. */
.rsat .hint{display:block;padding-top:0;font-size:12px;color:var(--muted);opacity:1;transition:none}
.rsat .chat .empty{padding:24px 16px}
/* ── INVENTORY (rsat-panel-inventory.html) ─────────────────────────────── */
.rsat .tblw{padding:0;overflow:auto}
.rsat .tbl{width:100%;border-collapse:collapse;font-size:13px}
.rsat .tbl th{text-align:left;font:700 10px var(--f-px);letter-spacing:.1em;text-transform:uppercase;color:var(--muted);padding:9px 10px;background:rgb(var(--c-rsat-face));border-bottom:3px solid rgb(var(--c-rsat-edge))}
.rsat .tbl td{padding:9px 10px;border-bottom:2px dashed var(--line);vertical-align:top}
.rsat .op{--oc:var(--c-rsat-mod);width:32px;height:32px;display:grid;place-items:center;background:rgb(var(--oc));color:rgb(var(--c-rsat-edge));box-shadow:0 0 0 2px rgb(var(--c-rsat-edge)),inset 2px 2px 0 rgb(var(--c-rsat-shine)/.45)}
.rsat .op.add{--oc:var(--c-rsat-add)}.rsat .op.del{--oc:var(--c-rsat-del)}.rsat .op.ref{--oc:var(--c-rsat-ref)}.rsat .op.ren{--oc:var(--c-rsat-claimed)}
/* ── OPTIONS (rsat-panel-options.html) ─────────────────────────────────── */
.rsat .set{display:flex;align-items:center;gap:14px;padding:14px 0;border-bottom:3px dashed var(--line)}
.rsat .set:last-child{border-bottom:0}
.rsat .switch{width:54px;height:28px;margin:2px;flex:none;position:relative;background:rgb(var(--c-rsat-slot));box-shadow:var(--o2),var(--dn2);border:0;border-radius:0}
.rsat .switch::after{content:"";position:absolute;top:4px;left:4px;width:20px;height:20px;background:rgb(var(--c-rsat-face));box-shadow:var(--up2);transition:transform .15s steps(3)}
.rsat .switch[aria-checked=true]{background:rgb(var(--c-accent))}
.rsat .switch[aria-checked=true]::after{transform:translateX(26px)}
.rsat .btn.dng{color:rgb(var(--c-danger))}
.rsat .btn[disabled]{opacity:.45;pointer-events:none;filter:grayscale(1)}
/* ── DRAWER (rsat-panel-drawer.html) ──────────────────────────────────── */
/* Drawer wrap: satu wadah fixed yang menampung scrim+drawer — animasi translateX
   drawer TIDAK meluber ke layout host (dulu mendorong canvas/layar moriko). */
.rsat .dwrap{position:fixed;inset:0;z-index:35;overflow:hidden;pointer-events:none}
.rsat .dwrap.on{pointer-events:auto}
.rsat .scrim{position:absolute;inset:0;display:none;background:rgb(var(--c-shadow)/.5);opacity:1;pointer-events:auto;transition:none;backdrop-filter:none;filter:none}
.rsat .scrim.on{display:block}
.rsat .drawer{position:absolute;top:0;right:0;height:100%;width:min(520px,100%);transform:translateX(106%);transition:transform .3s var(--step);z-index:40;background:rgb(var(--c-rsat-face));
  box-shadow:-3px 0 0 0 rgb(var(--c-rsat-edge)),var(--up3);display:flex;flex-direction:column;border:0;border-radius:0;opacity:1;pointer-events:auto}
.rsat .drawer.open{transform:none}
.rsat .d-head{padding:18px 18px 14px;display:flex;gap:16px;align-items:flex-start}
.rsat .d-head .icon-btn{position:static;top:auto;right:auto;width:34px;height:34px;margin:2px;z-index:auto}
/* .tabs/.tab host: radius 9-11px + bg field — di-reset, gaya tab desain menang. */
.rsat .tabs{display:flex;gap:6px;padding:0 16px;border:0;border-bottom:3px solid rgb(var(--c-rsat-edge));border-radius:0;background:none}
.rsat .tab{height:34px;margin-top:4px;padding:0 12px;font:700 11px var(--f-px);text-transform:uppercase;color:var(--muted);display:flex;align-items:center;gap:6px;
  background:rgb(var(--c-rsat-slot));border:0;border-radius:0;box-shadow:0 -3px 0 0 rgb(var(--c-rsat-edge)),-3px 0 0 0 rgb(var(--c-rsat-edge)),3px 0 0 0 rgb(var(--c-rsat-edge)),var(--dn2)}
.rsat .tab[aria-selected=true]{height:40px;margin-top:0;background:rgb(var(--c-panel));color:rgb(var(--c-ink));position:relative;top:3px;
  box-shadow:0 -3px 0 0 rgb(var(--c-accent)),-3px 0 0 0 rgb(var(--c-rsat-edge)),3px 0 0 0 rgb(var(--c-rsat-edge))}
.rsat .d-body{flex:1;overflow:auto;padding:16px 18px;display:flex;flex-direction:column;gap:16px;background:rgb(var(--c-panel))}
.rsat .d-act{padding:12px 18px;border-top:3px solid rgb(var(--c-rsat-edge));display:flex;gap:8px;flex-wrap:wrap;background:rgb(var(--c-rsat-face))}
.rsat .check{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;margin:2px;background:rgb(var(--c-rsat-slot));box-shadow:var(--o2)}
.rsat .cbx{width:22px;height:22px;display:grid;place-items:center;flex:none;margin-top:1px;padding:3px;background:rgb(var(--c-rsat-face));box-shadow:var(--o2),var(--dn2);border:0;border-radius:0}
.rsat .cbx .spr{opacity:0}.rsat .cbx[aria-checked=true] .spr{opacity:1}.rsat .cbx[disabled]{opacity:.5}
.rsat .cmt{display:flex;gap:10px}.rsat .cmt .bub{flex:1;padding:9px 12px;margin:2px;background:rgb(var(--c-rsat-slot));box-shadow:var(--o2);border:0;border-radius:0}
.rsat .cmt.agent .bub{background:rgb(var(--c-rsat-tip-bg)/.9);color:rgb(var(--c-rsat-toast-ink))}
.rsat .cmt .avatar .face{width:24px;height:24px}
.rsat .ledger{display:flex;flex-direction:column;gap:12px}
.rsat .lrow{display:grid;grid-template-columns:auto 1fr;gap:10px;padding:10px;margin:2px;background:rgb(var(--c-rsat-slot));box-shadow:var(--o2)}
.rsat .lrow.pending{box-shadow:var(--o2),inset 0 0 0 3px rgb(var(--c-warn))}
.rsat .note{display:flex;gap:10px;padding:10px 12px;margin:2px;background:rgb(var(--c-accent-soft));box-shadow:var(--o2);font-size:12.5px}
.rsat textarea.field{height:auto;min-height:60px;padding:8px 10px;resize:vertical;width:100%}
/* ── POPUP NOTIFICATION (rsat-panel-popup-notification.html) ───────────── */
/* Posisi tengah-atas (RSAT.txt butir 7) + animasi pop-up halus. */
.rsat .toasts{position:fixed;top:16px;left:50%;right:auto;transform:translateX(-50%);z-index:90;display:flex;flex-direction:column;gap:14px;align-items:center;max-width:94vw;pointer-events:none}
.rsat .toast{--tc:var(--c-accent);pointer-events:auto;width:min(340px,92vw);display:flex;gap:12px;align-items:center;padding:12px 16px 14px 12px;position:relative;overflow:hidden;text-align:left;font-size:13px;cursor:pointer;
  background:rgb(var(--c-rsat-toast-bg));color:rgb(var(--c-rsat-toast-ink));box-shadow:var(--o3),inset 0 0 0 3px rgb(var(--tc)/.6);animation:tin .45s cubic-bezier(.22,1,.36,1) both;border:0;border-radius:0}
.rsat .toast.ach{--tc:var(--c-rsat-gold)}.rsat .toast.ch{--tc:var(--c-rsat-review)}
.rsat .toast.warn{--tc:var(--c-warn)}.rsat .toast.error{--tc:var(--c-danger)}.rsat .toast.info{--tc:var(--c-rsat-claimed)}.rsat .toast.ok{--tc:var(--c-rsat-done)}
.rsat .toast.out{animation:tout .3s cubic-bezier(.22,1,.36,1) both}
.rsat .toast small{display:block;font:700 10.5px var(--f-px);letter-spacing:.1em;text-transform:uppercase;color:rgb(var(--tc))}
.rsat .toast.ach small{color:rgb(var(--c-rsat-toast-title))}.rsat .toast.ch small{color:rgb(var(--c-rsat-toast-title-ch))}
.rsat .toast b{display:block;font:700 13.5px/1.25 var(--f-px)}
.rsat .toast .s{display:block;font-size:12px;opacity:.78}
.rsat .toast .tbtn{flex:none;font:700 10px var(--f-px);letter-spacing:.05em;text-transform:uppercase;color:rgb(var(--tc));text-decoration:underline;padding:2px 4px}
.rsat .toast .bar{position:absolute;left:0;bottom:0;height:4px;width:100%;background:rgb(var(--tc));transform-origin:left;animation:tbar var(--dur,5s) steps(20) forwards}
@keyframes tin{from{opacity:0;transform:translateY(-28px) scale(.96)}}
@keyframes tout{to{opacity:0;transform:translateY(-18px) scale(.97)}}
@keyframes tbar{to{transform:scaleX(0)}}
@keyframes blink{50%{opacity:.35}}
@keyframes flash{50%{filter:brightness(1.4)}}
@keyframes bob{50%{transform:translateY(-8px)}}
/* ── LANGGATE + PRD/QUEST FORM ─────────────────────────────────────────── */
.rsat .gate{flex:1;display:grid;place-items:center;padding:24px;background:rgb(var(--c-canvas))}
.rsat .gcard{width:min(560px,100%);display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center;padding:32px 28px}
.rsat .pform{display:flex;flex-direction:column;gap:16px;padding:22px}
.rsat .pform .eyebrow{margin-top:2px}
/* ── INTERLINKED (ComfyUI glowing node-wire graph + @RSLK v1) ───────────── */
.rsat .il-shell{display:flex;flex-direction:column;gap:10px;width:100%;flex:1;min-height:0}
/* Fullscreen: keluar dari cap 1180px container .view-in.live saat Interlinked aktif,
   dan isi persis tinggi .view (padding .view sudah memberi jarak pojok). */
.rsat .view:has(.il-shell){padding-bottom:22px}
.rsat .view-in.live:has(.il-shell){max-width:none;height:100%;min-height:0}
.rsat .il-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:4px 8px}
/* Bar ramping: chip & tombol di dalam bar lebih kecil dari default global. */
.rsat .il-bar .chip{font-size:8.5px;padding:1px 5px}
.rsat .il-bar .btn.sm{height:22px;padding:0 7px;font-size:9.5px}
/* LEGENDS: tombol pojok kanan-bawah dalam viewport + popup legenda. */
.rsat .il-legend-ctl{position:absolute;right:10px;bottom:10px;z-index:25;display:flex;flex-direction:column;align-items:flex-end;gap:8px}
.rsat .il-legend-pop{width:300px;display:flex;flex-direction:column;gap:8px;padding:12px;font:700 10px var(--f-px);letter-spacing:.05em;text-transform:uppercase}
.rsat .il-legend-pop .il-leg-i{text-transform:none;font:600 11px var(--f-mono);color:rgb(var(--c-ink))}
.rsat .il-legend-pop .muted{text-transform:none;font-family:var(--f-mono);letter-spacing:0}
.rsat .il-legend{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:6px 12px;font:700 10px var(--f-px);letter-spacing:.05em;text-transform:uppercase}
.rsat .il-leg-i{display:inline-flex;align-items:center;gap:6px;color:var(--muted)}
.rsat .il-sw{width:18px;height:4px;display:inline-block;background:rgb(var(--wc));box-shadow:0 0 8px rgb(var(--wc)/.85)}
.rsat .il-workspace{position:relative;display:flex;flex-direction:column;min-height:0;flex:1}
.rsat .il-workspace.full .il-side{display:none}
.rsat .il-viewport{position:relative;overflow:hidden;cursor:grab;user-select:none;touch-action:none;flex:1;height:auto;min-height:420px;
  background-color:rgb(var(--c-rsat-il-bg));
  background-image:radial-gradient(circle,rgb(var(--c-rsat-il-grid)/.55) 1.25px,transparent 1.35px),linear-gradient(to right,rgb(var(--c-rsat-il-grid)/.14) 1px,transparent 1px),linear-gradient(to bottom,rgb(var(--c-rsat-il-grid)/.14) 1px,transparent 1px);
  background-size:24px 24px,120px 120px,120px 120px;box-shadow:var(--o3),var(--dn3)}
.rsat .il-viewport.panning{cursor:grabbing}
.rsat .il-world{position:relative;width:1900px;height:1120px;transform-origin:0 0;will-change:transform}
.rsat .il-mod-zone{border:2px dashed rgb(var(--c-rsat-il-grid)/.65);background:rgb(var(--c-rsat-slot)/.22);padding:8px 12px;pointer-events:none}
.rsat .il-mod-zone b{font:700 10.5px var(--f-px);letter-spacing:.09em;text-transform:uppercase;color:var(--muted);display:flex;align-items:center;gap:6px}
.rsat .il-wires{width:1900px;height:1120px;overflow:visible;pointer-events:none;display:block}
.rsat .il-wire-grp{pointer-events:stroke;cursor:pointer;transition:opacity .15s ease}
.rsat .il-wire-grp.dim{opacity:.14}
.rsat .il-wire-glow{fill:none;stroke:rgb(var(--wc));stroke-width:8;stroke-linecap:round;opacity:.26;filter:drop-shadow(0 0 6px rgb(var(--wc)))}
.rsat .il-wire-core{fill:none;stroke:rgb(var(--wc));stroke-width:2.6;stroke-linecap:round}
.rsat .il-wire-pulse{fill:none;stroke:rgb(var(--c-rsat-shine));stroke-width:2.2;stroke-linecap:round;stroke-dasharray:8 18;animation:ilflow 1.15s linear infinite;opacity:.88}
.rsat .il-wire-grp.hot .il-wire-glow{stroke-width:12;opacity:.55}
.rsat .il-wire-grp.hot .il-wire-core{stroke-width:3.5}
.rsat .il-wire-grp.broken .il-wire-core{stroke-dasharray:5 5;animation:blink .7s var(--step) infinite}
@keyframes ilflow{to{stroke-dashoffset:-52}}
/* Graphics quality tiers — kelas di root .rsat (il-q-verylow|low|medium|high).
   verylow: tanpa glow/animasi (flat, paling ringan). low: glow tipis tanpa filter.
   medium: glow normal, pulse hanya wire data-penting. high: semuanya penuh. */
.rsat.il-q-verylow .il-wire-glow{filter:none;opacity:.16}
.rsat.il-q-verylow .il-wire-pulse{display:none}
.rsat.il-q-verylow .il-node{box-shadow:var(--up2);transition:none}
.rsat.il-q-verylow .il-wire-grp{transition:none}
.rsat.il-q-verylow .il-wire-grp.broken .il-wire-core{animation:none}
.rsat.il-q-low .il-wire-glow{filter:none;opacity:.18;stroke-width:6}
.rsat.il-q-low .il-wire-grp.hot .il-wire-glow{stroke-width:9;opacity:.4}
.rsat.il-q-medium .il-wire-glow{stroke-width:6;opacity:.2}
.rsat.il-q-medium .il-wire-grp.hot .il-wire-glow{stroke-width:10;opacity:.45}
.rsat .il-node{width:248px;background:rgb(var(--c-rsat-il-node));box-shadow:var(--o3),var(--up2);color:rgb(var(--c-ink));cursor:grab;user-select:none;transition:opacity .15s ease,box-shadow .12s ease}
.rsat .il-node:active{cursor:grabbing}
.rsat .il-node.dim{opacity:.42}
.rsat .il-node.dim:hover{opacity:.85}
.rsat .il-node.sel{box-shadow:var(--o3a),0 0 18px rgb(var(--c-accent)/.45),var(--up2)}
.rsat .il-node.active-touch{box-shadow:0 -3px 0 0 rgb(var(--c-rsat-wire-active)),0 3px 0 0 rgb(var(--c-rsat-wire-active)),-3px 0 0 0 rgb(var(--c-rsat-wire-active)),3px 0 0 0 rgb(var(--c-rsat-wire-active)),0 0 16px rgb(var(--c-rsat-wire-active)/.45)}
.rsat .il-node.violation{box-shadow:0 -3px 0 0 rgb(var(--c-rsat-wire-broken)),0 3px 0 0 rgb(var(--c-rsat-wire-broken)),-3px 0 0 0 rgb(var(--c-rsat-wire-broken)),3px 0 0 0 rgb(var(--c-rsat-wire-broken)),0 0 16px rgb(var(--c-rsat-wire-broken)/.5)}
.rsat .il-nhead{display:flex;align-items:center;gap:6px;padding:6px 8px;background:rgb(var(--c-rsat-il-head));border-bottom:2px solid rgb(var(--c-rsat-edge));font:700 11px var(--f-px)}
.rsat .il-nhead .ndot{width:8px;height:8px;flex:none;background:rgb(var(--nc,var(--c-rsat-claimed)));box-shadow:0 0 6px rgb(var(--nc,var(--c-rsat-claimed)))}
.rsat .il-nmeta{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:4px 8px;background:rgb(var(--c-rsat-slot)/.65);border-bottom:1px solid rgb(var(--c-rsat-lo)/.5);font-size:10.5px}
.rsat .il-nbody{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:7px 0}
.rsat .il-col-in,.rsat .il-col-out{display:flex;flex-direction:column;gap:5px;min-width:0}
.rsat .il-col-out{align-items:flex-end;text-align:right}
.rsat .il-sock{display:inline-flex;align-items:center;gap:5px;font:600 10.5px var(--f-mono);padding:2px 6px;max-width:100%;cursor:pointer}
.rsat .il-sock:hover{background:rgb(var(--c-ink)/.08)}
.rsat .il-pin{width:10px;height:10px;flex:none;background:rgb(var(--pc,var(--c-rsat-wire-data)));border:2px solid rgb(var(--c-rsat-edge));box-shadow:0 0 6px rgb(var(--pc,var(--c-rsat-wire-data)))}
.rsat .il-nfoot{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:5px 8px;border-top:1px solid rgb(var(--c-rsat-lo)/.45);font-size:10px;color:var(--muted)}
/* Info strip mengambang kiri-atas: ringkasan seleksi saat inspector tersembunyi. */
.rsat .il-mini{position:absolute;top:10px;left:10px;z-index:20;display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding:3px 7px;max-width:min(46%,calc(100% - 400px));cursor:pointer;font-size:9.5px}
.rsat .il-mini .chip,.rsat .il-mini .layer-pill{font-size:8.5px;padding:1px 4px}
/* Inspector: panel MELAYANG di kanan-atas kanvas — tidak menyempitkan graph.
   Toggle dari bar; auto-muncul saat node/wire dipilih. padding-top untuk
   tombol X absolut di pojok kanan-atas panel. */
.rsat .il-side{position:absolute;top:10px;right:10px;width:380px;max-width:calc(100% - 20px);max-height:calc(100% - 20px);display:flex;flex-direction:column;gap:10px;padding:12px;overflow:auto;z-index:20;box-shadow:var(--o3),var(--up3)}
.rsat .il-side-x{position:absolute;top:6px;right:6px;z-index:2;min-width:22px}
.rsat .il-dsl{font:11.5px/1.5 var(--f-mono);padding:12px;background:rgb(var(--c-rsat-slot));box-shadow:var(--o2),var(--dn2);white-space:pre-wrap;overflow-x:auto;color:rgb(var(--c-ink));max-height:480px;overflow-y:auto}
/* ── PRD Guided Workbench (.prdw-*) ─────────────────────────────────────── */
.rsat .prdw{width:100%;max-width:1080px;margin:0 auto;display:flex;flex-direction:column;background:rgb(var(--c-rsat-face));box-shadow:var(--o3),var(--up3)}
.rsat .prdw-top{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:3px solid rgb(var(--c-rsat-edge))}
.rsat .prdw-brand{display:flex;gap:10px;align-items:center;min-width:0}
.rsat .prdw-seal{width:40px;height:40px;flex:none;background:rgb(var(--c-rsat-slot));box-shadow:var(--o2),var(--dn2);display:flex;align-items:center;justify-content:center;font:500 11px var(--f-px);letter-spacing:.06em}
.rsat .prdw-title{font:500 15px var(--f-px);letter-spacing:.04em}
.rsat .prdw-meta{font:11px var(--f-mono);color:rgb(var(--c-ink)/.65);display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:2px}
.rsat .prdw-meta b{color:rgb(var(--c-rsat-gold));font-weight:500}
.rsat .prdw-stamp{font:500 10.5px var(--f-px);color:rgb(var(--c-danger));border:2px solid rgb(var(--c-danger));padding:0 7px;letter-spacing:.1em;text-transform:uppercase}
.rsat .prdw-body{display:grid;grid-template-columns:200px minmax(0,1fr)}
.rsat .prdw-rail{background:rgb(var(--c-rsat-slot));border-right:3px solid rgb(var(--c-rsat-edge));padding:12px 8px;display:flex;flex-direction:column;gap:0}
.rsat .prdw-rail-h{font:500 11px var(--f-px);letter-spacing:.12em;text-transform:uppercase;color:rgb(var(--c-ink)/.65);padding:0 4px 8px}
.rsat .prdw-si{width:calc(100% - 4px);justify-content:flex-start;text-align:left;padding:6px 8px;margin:3px 2px;display:flex;align-items:center;gap:8px;font:600 10.5px var(--f-px);letter-spacing:.02em;border:0;cursor:pointer;background:rgb(var(--c-rsat-face));box-shadow:var(--o2);color:rgb(var(--c-ink)/.8);text-transform:none}
.rsat .prdw-si.on{box-shadow:var(--o2),var(--dn2);color:rgb(var(--c-accent-ink));background:rgb(var(--c-accent))}
.rsat .prdw-dot{width:10px;height:10px;flex:none;background:rgb(var(--c-rsat-slot));box-shadow:inset 0 0 0 2px rgb(var(--c-rsat-lo))}
.rsat .prdw-dot.p{box-shadow:inset 0 0 0 2px rgb(var(--c-rsat-gold));background:rgb(var(--c-rsat-gold)/.5)}
.rsat .prdw-dot.d{background:rgb(22 163 74);box-shadow:none}
.rsat .prdw-si.on .prdw-dot{box-shadow:inset 0 0 0 2px rgb(var(--c-accent-ink))}
.rsat .prdw-si.on .prdw-dot.p{background:rgb(var(--c-accent-ink)/.5)}
.rsat .prdw-prog{margin-top:12px;padding:10px;font:600 10px var(--f-px);letter-spacing:.08em;text-transform:uppercase;color:rgb(var(--c-ink)/.6);box-shadow:var(--o2);background:rgb(var(--c-rsat-face))}
.rsat .prdw-bar{height:8px;margin-top:6px;box-shadow:var(--o2),var(--dn2);background:rgb(var(--c-rsat-slot));padding:2px}
.rsat .prdw-bar i{display:block;height:4px;background:rgb(var(--c-rsat-gold))}
.rsat .prdw-main{padding:14px 16px;min-width:0}
.rsat .prdw-step{font:600 10.5px var(--f-px);letter-spacing:.14em;text-transform:uppercase;color:rgb(var(--c-ink)/.55)}
.rsat .prdw-sh{display:flex;align-items:center;gap:10px;margin:6px 0 10px;flex-wrap:wrap}
.rsat .prdw-no{background:rgb(var(--c-rsat-edge));color:rgb(var(--c-rsat-face));padding:2px 9px;font:700 11px var(--f-px)}
.rsat .prdw-stt{font:500 14px var(--f-px)}
.rsat .prdw-why{display:flex;gap:10px;align-items:flex-start;padding:10px;margin-bottom:12px;background:rgb(var(--c-rsat-slot));box-shadow:var(--o2),var(--dn2)}
.rsat .prdw-why .i{flex:none;margin-top:1px}
.rsat .prdw-why .grow{flex:1;font:12px var(--f-body);line-height:1.5;color:rgb(var(--c-ink)/.8)}
.rsat .prdw-lb{display:block;font:700 10px var(--f-px);letter-spacing:.1em;text-transform:uppercase;color:rgb(var(--c-ink)/.6);margin:12px 0 4px}
.rsat .prdw-hint{font:11px var(--f-mono);color:rgb(var(--c-ink)/.5);margin-top:5px}
.rsat .prdw-row{display:flex;align-items:center;gap:6px;margin-bottom:6px}
.rsat .prdw-row .field{flex:1;min-width:0}
.rsat .prdw-idx{width:22px;flex:none;text-align:center;font:700 10px var(--f-px);color:rgb(var(--c-ink)/.5);box-shadow:inset 0 0 0 2px rgb(var(--c-rsat-lo));padding:4px 0;background:rgb(var(--c-rsat-slot))}
.rsat .prdw-pair{flex:1;display:grid;grid-template-columns:1fr 1fr;gap:6px;min-width:0}
.rsat .prdw-ph{display:grid;grid-template-columns:22px 1fr 1fr 34px;gap:6px;margin-bottom:4px;font:700 9.5px var(--f-px);letter-spacing:.08em;text-transform:uppercase;color:rgb(var(--c-ink)/.55)}
.rsat .prdw-ph .h2{color:rgb(var(--c-rsat-gold))}
.rsat .prdw-mod{padding:10px;margin-bottom:10px;background:rgb(var(--c-rsat-slot));box-shadow:var(--o2),var(--dn2)}
.rsat .prdw-mid{flex:none;background:rgb(var(--c-rsat-edge));color:rgb(var(--c-rsat-face));padding:3px 8px;font:700 10px var(--f-px)}
.rsat .prdw-sel{flex:none;width:150px}
.rsat .prdw-lkl{font:700 9.5px var(--f-px);letter-spacing:.12em;text-transform:uppercase;color:rgb(var(--c-ink)/.55);margin:10px 0 5px}
.rsat .prdw-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.rsat .prdw-chips .chip{cursor:pointer}
.rsat .prdw-chips .chip[aria-pressed=true]{background:rgb(var(--c-accent));color:rgb(var(--c-accent-ink));box-shadow:var(--o2),inset 0 0 0 2px rgb(var(--c-accent-ink))}
.rsat .prdw-seg{display:flex;gap:4px;flex:none}
.rsat .prdw-sev{cursor:pointer}
.rsat .prdw-sev[aria-pressed=true]{background:rgb(var(--c-accent));color:rgb(var(--c-accent-ink));box-shadow:var(--o2),inset 0 0 0 2px rgb(var(--c-accent-ink))}
.rsat .prdw-sev.high[aria-pressed=true]{background:rgb(220 38 38);color:#fff}
.rsat .prdw-sev.medium[aria-pressed=true]{background:rgb(var(--c-rsat-gold));color:rgb(var(--c-rsat-edge))}
.rsat .prdw-sev.low[aria-pressed=true]{background:rgb(22 163 74);color:#fff}
.rsat .prdw-mx{border:2px solid rgb(var(--c-rsat-edge));background:rgb(var(--c-rsat-slot));box-shadow:var(--dn2)}
.rsat .prdw-mxr{display:grid;grid-template-columns:170px 1fr;border-bottom:2px dotted rgb(var(--c-rsat-lo));font:11.5px var(--f-mono)}
.rsat .prdw-mxr:last-child{border-bottom:0}
.rsat .prdw-mxr .nm{padding:7px 10px;font:700 10px var(--f-px);text-transform:uppercase;letter-spacing:.02em;border-right:2px dotted rgb(var(--c-rsat-lo));color:rgb(var(--c-rsat-gold))}
.rsat .prdw-mxr .im{padding:7px 10px;display:flex;align-items:center;gap:8px;color:rgb(var(--c-ink)/.7);flex-wrap:wrap}
.rsat .prdw-lay{font:700 9px var(--f-px);letter-spacing:.06em;text-transform:uppercase;padding:1px 6px;box-shadow:var(--o2);background:rgb(var(--c-rsat-face))}
.rsat .prdw-lay.domain{background:rgb(22 163 74/.16);color:rgb(22 163 74)}
.rsat .prdw-lay.presentation{background:rgb(190 138 12/.16);color:rgb(var(--c-rsat-gold))}
.rsat .prdw-lay.application{background:rgb(2 132 199/.16);color:rgb(2 132 199)}
.rsat .prdw-lay.infrastructure{background:rgb(140 146 158/.2);color:rgb(var(--c-ink)/.65)}
.rsat .prdw-lay.shared{background:rgb(124 58 237/.16);color:rgb(124 58 237)}
.rsat .prdw-nav{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:16px;padding-top:12px;border-top:2px dotted rgb(var(--c-rsat-lo))}
.rsat .prdw-doc{font:12.5px/1.6 var(--f-body);padding:4px 2px;width:100%}
.rsat .prdw-doc h3{display:flex;align-items:center;gap:8px;margin:18px 0 6px;font:700 11px var(--f-px);letter-spacing:.12em;text-transform:uppercase;border-bottom:2px dotted rgb(var(--c-rsat-lo));padding-bottom:5px}
.rsat .prdw-doc h3:first-child{margin-top:0}
.rsat .prdw-doc h3 .no{background:rgb(var(--c-rsat-edge));color:rgb(var(--c-rsat-face));padding:1px 7px}
.rsat .prdw-doc h3 .ed{margin-left:auto}
.rsat .prdw-doc ul{margin:6px 0;padding-left:20px}
.rsat .prdw-doc p{margin:6px 0}
.rsat .prdw-raw{font:11.5px/1.55 var(--f-mono);white-space:pre-wrap;background:rgb(var(--c-rsat-slot));box-shadow:var(--o2),var(--dn2);padding:10px;max-height:300px;overflow:auto;margin-top:8px}
.rsat .prdw-warn{margin:12px 14px 0;padding:10px;background:rgb(var(--c-danger)/.1);box-shadow:var(--o2),var(--dn2);font:12px var(--f-body)}
.rsat .prdw-warn .chip{cursor:pointer;margin-right:4px}
.rsat .prdw-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 14px;border-top:3px solid rgb(var(--c-rsat-edge));flex-wrap:wrap}
.rsat .prdw-auto{font:10.5px var(--f-mono);color:rgb(var(--c-ink)/.5)}
.rsat .grp{display:flex;gap:4px;flex-wrap:wrap;align-items:center}
@media(max-width:760px){.rsat .prdw-body{grid-template-columns:1fr}.rsat .prdw-rail{flex-direction:row;flex-wrap:wrap;border-right:0;border-bottom:3px solid rgb(var(--c-rsat-edge))}
  .rsat .prdw-si{width:auto}.rsat .prdw-prog{display:none}.rsat .prdw-pair{grid-template-columns:1fr}.rsat .prdw-ph{display:none}}
@media(max-width:960px){.rsat .il-side{width:min(300px,calc(100% - 20px))}}
@media(max-width:760px){.rsat .two{grid-template-columns:minmax(0,1fr)}.rsat .hero{grid-template-columns:auto 1fr}.rsat .hero .acts{grid-column:1/-1}}
@media(prefers-reduced-motion:reduce){.rsat *,.rsat *::before,.rsat *::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
`;
