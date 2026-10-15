/**
 * RSA/T sprite renderer — port dari SPR desain (run-length rect per baris, cached).
 * .spr .a memakai --sa (warna per pemakaian); .k/.g/.h/.b/.c/.w dari CSS RSAT_CSS.
 */
import type { CSSProperties } from 'react';

const SPR: Record<string, string[]> = {
  ore: ['kkkkkkkk', 'kgggghgk', 'kgaaggak', 'kgacgggk', 'khggaagk', 'kggacahk', 'khgggghk', 'kkkkkkkk'],
  gem: ['..kkkk..', '.kccaak.', 'kccaaabk', 'kcaaaabk', '.kaaabk.', '..kabk..', '...kk...'],
  lock: ['..kkkk..', '.kg..gk.', '.kg..gk.', 'kkkkkkkk', 'kaaaaaak', 'kaaakaak', 'kaaakaak', 'kkkkkkkk'],
  check: ['......aa', '.....aa.', 'aa..aa..', '.aaaa...', '..aa....'],
  heart: ['.wa.aa.', 'aaaaaaa', 'aaaaaaa', '.aaaaa.', '..aaa..', '...a...'],
  creeper: ['abaaabaa', 'aaabaaba', 'akkaakka', 'akkaakka', 'aaakkaaa', 'aakkkkaa', 'aakkkkaa', 'aakaakaa'],
  steve: ['yyyyyyyy', 'yyyyyyyy', 'yssssssy', 'swkssksw', 'ssssssss', 'sssmmsss', 'ssssssss', 'ssssssss'],
};

type Rect = { cls: string; x: number; y: number; w: number };
const CACHE: Record<string, Rect[]> = {};

function rects(name: string): Rect[] {
  if (!CACHE[name]) {
    const out: Rect[] = [];
    SPR[name].forEach((row, y) => {
      let x = 0;
      while (x < row.length) {
        const ch = row[x];
        if (ch === '.') { x += 1; continue; }
        let e = x;
        while (e < row.length && row[e] === ch) e += 1;
        out.push({ cls: ch, x, y, w: e - x });
        x = e;
      }
    });
    CACHE[name] = out;
  }
  return CACHE[name];
}

export function Spr({ name, style, cls }: { name: string; style?: CSSProperties; cls?: string }) {
  const rows = SPR[name];
  return (
    <svg
      className={cls ? `spr ${cls}` : 'spr'}
      style={style}
      aria-hidden="true"
      viewBox={`0 0 ${rows[0].length} ${rows.length}`}
    >
      {rects(name).map((r, i) => (
        <rect key={i} className={r.cls} x={r.x} y={r.y} width={r.w} height={1} />
      ))}
    </svg>
  );
}

/** Style helper: set --sa pada sprite. */
export function sa(value: string): CSSProperties {
  return { '--sa': value } as CSSProperties;
}
