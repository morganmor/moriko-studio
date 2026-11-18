

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_URL = 'https://models.dev/api.json';
const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../server/modelMetadata.snapshot.json',
);

const response = await fetch(API_URL);
if (!response.ok) {
  console.error(`models.dev returned HTTP ${response.status}`);
  process.exit(1);
}

const catalog = await response.json();



const hasModality = (arr, modality) => Array.isArray(arr) && arr.includes(modality);


const out = {};
let count = 0;

for (const [providerId, provider] of Object.entries(catalog)) {
  for (const [modelId, model] of Object.entries(provider.models ?? {})) {
    const options = model.reasoning_options ?? [];
    const efforts = options.find((option) => option.type === 'effort')?.values ?? null;
    out[`${providerId}/${modelId}`] = {
      name: model.name ?? null,
      reasoning: Boolean(model.reasoning),
      efforts,
      tools: Boolean(model.tool_call),
      attachment: Boolean(model.attachment),
      imageIn: hasModality(model.modalities?.input, 'image'),
      videoIn: hasModality(model.modalities?.input, 'video'),
      audioIn: hasModality(model.modalities?.input, 'audio'),
      pdfIn: hasModality(model.modalities?.input, 'pdf'),
      imageOut: hasModality(model.modalities?.output, 'image'),
      context: model.limit?.context ?? null,
      maxOut: model.limit?.output ?? null,
    };
    count += 1;
  }
}

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(out)}\n`, 'utf8');
console.log(`Wrote ${count} models from ${Object.keys(catalog).length} providers → ${OUT}`);
