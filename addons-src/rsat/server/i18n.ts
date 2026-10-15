/**
 * RSA/T i18n (P0a) — English + Bahasa Indonesia. The default is English and
 * the board stays behind a LangGate until the user explicitly picks
 * (settings.language), matching the privacy/localization rule.
 */

const BUNDLES = {
  en: {
    gateTitle: 'Choose the board language',
    gateBody: 'RSA/T stays closed until you pick. This choice is saved as explicit consent (never inferred).',
    gateEn: 'English',
    gateId: 'Bahasa Indonesia',
    board: 'Board',
    overview: 'Overview',
    activity: 'Live activity',
    files: 'Files',
    settings: 'Settings',
    noPrd: 'No PRD yet',
    noPrdBody: 'Ask an agent in chat to draft one with the rsat_prd tool, or import a previous export.',
    start: 'Start',
    pause: 'Pause',
    started: 'running',
    score: 'Score',
    claim: 'Claim',
    claimed: 'claimed',
    available: 'available',
    locked: 'locked',
    inProgress: 'in progress',
    review: 'review',
    done: 'done',
    dropped: 'dropped',
    blocked: 'blocked',
    holder: 'held by',
    acceptance: 'Acceptance',
    scope: 'Scope',
    comments: 'Comments',
    accept: 'Accept',
    reject: 'Reject',
    release: 'Release',
    restore: 'Restore',
    delete: 'Delete',
    export: 'Export',
    import: 'Import',
    presence: 'Agents online',
    nobody: 'Nobody online',
    tier: { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', diamond: 'Diamond' },
    langGate: 'Language',
    guard: 'Guard',
    guardAdvisory: 'advisory — out-of-scope edits pass with a note',
    guardStrict: 'strict — out-of-scope edits by claim holders are denied',
    deleteConfirm: 'Delete this achievement permanently? This cannot be undone.',
    reviewReason: 'Why the review is rejected:',
    toast: {
      claimed: '{id} claimed by {who}',
      completed: '{id} complete! +{points} pts',
      released: '{id} released',
    },
  },
  id: {
    gateTitle: 'Pilih bahasa papan',
    gateBody: 'RSA/T tetap tertutup sampai kamu memilih. Pilihan ini disimpan sebagai persetujuan eksplisit (tidak pernah ditebak).',
    gateEn: 'English',
    gateId: 'Bahasa Indonesia',
    board: 'Papan',
    overview: 'Ringkasan',
    activity: 'Aktivitas live',
    files: 'Berkas',
    settings: 'Pengaturan',
    noPrd: 'Belum ada PRD',
    noPrdBody: 'Minta agent di chat menyusunnya dengan tool rsat_prd, atau impor hasil export sebelumnya.',
    start: 'Mulai',
    pause: 'Jeda',
    started: 'berjalan',
    score: 'Skor',
    claim: 'Klaim',
    claimed: 'diklaim',
    available: 'tersedia',
    locked: 'terkunci',
    inProgress: 'sedang dikerjakan',
    review: 'review',
    done: 'selesai',
    dropped: 'dibatalkan',
    blocked: 'terblokir',
    holder: 'dipegang',
    acceptance: 'Kriteria',
    scope: 'Scope',
    comments: 'Komentar',
    accept: 'Terima',
    reject: 'Tolak',
    release: 'Lepas',
    restore: 'Pulihkan',
    delete: 'Hapus',
    export: 'Export',
    import: 'Impor',
    presence: 'Agent online',
    nobody: 'Tidak ada agent online',
    tier: { bronze: 'Perunggu', silver: 'Perak', gold: 'Emas', diamond: 'Berlian' },
    langGate: 'Bahasa',
    guard: 'Penjaga',
    guardAdvisory: 'advisory — edit di luar scope lolos dengan catatan',
    guardStrict: 'strict — edit di luar scope oleh pemegang klaim ditolak',
    deleteConfirm: 'Hapus achievement ini permanen? Tidak bisa dibatalkan.',
    reviewReason: 'Alasan penolakan review:',
    toast: {
      claimed: '{id} diklaim oleh {who}',
      completed: '{id} selesai! +{points} poin',
      released: '{id} dilepas',
    },
  },
};

export function bundle(lang) {
  return BUNDLES[lang === 'id' ? 'id' : 'en'];
}

/** t(bundle, 'toast.claimed', { id: 'A-001', who: 'Agent A' }) */
export function t(b, key, vars) {
  let out = key.split('.').reduce((node, part) => (node && node[part] !== undefined ? node[part] : null), b);
  if (typeof out !== 'string') return key;
  if (vars) for (const [name, value] of Object.entries(vars)) out = out.replaceAll(`{${name}}`, String(value));
  return out;
}
