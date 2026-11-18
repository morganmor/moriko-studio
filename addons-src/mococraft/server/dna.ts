

export interface DesignDna {
  id: string;
  name: string;
  tagline: string;
  displayFont: string;
  bodyFont: string;
  
  palette: Record<string, string>;
  macrostructures: string[];
  antiTells: string[];
}

export const DNA_LIB: DesignDna[] = [
  {
    id: 'editorial',
    name: 'Editorial Specimen',
    tagline: 'Serif display, hairlines, dense typographic rhythm.',
    displayFont: '"Fraunces", "Playfair Display", serif',
    bodyFont: '"Newsreader", "Source Serif 4", serif',
    palette: {
      '--moco-canvas': 'oklch(97.5% 0.008 85)',
      '--moco-ink': 'oklch(24% 0.02 60)',
      '--moco-accent': 'oklch(52% 0.16 40)',
      '--moco-hairline': 'oklch(87% 0.01 85)',
      '--moco-muted': 'oklch(48% 0.02 60)',
    },
    macrostructures: ['Type Specimen', 'Long Document', 'Manifesto'],
    antiTells: ['No purple gradients', 'No full-viewport centered hero', 'Tinted neutrals only'],
  },
  {
    id: 'workbench',
    name: 'Industrial Workbench',
    tagline: 'Dense grid, tabular numbers, status pills, zero rounded corners.',
    displayFont: '"IBM Plex Sans", sans-serif',
    bodyFont: '"IBM Plex Mono", monospace',
    palette: {
      '--moco-canvas': 'oklch(96% 0.004 250)',
      '--moco-ink': 'oklch(22% 0.01 250)',
      '--moco-accent': 'oklch(58% 0.18 150)',
      '--moco-hairline': 'oklch(84% 0.008 250)',
      '--moco-muted': 'oklch(46% 0.015 250)',
    },
    macrostructures: ['Workbench', 'Spec Sheet', 'Index First'],
    antiTells: ['No icon tiles above headings', 'Tabular-nums for all metrics', 'Hairline tables, not cards'],
  },
  {
    id: 'brutalist',
    name: 'Brutalist Slab',
    tagline: 'Hard borders, high contrast, asymmetric pop accents.',
    displayFont: '"Archivo Black", "Space Grotesk", sans-serif',
    bodyFont: '"Space Grotesk", sans-serif',
    palette: {
      '--moco-canvas': 'oklch(95% 0.02 95)',
      '--moco-ink': 'oklch(18% 0.01 95)',
      '--moco-accent': 'oklch(62% 0.24 25)',
      '--moco-hairline': 'oklch(20% 0.01 95)',
      '--moco-muted': 'oklch(44% 0.02 95)',
    },
    macrostructures: ['Split Diptych', 'Marquee Hero', 'Catalogue'],
    antiTells: ['2-3px solid borders, not shadows', 'Asymmetry over centered symmetry', 'No glassmorphism'],
  },
  {
    id: 'atmospheric',
    name: 'Atmospheric Dark',
    tagline: 'Elevation by lightness, subtle grain, quiet elegance.',
    displayFont: '"Cormorant Garamond", serif',
    bodyFont: '"Outfit", sans-serif',
    palette: {
      '--moco-canvas': 'oklch(16% 0.012 270)',
      '--moco-ink': 'oklch(90% 0.01 270)',
      '--moco-accent': 'oklch(75% 0.12 200)',
      '--moco-hairline': 'oklch(28% 0.015 270)',
      '--moco-muted': 'oklch(62% 0.015 270)',
    },
    macrostructures: ['Photographic', 'Statement', 'Quote-Led'],
    antiTells: ['Elevation via lightness steps, not box-shadows', 'No glow orbs', 'No gradient text'],
  },
];

export function dnaById(id: string): DesignDna | undefined {
  return DNA_LIB.find((d) => d.id === id);
}
