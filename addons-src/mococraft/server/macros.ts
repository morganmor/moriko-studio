

export const MACROSTRUCTURES: Array<{ id: string; name: string; sketch: string; css: string }> = [
  {
    id: 'split-diptych',
    name: 'Split Diptych',
    sketch: 'Left: massive typographic block. Right: live interface / artifact. No equal halves.',
    css: `display: grid; grid-template-columns: 7fr 5fr; gap: 0; min-height: 100%;`,
  },
  {
    id: 'sticky-rail',
    name: 'Sticky Pinned Left-Rail',
    sketch: 'Metadata/nav column sticks left while content scrolls right.',
    css: `display: grid; grid-template-columns: 300px 1fr; align-items: start;
.rail { position: sticky; top: 0; height: 100vh; overflow-y: auto; }`,
  },
  {
    id: 'hanging-headers',
    name: 'Hanging Headers',
    sketch: 'Section titles hang outside the reading column margin.',
    css: `.section { display: grid; grid-template-columns: 180px minmax(0, 64ch); }
.section > h2 { grid-column: 1; text-align: right; padding-right: 24px; }`,
  },
  {
    id: 'spec-sheet',
    name: 'Tabular Spec Sheet',
    sketch: 'Replace feature cards with a hairline table, tabular-nums, no icon tiles.',
    css: `table.spec { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
table.spec td { border-bottom: 1px solid var(--moco-hairline); padding: 10px 8px; }`,
  },
  {
    id: 'stat-strip',
    name: 'Numbered Stat Strip',
    sketch: 'One horizontal strip of oversized numbers with hanging labels — no cards.',
    css: `.strip { display: flex; gap: 48px; align-items: baseline; overflow-x: auto; }
.stat b { font-size: clamp(2.5rem, 6vw, 4.5rem); font-variant-numeric: tabular-nums; }`,
  },
  {
    id: 'asymmetric-bento',
    name: 'Asymmetric Bento (varied spans)',
    sketch: 'Bento grid but deliberately unequal: 2+1 rows, one tall cell, one wide cell.',
    css: `display: grid; grid-template-columns: repeat(4, 1fr); grid-auto-rows: 120px; gap: 12px;
.cell-a { grid-column: span 2; grid-row: span 2; }
.cell-b { grid-column: span 1; }
.cell-c { grid-column: span 4; }`,
  },
];

export function macroById(id: string) {
  return MACROSTRUCTURES.find((m) => m.id === id);
}
