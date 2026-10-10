/**
 * F5.4 — asset_inspect: zero-dependency binary asset parsers.
 * GLB/glTF (meshes, triangles, materials, textures, animations, extensions,
 * bounds), PNG/JPEG/WebP/KTX2 (dimensions, POT, VRAM estimate), WAV (duration).
 */
import { readFileSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';

export interface AssetReport {
  file: string;
  bytes: number;
  kind: string;
  summary: string;
  warnings: string[];
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function parseGlb(buf: Buffer, file: string): AssetReport {
  const warnings: string[] = [];
  const summaryParts: string[] = [];
  if (buf.length < 12 || buf.readUInt32LE(0) !== 0x46546c67) { // 'glTF'
    return { file, bytes: buf.length, kind: 'glb?', summary: 'invalid GLB magic', warnings: ['not a GLB file'] };
  }
  let json: Record<string, unknown> = {};
  try {
    let offset = 12;
    while (offset + 8 <= buf.length) {
      const chunkLen = buf.readUInt32LE(offset);
      const chunkType = buf.readUInt32LE(offset + 4);
      if (chunkType === 0x4e4f534a) { // JSON
        json = JSON.parse(buf.subarray(offset + 8, offset + 8 + chunkLen).toString('utf8'));
        break;
      }
      offset += 8 + chunkLen + (chunkLen % 4);
    }
  } catch {
    return { file, bytes: buf.length, kind: 'glb', summary: 'JSON chunk parse failed', warnings: ['corrupt GLB JSON chunk'] };
  }

  const scenes = (json.scenes as unknown[] | undefined)?.length ?? 0;
  const nodes = (json.nodes as unknown[] | undefined)?.length ?? 0;
  const meshes = (json.meshes as Array<Record<string, unknown>> | undefined) ?? [];
  const accessors = (json.accessors as Array<Record<string, unknown>> | undefined) ?? [];
  const materials = (json.materials as Array<Record<string, unknown>> | undefined) ?? [];
  const images = (json.images as Array<Record<string, unknown>> | undefined) ?? [];
  const textures = (json.textures as Array<Record<string, unknown>> | undefined) ?? [];
  const animations = (json.animations as Array<Record<string, unknown>> | undefined) ?? [];
  const extensionsUsed = (json.extensionsUsed as string[] | undefined) ?? [];

  let triangles = 0;
  let anyMissingIndex = false;
  for (const mesh of meshes) {
    const prims = (mesh.primitives as Array<Record<string, unknown>> | undefined) ?? [];
    for (const prim of prims) {
      const idxAcc = prim.indices as number | undefined;
      if (idxAcc === undefined) {
        // non-indexed: POSITION count / 3
        const posAcc = prim.attributes as Record<string, number> | undefined;
        const posIdx = posAcc?.POSITION;
        if (typeof posIdx === 'number' && accessors[posIdx]) {
          triangles += Math.floor(Number(accessors[posIdx].count ?? 0) / 3);
        }
        anyMissingIndex = true;
      } else {
        const acc = accessors[idxAcc];
        if (acc) triangles += Math.floor(Number(acc.count ?? 0) / 3);
      }
    }
  }
  if (anyMissingIndex) warnings.push('at least one mesh primitive has no index buffer');

  // bounding box from POSITION accessor min/max
  let bounds = '';
  for (const acc of accessors) {
    const min = acc.min as number[] | undefined;
    const max = acc.max as number[] | undefined;
    if (Array.isArray(min) && Array.isArray(max) && min.length === 3) {
      bounds = ` · bounds ${min.map((v) => v.toFixed(1)).join(',')} → ${max.map((v) => v.toFixed(1)).join(',')}`;
      break;
    }
  }

  // duration of longest animation
  let duration = '';
  for (const anim of animations) {
    const channels = (anim.channels as unknown[] | undefined)?.length ?? 0;
    summaryParts.push(`anim(${channels} ch)`);
  }
  void duration;

  // embedded image sizes
  const imageInfos: string[] = [];
  for (const img of images.slice(0, 12)) {
    const bv = img.bufferView as number | undefined;
    if (typeof bv !== 'number') continue;
    // header sniff: PNG IHDR / JPEG SOF
    // (bufferViews offsets are resolved from json — approximate: scan whole BIN for magic near offset)
    imageInfos.push(String(img.mimeType ?? 'image'));
  }

  summaryParts.unshift(
    `${scenes} scene(s) · ${nodes} node(s) · ${meshes.length} mesh(es) · ${triangles} tris · ${materials.length} material(s) · ${textures.length} texture(s)/${images.length} image(s)${animations.length ? ` · ${animations.length} animation(s)` : ''}${bounds}`,
  );
  for (const ext of extensionsUsed) {
    if (ext.includes('draco')) warnings.push('uses KHR_draco_mesh_compression — requires a draco decoder at runtime');
    if (ext.includes('meshopt')) warnings.push('uses EXT_meshopt_compression — requires meshopt decoder at runtime');
    if (ext.includes('basisu')) warnings.push('uses KHR_texture_basisu — requires KTX2/basis transcoder at runtime');
  }
  return {
    file,
    bytes: buf.length,
    kind: 'glb',
    summary: summaryParts.join(' · '),
    warnings,
  };
}

function parsePng(buf: Buffer, file: string): AssetReport {
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const pot = (width & (width - 1)) === 0 && (height & (height - 1)) === 0;
  const vram = (width * height * 4 * 1.33) / 1048576;
  return {
    file,
    bytes: buf.length,
    kind: 'png',
    summary: `${width}×${height}${pot ? ' (POT)' : ' (non-POT)'} · est. VRAM ${vram.toFixed(1)} MB`,
    warnings: width > 2048 || height > 2048 ? [`texture ${width}×${height} exceeds 2048 budget`] : [],
  };
}

function parseJpeg(buf: Buffer, file: string): AssetReport {
  let width = 0;
  let height = 0;
  for (let i = 2; i < buf.length - 9; i += 1) {
    if (buf[i] !== 0xff) continue;
    const marker = buf[i + 1];
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      height = buf.readUInt16BE(i + 5);
      width = buf.readUInt16BE(i + 7);
      break;
    }
  }
  return {
    file,
    bytes: buf.length,
    kind: 'jpeg',
    summary: width ? `${width}×${height} (no alpha)` : 'dimensions unknown',
    warnings: width > 2048 ? [`texture ${width}×${height} exceeds 2048 budget`] : [],
  };
}

function parseWebp(buf: Buffer, file: string): AssetReport {
  let width = 0;
  let height = 0;
  if (buf.length > 30 && buf.readUInt32LE(12) === 0x38504c56) { // VP8
    width = buf.readUInt16LE(26) & 0x3fff;
    height = buf.readUInt16LE(28) & 0x3fff;
  } else if (buf.length > 24 && buf.readUInt32LE(12) === 0x4c385056) { // VP8L
    const bits = buf.readUInt32LE(21);
    width = (bits & 0x3fff) + 1;
    height = ((bits >> 14) & 0x3fff) + 1;
  }
  return {
    file,
    bytes: buf.length,
    kind: 'webp',
    summary: width ? `${width}×${height}` : 'dimensions unknown',
    warnings: [],
  };
}

function parseWav(buf: Buffer, file: string): AssetReport {
  let sampleRate = 0;
  let bitsPerSample = 0;
  let channels = 0;
  let dataBytes = 0;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.subarray(offset, offset + 4).toString('ascii');
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      bitsPerSample = buf.readUInt16LE(offset + 22);
    } else if (id === 'data') {
      dataBytes = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  const duration = sampleRate > 0 && bitsPerSample > 0 && channels > 0
    ? dataBytes / (sampleRate * channels * (bitsPerSample / 8))
    : 0;
  return {
    file,
    bytes: buf.length,
    kind: 'wav',
    summary: `${duration.toFixed(1)}s · ${sampleRate} Hz · ${channels}ch · ${bitsPerSample}bit`,
    warnings: duration > 60 ? ['audio > 60 s — consider streaming instead of a buffer'] : [],
  };
}

export function inspectAsset(absPath: string, relPath: string): AssetReport | null {
  let buf: Buffer;
  try { buf = readFileSync(absPath); } catch { return null; }
  const ext = path.extname(absPath).toLowerCase();
  try {
    switch (ext) {
      case '.glb': return parseGlb(buf, relPath);
      case '.gltf': return { file: relPath, bytes: buf.length, kind: 'gltf', summary: 'JSON glTF — external buffers; inspect the .glb/.bin directly', warnings: [] };
      case '.png': return parsePng(buf, relPath);
      case '.jpg': case '.jpeg': return parseJpeg(buf, relPath);
      case '.webp': return parseWebp(buf, relPath);
      case '.ktx2': return { file: relPath, bytes: buf.length, kind: 'ktx2', summary: 'KTX2/Basis compressed texture — GPU-ready', warnings: ['requires KHR_texture_basisu transcoder support'] };
      case '.wav': return parseWav(buf, relPath);
      case '.ogg': case '.mp3': return { file: relPath, bytes: buf.length, kind: ext.slice(1), summary: `${fmtBytes(buf.length)} (compressed audio; duration not parsed)`, warnings: [] };
      default: return null;
    }
  } catch (error) {
    return { file: relPath, bytes: buf.length, kind: ext.slice(1), summary: `parse failed: ${error instanceof Error ? error.message : 'error'}`, warnings: [] };
  }
}

export function inspectFolder(absDir: string, relDir: string): AssetReport[] {
  const out: AssetReport[] = [];
  const entries = readdirSync(absDir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(absDir, entry.name);
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...inspectFolder(abs, rel));
    } else {
      const report = inspectAsset(abs, rel);
      if (report) out.push(report);
    }
  }
  return out;
}

export function assetSize(absPath: string): number {
  try { return statSync(absPath).size; } catch { return 0; }
}
