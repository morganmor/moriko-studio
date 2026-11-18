

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../server/diffusionMetadata.snapshot.json',
);

const QUERIES = [
  ['text-to-image', 't2i'],
  ['image-to-image', 'edit'],
  ['inpainting', 'inpaint'],
];


const out = {};
let count = 0;

for (const [pipelineTag, tag] of QUERIES) {
  const url =
    'https://huggingface.co/api/models?pipeline_tag=' + pipelineTag +
    '&library=diffusers&sort=downloads&limit=300';
  const response = await fetch(url, { headers: { 'User-Agent': 'moriko-studio-sync' } });
  if (!response.ok) {
    console.error(`HF Hub returned HTTP ${response.status} for ${pipelineTag}`);
    process.exit(1);
  }
  
  const models = await response.json();
  for (const model of models) {
    if (!model.id) continue;
    out[model.id.toLowerCase()] = { tag };
    count += 1;
  }
}

await writeFile(OUT, `${JSON.stringify(out)}\n`, 'utf8');
console.log(`Wrote ${count} diffusion models → ${OUT}`);
