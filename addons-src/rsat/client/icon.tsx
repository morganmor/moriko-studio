/**
 * RSA/T icon system — registry TERPUSAT (satu komponen Ic untuk semua panel).
 * Aturan utama: setiap <svg> WAJIB punya viewBox="0 0 24 24" → path 24-unit
 * tidak pernah terpotong pada ukuran CSS apa pun.
 * Mekanisme ukur dinamis (lihat RSAT_CSS): default mengikuti desain
 * (.i = 18px, .i.sm = 14px), tetapi DI DALAM kontrol (btn/chip/tab/slot/
 * icon-btn) ikon memakai unit em → otomatis mengikuti ukuran/font tombol.
 * Ikon baru: tambahkan path di sini saja — tidak perlu komponen lokal lagi.
 */

const ICONS: Record<string, string> = {
  play: 'M8 5l11 7-11 7z',
  pause: 'M8 5v14M16 5v14',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  upload: 'M12 16V5M7 9l5-5 5 5M5 20h14',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  plus: 'M12 5v14M5 12h14',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  'file-plus': 'M7 3h7l5 5v13H7zM14 3v5h5M12 12v5M9.5 14.5h5',
  'file-edit': 'M7 3h7l5 5v13H7zM14 3v5h5M9 17l5-5 1.5 1.5-5 5H9z',
  'file-minus': 'M7 3h7l5 5v13H7zM14 3v5h5M9.5 14.5h5',
  check: 'M5 12.5l4.5 4.5L19 7',
  send: 'M4 12l16-8-6 16-3-7z',
  refactor: 'M4 12a8 8 0 0 1 13.7-5.6L20 8M20 4v4h-4M20 12a8 8 0 0 1-13.7 5.6L4 16M4 20v-4h4',
  rename: 'M5 12h14M14 7l5 5-5 5',
  trash: 'M4 7h16M9 7V5h6v2M6 7l1 12h10l1-12',
  x: 'M6 6l12 12M18 6L6 18',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  shield: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  trophy: 'M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3',
  tree: 'M12 3v6M12 9H5v6M12 9h7v6M5 15v6M19 15v6M3 21h4M17 21h4',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  bell: 'M6 16a5 5 0 0 1-1-3c0-3 2-5 3-6V6a4 4 0 0 1 8 0v1c1 1 3 3 3 6a5 5 0 0 1-1 3M8 16h8M10 21a2 2 0 0 0 3 0',
  plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4',
  panel: 'M4 5h16v14H4zM9 5v14',
  'panel-l': 'M4 5h16v14H4zM4 5v14M9 5v14',
  'chev-l': 'M15 18l-6-6 6-6',
  'chev-r': 'M9 6l6 6-6 6',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z',
  wand: 'M5 19L17 7M14 4l1.2 2.8L18 8l-2.8 1.2L14 12l-1.2-2.8L10 8l2.8-1.2zM19 13l.8 1.7 1.7.8-1.7.8L19 18l-.8-1.7-1.7-.8 1.7-.8z',
  lock: 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3',
  unlock: 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 5.8-1',
  copy: 'M9 3h9v13H9zM6 7v14h11',
  image: 'M4 5h16v14H4zM8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM6 17l5-5 3 3 2.5-2.5L18 15',
  minus: 'M5 12h14',
  fit: 'M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
  nodes: 'M4 5h5v5H4zM15 4h5v5h-5zM15 15h5v5h-5zM9 7.5h6M9 7.5c3 0 3 10 6 10',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  code: 'M8 8l-4 4 4 4M16 8l4 4-4 4M13 6l-2 12',
  layers: 'M12 3l9 4.5-9 4.5-9-4.5zM3 12l9 4.5 9-4.5M3 16.5l9 4.5 9-4.5',
};

export function Ic({ name, sm }: { name: string; sm?: boolean }) {
  return (
    <svg className={sm ? 'i sm' : 'i'} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={ICONS[name]} />
    </svg>
  );
}
