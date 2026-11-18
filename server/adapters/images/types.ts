

import type { ImageModelCaps } from './modelCaps.js';
export type { ImageModelCaps, ImageModelMode } from './modelCaps.js';


export type ImageTaskStatus = 'PENDING' | 'RUNNING' | 'SUCCEED' | 'FAILED' | (string & {});


export type NormalizedImage =
  | { kind: 'url'; url: string }
  | { kind: 'b64';  data: string };

export interface ImageSubmitRequest {
  model: string;
  prompt: string;
  
  aspectRatio?: string;
  
  width?: number;
  height?: number;
  
  images?: string[];
}


export interface ImageCredentials {
  label: string;
  baseUrl: string;
  apiKey?: string;
}


export interface AdapterContext {
  credentials: ImageCredentials;
  
  record?: ImageTaskRecord;
}


export interface ImageTaskRecord {
  adapterId: string;
  providerId: string;
  credentials: ImageCredentials;
  model: string;
  prompt: string;
  requested: { width: number; height: number } | null;
  aspectRatio: string | null;
  submittedAt: string;
}

export interface ImagePollResult {
  
  status: ImageTaskStatus;
  
  providerStatus?: string;
  images: NormalizedImage[];
  
  error?: string;
  
  note?: string;
  
  raw?: unknown;
}


export interface ImageCapabilities {
  
  execution: 'async' | 'sync';
  
  sizeParam: 'aspect_ratio' | 'size' | 'width_height' | 'none';
  
  resultFormat: 'url' | 'b64' | 'both';
  
  maxImages: number;
  supportsNegativePrompt: boolean;
  
  maxReferences: number;
  
  models?: Record<string, ImageModelCaps>;
}


export interface ImageAdapter {
  readonly id: string;
  readonly capabilities: ImageCapabilities;
  submit(req: ImageSubmitRequest, ctx: AdapterContext): Promise<{ taskId: string }>;
  poll(taskId: string, ctx: AdapterContext): Promise<ImagePollResult>;
}


export class ImageAdapterError extends Error {
  readonly status: number;
  
  readonly upstreamBody?: string;

  constructor(status: number, message: string, upstreamBody?: string) {
    super(message);
    this.name = 'ImageAdapterError';
    this.status = status;
    this.upstreamBody = upstreamBody;
  }
}

export const isTerminalImageStatus = (status: string): boolean =>
  status === 'SUCCEED' || status === 'FAILED';


export function ensureV1(baseUrl: string): string {
  const raw = baseUrl.replace(/\/+$/, '');
  return /\/v1$/.test(raw) ? raw : `${raw}/v1`;
}
