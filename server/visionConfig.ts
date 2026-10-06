/**
 * Vision tool configuration store.
 *
 * One row: which PROVIDER + multimodal MODEL answers `agent__vision` calls.
 * Kept in `~/.moriko/vision.json` (see paths.ts) so a restart keeps it, and
 * the UI panel saves/loads through /api/vision/config.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { visionFile } from './paths.js';

export interface VisionConfig {
  providerId: string;
  model: string;
  baseUrl?: string;
}

const EMPTY: VisionConfig = { providerId: '', model: '' };

export async function getVisionConfig(): Promise<VisionConfig> {
  try {
    const raw = await readFile(visionFile, 'utf8');
    const parsed = JSON.parse(raw) as Partial<VisionConfig>;
    return {
      providerId: typeof parsed.providerId === 'string' ? parsed.providerId : '',
      model: typeof parsed.model === 'string' ? parsed.model : '',
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : undefined,
    };
  } catch {
    return { ...EMPTY };
  }
}

export async function setVisionConfig(config: VisionConfig): Promise<void> {
  await mkdir(path.dirname(visionFile), { recursive: true });
  await writeFile(visionFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
