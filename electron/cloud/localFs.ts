// 동기화할 노트 폴더 파일을 훑어 MD5를 구하고(크기·수정 시각 캐시), 같은 폴더 임시 파일로 안전하게 쓰는 파일 도우미
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { isBundleSegment, isSyncable } from './keys';
import type { SkippedFile } from './types';

export interface HashEntry { size: number; mtimeMs: number; md5: string }
export type HashCache = Record<string, HashEntry>;

/** rel은 NFC, raw는 디스크 이름 그대로를 / 로 이은 경로, abs는 실제 입출력 경로 */
export interface ScannedFile extends HashEntry { rel: string; raw: string; abs: string }

export interface ScanResult {
  files: ScannedFile[];
  hashes: HashCache;
  oversize: string[];
  warnings: SkippedFile[];
}

export async function md5File(abs: string): Promise<string> {
  const h = createHash('md5');
  for await (const chunk of createReadStream(abs)) h.update(chunk as Buffer);
  return h.digest('hex');
}

export const md5Bytes = (bytes: Uint8Array): string => createHash('md5').update(bytes).digest('hex');

/** 숨김 폴더 중 .aurora와 .aurora/chats 아래만 들어간다. node_modules와 앱 묶음(.app 등)에는 들어가지 않는다 */
function mayHoldSyncable(relDir: string): boolean {
  const segs = relDir.split('/');
  if (segs.includes('node_modules') || segs.some(isBundleSegment)) return false;
  if (segs[0] === '.aurora') return segs.length === 1 || (segs[1] === 'chats' && !segs.slice(2).some((s) => s.startsWith('.')));
  return !segs.some((s) => s.startsWith('.'));
}

const toRelRaw = (root: string, abs: string): string => path.relative(root, abs).split(path.sep).join('/');

const TEMP_NAME = /^\.aurora-sync-.+\.tmp$/;
/** 이보다 오래된 우리 임시 파일은 끊긴 실행이 남긴 것으로 보고 훑을 때 지운다 */
export const STALE_TEMP_MS = 60 * 60 * 1000;

async function removeStaleTemp(abs: string, now: number): Promise<void> {
  const st = await stat(abs);
  if (now - st.mtimeMs > STALE_TEMP_MS) await rm(abs, { force: true });
}

export async function scanLocal(root: string, cache: HashCache, maxBytes: number, now = Date.now()): Promise<ScanResult> {
  const out: ScanResult = { files: [], hashes: {}, oversize: [], warnings: [] };
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      out.warnings.push({ path: toRelRaw(root, dir) || '.', reason: `폴더를 읽지 못함: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const raw = toRelRaw(root, abs);
      if (ent.isDirectory()) {
        if (mayHoldSyncable(raw.normalize('NFC'))) await walk(abs);
      } else if (ent.isFile() && TEMP_NAME.test(ent.name)) {
        await removeStaleTemp(abs, now).catch((err: unknown) => {
          out.warnings.push({ path: raw, reason: `임시 파일을 지우지 못함: ${err instanceof Error ? err.message : String(err)}` });
        });
      } else if (ent.isFile() && isSyncable(raw)) {
        await addFile(abs, raw);
      }
    }
  };
  const addFile = async (abs: string, raw: string): Promise<void> => {
    const rel = raw.normalize('NFC');
    try {
      const st = await stat(abs);
      if (st.size > maxBytes) {
        out.oversize.push(rel);
        return;
      }
      const prev = cache[rel];
      const md5 = prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs ? prev.md5 : await md5File(abs);
      const entry = { size: st.size, mtimeMs: st.mtimeMs, md5 };
      out.hashes[rel] = entry;
      out.files.push({ ...entry, rel, raw, abs });
    } catch (err) {
      out.warnings.push({ path: rel, reason: `읽지 못함: ${err instanceof Error ? err.message : String(err)}` });
    }
  };
  await walk(root);
  return out;
}

/** 같은 폴더의 숨김 임시 파일에 쓴 뒤 이름을 바꿔 한 번에 갈아 끼운다 (숨김·.tmp라 동기화 대상이 아니다) */
export async function writeAtomic(abs: string, bytes: Uint8Array): Promise<void> {
  const tmp = await writeTemp(abs, bytes);
  try {
    await rename(tmp, abs);
  } catch (err) {
    await discardTemp(tmp);
    throw err;
  }
}

/**
 * abs와 같은 폴더의 숨김 임시 파일에 써서 디스크에 확정(fsync)하고 그 경로를 돌려준다. rename으로 갈아 끼우거나 discardTemp로 버린다.
 * 확정하지 않으면 전원이 꺼졌을 때 빈 파일이 남아 로컬에서 고친 것처럼 보일 수 있다. 쓰다 실패하면 임시 파일을 지운다
 */
export async function writeTemp(abs: string, bytes: Uint8Array): Promise<string> {
  await mkdir(path.dirname(abs), { recursive: true });
  const tmp = path.join(path.dirname(abs), `.aurora-sync-${randomUUID()}.tmp`);
  try {
    const fh = await open(tmp, 'wx');
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch (err) {
    await discardTemp(tmp);
    throw err;
  }
  return tmp;
}

/**
 * abs를 쓸 폴더가 rootReal(realpath한 노트 폴더) 안에 있는지. 심볼릭 링크로 밖을 가리키는 폴더는 밖으로 본다.
 * 아직 없는 폴더는 있는 가장 가까운 조상으로 판단한다 (그 아래에 새로 만드는 폴더는 링크일 수 없다)
 */
export async function writableInside(rootReal: string, abs: string): Promise<boolean> {
  for (let dir = path.dirname(abs); ; ) {
    let real: string;
    try {
      real = await realpath(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const up = path.dirname(dir);
      if (up === dir) return false;
      dir = up;
      continue;
    }
    const rel = path.relative(rootReal, real);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  }
}

export const discardTemp = (tmp: string): Promise<void> => rm(tmp, { force: true });

export async function statSig(abs: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const st = await stat(abs);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
