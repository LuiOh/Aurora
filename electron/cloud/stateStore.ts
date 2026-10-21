// 버킷·노트 폴더 조합마다 지난 동기화 상태와 MD5 캐시를 userData/cloud 아래 JSON으로 읽고 원자적으로 쓰는 저장소
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HashCache } from './localFs';
import type { SyncState } from './types';

export interface StateFile { files: SyncState; hashes: HashCache }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function pickFiles(v: unknown): SyncState {
  const out: SyncState = {};
  if (!isObj(v)) return out;
  for (const [rel, e] of Object.entries(v)) {
    if (isObj(e) && typeof e.md5 === 'string' && typeof e.etag === 'string') out[rel] = { md5: e.md5, etag: e.etag };
  }
  return out;
}

function pickHashes(v: unknown): HashCache {
  const out: HashCache = {};
  if (!isObj(v)) return out;
  for (const [rel, e] of Object.entries(v)) {
    if (isObj(e) && typeof e.md5 === 'string' && typeof e.size === 'number' && typeof e.mtimeMs === 'number') {
      out[rel] = { md5: e.md5, size: e.size, mtimeMs: e.mtimeMs };
    }
  }
  return out;
}

/** 없거나 깨진 파일은 빈 상태(처음 동기화 = 합집합)로 본다 */
export async function loadState(file: string): Promise<StateFile> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return { files: {}, hashes: {} };
  }
  return isObj(json) ? { files: pickFiles(json.files), hashes: pickHashes(json.hashes) } : { files: {}, hashes: {} };
}

export async function saveState(file: string, state: StateFile): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, file);
}
