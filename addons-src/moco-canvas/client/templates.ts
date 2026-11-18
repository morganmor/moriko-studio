

import { BREAKPOINTS, dnaOf, type Scene, type SceneNode } from './scene.ts';

export interface TemplateDef {
  id: string;
  name: string;
  hint: string;
  build: (id: string, dna: string) => SceneNode;
}

function page(children: SceneNode[]): SceneNode {
  return { id: 'page', kind: 'page', layout: { mode: 'stack', dir: 'col', gap: '$s1' }, children };
}

const heroCopy: SceneNode = {
  id: 'hero.copy',
  kind: 'frame',
  at: 'A1:G6',
  layout: { mode: 'stack', dir: 'col', gap: '$s5', align: 'start' },
  children: [
    { id: 'hero.kicker', kind: 'text', role: 'caption', text: 'Edition 03 — field archive' },
    { id: 'hero.title', kind: 'text', role: 'display', text: 'The city voice archive' },
    {
      id: 'hero.lead',
      kind: 'text',
      role: 'body',
      maxWidth: '52ch',
      text: 'Field recordings from 40 traditional markets, curated by the hour and stored as local files.',
    },
    { id: 'hero.cta', kind: 'shape', text: 'Browse the archive' },
  ],
};

const statStrip: SceneNode = {
  id: 'strip',
  kind: 'frame',
  layout: { mode: 'grid', cols: 12, rows: 2, gap: '$s5', pad: '$s8' },
  children: [
    { id: 'strip.a', kind: 'text', at: 'A1:C2', role: 'heading', text: '1,284 hours' },
    { id: 'strip.b', kind: 'text', at: 'D1:G2', role: 'heading', text: '40 markets' },
    { id: 'strip.c', kind: 'text', at: 'H1:L2', role: 'heading', text: '12 cities' },
  ],
};

export const TEMPLATES: TemplateDef[] = [
  {
    id: 'split-diptych',
    name: 'Split Diptych',
    hint: '7/5 hero: copy column left, image right. The asymmetric default.',
    build: () =>
      page([
        {
          id: 'hero',
          kind: 'frame',
          layout: { mode: 'grid', cols: 12, rows: 6, gap: '$s6', pad: '$s10' },
          children: [heroCopy, { id: 'hero.img', kind: 'image', at: 'H1:L6', ratio: '4/5', fit: 'cover' }],
        },
        statStrip,
      ]),
  },
  {
    id: 'spec-sheet',
    name: 'Spec Sheet',
    hint: 'Dense spec page: numbered rows, no hero image.',
    build: () =>
      page([
        {
          id: 'spec',
          kind: 'frame',
          layout: { mode: 'grid', cols: 12, rows: 8, gap: '$s5', pad: '$s10' },
          children: [
            {
              id: 'spec.head',
              kind: 'frame',
              at: 'A1:F4',
              layout: { mode: 'stack', dir: 'col', gap: '$s4', align: 'start' },
              children: [
                { id: 'spec.kicker', kind: 'text', role: 'caption', text: 'Specification sheet' },
                { id: 'spec.title', kind: 'text', role: 'display', text: 'L-40 field recorder' },
                { id: 'spec.body', kind: 'text', role: 'body', maxWidth: '60ch', text: 'Two channels, an 18-hour battery, and an aluminium body without a screen.' },
              ],
            },
            { id: 'spec.img', kind: 'image', at: 'H1:L8', ratio: '3/4', fit: 'cover' },
            {
              id: 'spec.rows',
              kind: 'frame',
              at: 'A5:F8',
              layout: { mode: 'stack', dir: 'col', gap: '$s3' },
              children: [
                { id: 'spec.r1', kind: 'text', role: 'mono', text: '01 · 2 channels · 24 bit' },
                { id: 'spec.r2', kind: 'text', role: 'mono', text: '02 · 18-hour battery' },
                { id: 'spec.r3', kind: 'text', role: 'mono', text: '03 · 412 g weight' },
              ],
            },
          ],
        },
        statStrip,
      ]),
  },
  {
    id: 'stack-list',
    name: 'Stack List',
    hint: 'Single-column reading layout for lists and changelogs.',
    build: () =>
      page([
        {
          id: 'list',
          kind: 'frame',
          layout: { mode: 'stack', dir: 'col', gap: '$s5', pad: '$s10', align: 'start' },
          children: [
            { id: 'list.kicker', kind: 'text', role: 'caption', text: 'Release notes' },
            { id: 'list.title', kind: 'text', role: 'display', text: 'What changed in edition 03' },
            { id: 'list.lead', kind: 'text', role: 'body', maxWidth: '62ch', text: 'Six new recordings, a lighter player, and an archive that reads offline.' },
            { id: 'list.item1', kind: 'text', role: 'heading', text: 'A lighter player' },
            { id: 'list.item2', kind: 'text', role: 'heading', text: 'The offline archive' },
          ],
        },
      ]),
  },
  {
    id: 'blank',
    name: 'Blank grid',
    hint: 'One empty 12×6 grid frame — the smallest legal start.',
    build: () =>
      page([{ id: 'main', kind: 'frame', layout: { mode: 'grid', cols: 12, rows: 6, gap: '$s6', pad: '$s8' }, children: [] }]),
  },
];

export function templateById(id: string): TemplateDef | null {
  return TEMPLATES.find((t) => t.id === id) ?? null;
}

export const DEFAULT_TEMPLATE = 'split-diptych';


export function buildScene(docId: string, templateId = DEFAULT_TEMPLATE, dna = 'editorial'): Scene {
  const template = templateById(templateId) ?? templateById(DEFAULT_TEMPLATE)!;
  const dnaDef = dnaOf(dna);
  return {
    version: 1,
    id: docId,
    dna,
    rev: 1,
    template: template.id,
    breakpoints: { ...BREAKPOINTS },
    tokens: { ...dnaDef.tokens },
    fonts: { ...dnaDef.fonts },
    root: template.build(docId, dna),
  };
}
