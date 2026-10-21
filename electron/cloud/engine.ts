// 노트 폴더와 S3 버킷을 맞추는 동기화 엔진: 목록·훑기·계획·실행(동시 4개)을 한 번에 하나씩 돌리고 상태를 알린다 (삭제는 하지 않는다)
import { readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { toSlash } from '../paths';
import { conflictName, isSyncable, toKey, toRel } from './keys';
import { discardTemp, md5Bytes, scanLocal, statSig, writableInside, writeAtomic, writeTemp, type ScannedFile, type ScanResult } from './localFs';
import { etagHash, planSync } from './plan';
import { createS3Client, type S3Client, type S3ClientOptions } from './s3';
import { stateFileName } from './settings';
import { loadState, saveState, type StateFile } from './stateStore';
import { stripEtag } from './xml';
import { CloudError, type CloudConfig, type CloudEvent, type CloudPreview, type CloudStatus, type SkippedFile, type PlanAction, type RemoteObject } from './types';
import { createSerialQueue, type SerialQueue } from '../serialQueue';

export interface EngineTarget { cfg: CloudConfig; device: string; notesDir: string }

export interface EngineDeps {
  fetch: typeof fetch;
  /** 상태 파일을 두는 폴더 (앱에서는 userData/cloud) */
  stateDir: string;
  /** 클라우드 모드가 아니거나 노트 폴더가 없으면 null. 비밀 키 문제는 CloudError('auth')로 던진다 */
  load: () => Promise<EngineTarget | null>;
  emit: (ev: CloudEvent) => void;
  now?: () => Date;
  maxFileBytes?: number;
  concurrency?: number;
  /** 이보다 큰 파일은 메모리를 아끼려고 따로 한 번에 하나씩 옮긴다 (기본 10MB) */
  bigFileBytes?: number;
  s3Options?: S3ClientOptions;
  /** 내려받은 파일을 모아 changed로 알리는 간격 (기본 1초). 실행이 끝날 때도 남은 것을 알린다 */
  changedFlushMs?: number;
  /** 앱의 파일 쓰기와 함께 쓰는 줄. 내려받은 파일을 갈아 끼우는 마지막 단계가 앱 저장과 섞이지 않게 이 줄에서 돈다 */
  writeQueue?: SerialQueue;
}

export interface SyncEngine {
  /**
   * paths가 없으면 폴더와 버킷 전체를 맞춘다. paths(앱이 쓴 파일의 절대 경로)가 있으면 그 파일만 올리고,
   * 다른 기기가 먼저 바꿨으면 전체 맞춤을 잇는다. 돌고 있으면 끝난 뒤 이어서 돈다. 돌려준 약속은 그 뒤따르는 실행까지 끝나야 풀린다
   */
  sync(opts?: { paths?: readonly string[] }): Promise<void>;
  rememberConditionalWrites(cfg: CloudConfig, value: boolean): void;
  status(): CloudStatus;
  /** 남은 작업을 더 집지 않고 상태를 off로 둔다. 도는 실행은 다음 sync와 섞이지 않고 끝난다 */
  stop(): void;
  flush(): Promise<void>;
}

export const MAX_SYNC_FILE_BYTES = 100 * 1024 * 1024;
const BIG_FILE_BYTES = 10 * 1024 * 1024;
const MAX_AUTO_RERUNS = 3;

interface RunCtx {
  target: EngineTarget;
  /** realpath한 노트 폴더. 내려받은 파일은 이 안에만 쓴다 */
  rootReal: string;
  s3: S3Client;
  st: StateFile;
  local: Map<string, ScannedFile>;
  /** rel(NFC) → 목록에서 본 객체 (rawKey는 저장소 키 그대로) */
  remote: Map<string, RemoteObject>;
  conditional: boolean;
  /** 다른 기기가 먼저 바꿨거나 받는 사이 사라져 다시 계획해야 하는 경로 */
  retry: Set<string>;
  warnings: SkippedFile[];
  conflicts: { path: string; copyPath: string }[];
}

const CONTENT_TYPES: Record<string, string> = {
  md: 'text/markdown; charset=utf-8', markdown: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', json: 'application/json',
};
const contentType = (rel: string): string =>
  CONTENT_TYPES[rel.slice(rel.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';

const isKind = (err: unknown, ...kinds: CloudError['kind'][]): boolean => err instanceof CloudError && kinds.includes(err.kind);
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

interface Fetched { tmp: string; md5: string; etag: string }

const keyFor = (ctx: RunCtx, rel: string): string => ctx.remote.get(rel)?.rawKey ?? toKey(ctx.target.cfg.prefix, rel);

const absFor = (ctx: RunCtx, rel: string): string =>
  ctx.local.get(rel)?.abs ?? path.join(ctx.target.notesDir, ...rel.split('/'));

/** 훑은 뒤로 파일이 그대로인지 (훑을 때 없던 파일은 지금도 없어야 한다) */
async function unchangedSinceScan(abs: string, scanned: ScannedFile | undefined): Promise<boolean> {
  const sig = await statSig(abs);
  if (!scanned) return sig === null;
  return sig !== null && sig.size === scanned.size && sig.mtimeMs === scanned.mtimeMs;
}

async function pool<T>(items: readonly T[], n: number, stop: () => boolean, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const failures: unknown[] = [];
  const worker = async (): Promise<void> => {
    while (failures.length === 0 && !stop() && next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (err) {
        failures.push(err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  if (failures.length > 0) throw failures[0];
}

/** 노트 폴더가 아직 없으면 경로 그대로 쓴다 */
async function realDir(dir: string): Promise<string> {
  try {
    return await realpath(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return path.resolve(dir);
    throw err;
  }
}

/** 같은 폴더를 다른 경로로 열어도 같은 상태를 쓰도록 realpath로 고른다. 예전(경로 그대로) 상태 파일이 있으면 이어 쓴다 */
async function loadStateFor(stateDir: string, target: EngineTarget, rootReal: string): Promise<StateFile> {
  const file = path.join(stateDir, stateFileName(target.cfg, rootReal));
  const legacy = path.join(stateDir, stateFileName(target.cfg, target.notesDir));
  const useLegacy = legacy !== file && (await statSig(file)) === null && (await statSig(legacy)) !== null;
  return loadState(useLegacy ? legacy : file);
}

/** 오래 걸리는 로컬 훑기를 먼저 하고 목록은 나중에 받아, 목록과 올리기 사이에 다른 기기가 끼어들 틈을 줄인다 */
async function scanAndPlan(
  target: EngineTarget, s3: S3Client, st: StateFile, opts: { maxBytes: number; now: Date; conditional: boolean },
): Promise<{ scan: ScanResult; remote: RemoteObject[]; actions: PlanAction[] }> {
  const scan = await scanLocal(target.notesDir, st.hashes, opts.maxBytes);
  const remote = (await s3.list(target.cfg.prefix))
    .map((o) => ({ ...o, key: toRel(target.cfg.prefix, o.key) ?? '' }))
    .filter((o) => o.key !== '' && isSyncable(o.key));
  const local = scan.files.map((f) => ({ rel: f.raw, md5: f.md5, size: f.size }));
  const actions = planSync(local, remote, st.files, { device: target.device, now: opts.now, conditionalWrites: opts.conditional });
  return { scan, remote, actions };
}

const PREVIEW_TOP_FOLDERS = 5;

/** 훑기·목록·계획만 하고 아무것도 옮기지 않는다. 상태 파일도 쓰지 않는다 (클라우드로 바꾸기 전 확인용) */
export async function previewSync(
  target: EngineTarget,
  deps: { fetch: typeof fetch; stateDir: string; now?: () => Date; maxFileBytes?: number; s3Options?: S3ClientOptions },
): Promise<CloudPreview> {
  const s3 = createS3Client(target.cfg, deps.fetch, deps.s3Options);
  const st = await loadStateFor(deps.stateDir, target, await realDir(target.notesDir));
  const found = await scanAndPlan(target, s3, st, {
    maxBytes: deps.maxFileBytes ?? MAX_SYNC_FILE_BYTES, now: (deps.now ?? (() => new Date()))(), conditional: true,
  });
  const sizeOf = new Map(found.scan.files.map((f) => [f.rel, f.size]));
  const remoteSize = new Map(found.remote.map((o) => [o.key.normalize('NFC'), o.size]));
  const out: CloudPreview = { upload: { count: 0, bytes: 0 }, download: { count: 0, bytes: 0 }, conflicts: 0, topFolders: [], skipped: 0 };
  const folders = new Map<string, number>();
  for (const a of found.actions) {
    if (a.type === 'upload') {
      out.upload.count++;
      out.upload.bytes += sizeOf.get(a.rel) ?? 0;
      const slash = a.rel.indexOf('/');
      if (slash > 0) folders.set(a.rel.slice(0, slash), (folders.get(a.rel.slice(0, slash)) ?? 0) + 1);
    } else if (a.type === 'download') {
      out.download.count++;
      out.download.bytes += remoteSize.get(a.rel) ?? 0;
    } else if (a.type === 'conflict') out.conflicts++;
    else if (a.type === 'skip') out.skipped++;
  }
  out.skipped += found.scan.oversize.length + found.scan.warnings.length;
  out.topFolders = [...folders]
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .slice(0, PREVIEW_TOP_FOLDERS)
    .map(([name, count]) => ({ name, count }));
  return out;
}

export function createSyncEngine(deps: EngineDeps): SyncEngine {
  const now = deps.now ?? (() => new Date());
  const maxBytes = deps.maxFileBytes ?? MAX_SYNC_FILE_BYTES;
  const tooBig = `${Math.round(maxBytes / 1024 / 1024)}MB보다 큼`;
  const probes = new Map<string, boolean>();
  const saves = createSerialQueue();
  const writes = deps.writeQueue ?? createSerialQueue();
  const bigBytes = deps.bigFileBytes ?? BIG_FILE_BYTES;
  let status: CloudStatus = { state: 'off' };
  // stop()마다 세대를 올린다. 예전 세대의 실행은 상태를 바꾸지 않고 더 집지 않는다
  let gen = 0;
  let current: { gen: number; done: Promise<void> } | null = null;
  let pendingFull = false;
  const pendingPaths = new Set<string>();
  let live: { file: string; st: StateFile } | null = null;
  let dirtyTimer: ReturnType<typeof setTimeout> | null = null;
  let changedPaths: string[] = [];
  let changedTimer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (next: CloudStatus): void => {
    status = { ...next, lastSync: next.lastSync ?? status.lastSync };
    deps.emit({ type: 'status', status });
  };
  const probeKey = (cfg: CloudConfig): string => stateFileName(cfg, '');

  function flush(): Promise<void> {
    if (dirtyTimer) clearTimeout(dirtyTimer);
    dirtyTimer = null;
    const snap = live;
    return snap ? saves.run(() => saveState(snap.file, snap.st)) : Promise.resolve();
  }

  const markDirty = (): void => {
    if (dirtyTimer) return;
    dirtyTimer = setTimeout(() => {
      dirtyTimer = null;
      flush().catch((err: unknown) => console.error('동기화 상태 저장 실패', errText(err)));
    }, 1000);
    dirtyTimer.unref?.();
  };

  // 내려받는 동안에도 화면이 색인을 맞추도록 바뀐 경로를 모아 두었다가 주기적으로 알린다
  const flushChanged = (): void => {
    if (changedTimer) clearTimeout(changedTimer);
    changedTimer = null;
    if (changedPaths.length === 0) return;
    const paths = changedPaths;
    changedPaths = [];
    deps.emit({ type: 'changed', paths });
  };

  const noteChanged = (abs: string): void => {
    changedPaths.push(toSlash(abs));
    if (changedTimer) return;
    changedTimer = setTimeout(flushChanged, deps.changedFlushMs ?? 1000);
    changedTimer.unref?.();
  };

  const record = (ctx: RunCtx, rel: string, md5: string, etag: string): void => {
    ctx.st.files[rel] = { md5, etag: etag || md5 };
    markDirty();
  };

  async function rememberHash(ctx: RunCtx, rel: string, abs: string, md5: string): Promise<void> {
    const sig = await statSig(abs);
    if (sig) ctx.st.hashes[rel] = { ...sig, md5 };
  }

  /**
   * expect는 원격에 있어야 할 ETag (null이면 없어야 한다). 조건부 쓰기를 지원하면 If-Match·If-None-Match로,
   * 아니면 올리기 직전에 HEAD로 확인한다. 다르면 다른 기기가 먼저 바꾼 것이니 올리지 않고 다시 계획한다
   */
  async function putTracked(ctx: RunCtx, rel: string, bytes: Uint8Array, expect: string | null): Promise<void> {
    const key = keyFor(ctx, rel);
    try {
      if (!ctx.conditional) {
        const cur = await ctx.s3.head(key);
        const same = expect === null ? cur === null : cur !== null && stripEtag(cur.etag) === stripEtag(expect);
        if (!same) throw new CloudError('precondition', '올리기 직전에 보니 다른 기기가 먼저 바꿨습니다');
      }
      const cond = !ctx.conditional ? {} : expect === null ? { ifNoneMatch: '*' as const } : { ifMatch: expect };
      const res = await ctx.s3.put(key, bytes, { ...cond, contentType: contentType(rel) });
      record(ctx, rel, md5Bytes(bytes), res.etag);
    } catch (err) {
      if (!isKind(err, 'precondition')) throw err;
      ctx.retry.add(rel); // 다른 기기가 먼저 바꿨다. 다시 계획해 맞춘다
    }
  }

  async function upload(ctx: RunCtx, a: Extract<PlanAction, { type: 'upload' }>): Promise<void> {
    const f = ctx.local.get(a.rel);
    if (!f) return;
    await putTracked(ctx, a.rel, await readFile(f.abs), ctx.remote.get(a.rel)?.etag ?? null);
  }

  /** 원격 내용을 원래 파일 옆 임시 파일로 받아 둔다. 너무 크거나 사라졌으면 null */
  async function fetchRemote(ctx: RunCtx, rel: string, listedEtag: string): Promise<Fetched | null> {
    const size = ctx.remote.get(rel)?.size;
    if ((size ?? 0) > maxBytes) {
      ctx.warnings.push({ path: rel, reason: tooBig });
      return null;
    }
    const abs = absFor(ctx, rel);
    if (!(await writableInside(ctx.rootReal, abs))) {
      ctx.warnings.push({ path: rel, reason: '노트 폴더 밖을 가리키는 폴더(심볼릭 링크)라 쓰지 않음' });
      return null;
    }
    let got: { bytes: Uint8Array; etag: string };
    try {
      got = await ctx.s3.get(keyFor(ctx, rel), size, maxBytes);
    } catch (err) {
      if (!isKind(err, 'not-found')) throw err;
      ctx.retry.add(rel);
      return null;
    }
    const md5 = md5Bytes(got.bytes);
    const expected = etagHash(got.etag);
    if (expected !== null && expected !== md5) {
      ctx.warnings.push({ path: rel, reason: '받은 내용이 저장소의 MD5와 달라 쓰지 않음 (다음에 다시 받음)' });
      return null;
    }
    const tmp = await writeTemp(abs, got.bytes);
    return { tmp, md5, etag: got.etag || listedEtag };
  }

  /** 훑은 뒤로 그대로일 때만 받아 둔 임시 파일로 갈아 끼운다. 못 끼우면 임시 파일을 버린다 */
  async function replaceWith(ctx: RunCtx, rel: string, got: Fetched): Promise<boolean> {
    const abs = absFor(ctx, rel);
    let replaced = false;
    try {
      // 확인과 갈아 끼우기 사이에 앱 저장이 끼지 않게 앱 쓰기와 같은 줄에서 한다. 그사이 고친 파일은 다음 실행에서 다시 본다
      replaced = await writes.run(async () => {
        if (!(await unchangedSinceScan(abs, ctx.local.get(rel)))) return false;
        await rename(got.tmp, abs);
        await rememberHash(ctx, rel, abs, got.md5);
        return true;
      });
    } finally {
      if (!replaced) await discardTemp(got.tmp);
    }
    return replaced;
  }

  async function download(ctx: RunCtx, rel: string, listedEtag: string): Promise<void> {
    const got = await fetchRemote(ctx, rel, listedEtag);
    if (!got || !(await replaceWith(ctx, rel, got))) return;
    record(ctx, rel, got.md5, got.etag);
    noteChanged(absFor(ctx, rel));
  }

  async function freeCopyRel(ctx: RunCtx, rel: string, planned: string): Promise<string> {
    let candidate = planned;
    for (let n = 2; (await statSig(path.join(ctx.target.notesDir, ...candidate.split('/')))) !== null; n++) {
      candidate = conflictName(rel, ctx.target.device, now(), n);
    }
    return candidate;
  }

  /** 방금 만든 충돌 사본을 걷는다. 원본을 못 바꿨으니 사본은 원본과 같은 내용이라 잃는 것이 없다. 그사이 누가 고쳤으면 둔다 */
  async function dropCopy(ctx: RunCtx, copyRel: string, copyAbs: string): Promise<void> {
    await writes.run(async () => {
      const made = ctx.st.hashes[copyRel];
      const sig = await statSig(copyAbs);
      if (!made || !sig || sig.size !== made.size || sig.mtimeMs !== made.mtimeMs) return;
      await rm(copyAbs, { force: true });
      delete ctx.st.hashes[copyRel];
    });
  }

  // 원격을 먼저 받아 두고, 사본을 쓴 뒤 원본을 바꾼다. 원본을 바꾼 뒤에만 사본을 올리고 상태를 남긴다.
  // 원본을 못 바꾸면(열려 있음·사라짐·바뀜) 사본을 걷어 다음 실행이 사본을 거듭 만들지 않게 한다
  async function conflict(ctx: RunCtx, a: Extract<PlanAction, { type: 'conflict' }>): Promise<void> {
    const f = ctx.local.get(a.rel);
    if (!f || !(await unchangedSinceScan(f.abs, f))) return;
    const got = await fetchRemote(ctx, a.rel, a.etag);
    if (!got) return;
    let copy: { rel: string; abs: string; bytes: Uint8Array } | null = null;
    let replaced = false;
    try {
      const copyRel = await freeCopyRel(ctx, a.rel, a.copyRel);
      const copyAbs = path.join(ctx.target.notesDir, ...copyRel.split('/'));
      const bytes = await readFile(f.abs);
      await writes.run(async () => {
        await writeAtomic(copyAbs, bytes);
        await rememberHash(ctx, copyRel, copyAbs, md5Bytes(bytes));
      });
      copy = { rel: copyRel, abs: copyAbs, bytes };
      replaced = await replaceWith(ctx, a.rel, got);
    } finally {
      await discardTemp(got.tmp);
      if (copy && !replaced) await dropCopy(ctx, copy.rel, copy.abs);
    }
    if (!replaced) return;
    record(ctx, a.rel, got.md5, got.etag);
    noteChanged(f.abs);
    noteChanged(copy.abs);
    ctx.conflicts.push({ path: toSlash(f.abs), copyPath: toSlash(copy.abs) });
    await putTracked(ctx, copy.rel, copy.bytes, null);
  }

  async function execute(ctx: RunCtx, a: PlanAction): Promise<void> {
    try {
      if (a.type === 'upload') await upload(ctx, a);
      else if (a.type === 'download') await download(ctx, a.rel, a.etag);
      else if (a.type === 'conflict') await conflict(ctx, a);
      else if (a.type === 'record') record(ctx, a.rel, a.md5, a.etag);
      else ctx.warnings.push({ path: a.rel, reason: a.reason });
    } catch (err) {
      if (err instanceof CloudError && err.kind !== 'not-found' && err.kind !== 'bad-request') throw err;
      ctx.warnings.push({ path: a.rel, reason: errText(err) });
    }
  }

  async function stateFor(target: EngineTarget, rootReal: string): Promise<StateFile> {
    const file = path.join(deps.stateDir, stateFileName(target.cfg, rootReal));
    if (live?.file === file) return live.st;
    const st = await loadStateFor(deps.stateDir, target, rootReal);
    live = { file, st };
    return st;
  }

  async function openCtx(target: EngineTarget): Promise<RunCtx> {
    const s3 = createS3Client(target.cfg, deps.fetch, deps.s3Options);
    const key = probeKey(target.cfg);
    if (!probes.has(key)) probes.set(key, await s3.probeConditionalWrites());
    const rootReal = await realDir(target.notesDir);
    const st = await stateFor(target, rootReal);
    return {
      target, rootReal, s3, st, conditional: probes.get(key) ?? false, retry: new Set(), warnings: [], conflicts: [],
      local: new Map(), remote: new Map(),
    };
  }

  async function prepare(target: EngineTarget): Promise<{ ctx: RunCtx; actions: PlanAction[]; oversize: string[] }> {
    const ctx = await openCtx(target);
    const found = await scanAndPlan(target, ctx.s3, ctx.st, { maxBytes, now: now(), conditional: ctx.conditional });
    ctx.st.hashes = found.scan.hashes;
    ctx.warnings.push(...found.scan.warnings);
    for (const f of found.scan.files) ctx.local.set(f.rel, f);
    for (const o of found.remote) ctx.remote.set(o.key, o);
    return { ctx, actions: found.actions, oversize: found.scan.oversize };
  }

  /** 앱이 쓴 파일 하나를 지난 상태의 ETag를 조건으로 올린다. 내용이 지난번과 같으면 올리지 않는다 */
  async function uploadPath(ctx: RunCtx, rel: string, abs: string): Promise<void> {
    const sig = await statSig(abs);
    if (!sig) return;
    if (sig.size > maxBytes) {
      ctx.warnings.push({ path: rel, reason: tooBig });
      return;
    }
    const bytes = await readFile(abs);
    const md5 = md5Bytes(bytes);
    const after = await statSig(abs);
    if (after && after.size === sig.size && after.mtimeMs === sig.mtimeMs) ctx.st.hashes[rel] = { ...sig, md5 };
    const prev = ctx.st.files[rel];
    if (prev && prev.md5.toLowerCase() === md5) return;
    await putTracked(ctx, rel, bytes, prev ? prev.etag : null);
  }

  const relInNotes = (notesDir: string, abs: string): string | null => {
    const rel = path.relative(notesDir, abs);
    if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
    const slash = toSlash(rel).normalize('NFC');
    return isSyncable(slash) ? slash : null;
  };

  const summary = (ctx: RunCtx, oversize: string[]): string | undefined => {
    const parts: string[] = [];
    const mb = Math.round(maxBytes / 1024 / 1024);
    if (oversize.length) parts.push(`${mb}MB가 넘는 파일 ${oversize.length}개는 동기화하지 않았습니다`);
    if (ctx.warnings.length) parts.push(`${ctx.warnings.length}개 파일을 건너뛰었습니다 (${ctx.warnings[0].path}: ${ctx.warnings[0].reason})`);
    return parts.length ? parts.join(' · ') : undefined;
  };

  function failStatus(err: unknown): CloudStatus {
    if (isKind(err, 'network', 'server')) return { state: 'offline', message: errText(err) };
    if (err instanceof CloudError) return { state: 'error', message: err.message };
    return { state: 'error', message: `동기화하지 못했습니다: ${errText(err)}` };
  }

  const isTransfer = (a: PlanAction): boolean => a.type === 'upload' || a.type === 'download' || a.type === 'conflict';
  const isBig = (ctx: RunCtx, a: PlanAction): boolean =>
    isTransfer(a) && Math.max(ctx.local.get(a.rel)?.size ?? 0, ctx.remote.get(a.rel)?.size ?? 0) > bigBytes;

  async function runFull(ctx: RunCtx, actions: PlanAction[], alive: () => boolean): Promise<void> {
    const total = actions.filter(isTransfer).length;
    let done = 0;
    if (alive()) setStatus({ state: 'syncing', progress: { done, total } });
    let failed = false;
    const halt = (): boolean => failed || !alive();
    const run = async (a: PlanAction): Promise<void> => {
      try {
        await execute(ctx, a);
      } catch (err) {
        failed = true;
        throw err;
      }
      if (isTransfer(a) && alive()) setStatus({ state: 'syncing', progress: { done: ++done, total } });
    };
    // 큰 파일은 따로 한 줄로 하나씩 옮겨 한꺼번에 여러 개를 메모리에 올리지 않는다
    const lanes = await Promise.allSettled([
      pool(actions.filter((a) => !isBig(ctx, a)), deps.concurrency ?? 4, halt, run),
      pool(actions.filter((a) => isBig(ctx, a)), 1, halt, run),
    ]);
    for (const lane of lanes) if (lane.status === 'rejected') throw lane.reason;
  }

  async function runPaths(ctx: RunCtx, paths: readonly string[], alive: () => boolean): Promise<void> {
    for (const abs of paths) {
      if (!alive()) return;
      const rel = relInNotes(ctx.target.notesDir, abs);
      if (rel === null) continue;
      try {
        await uploadPath(ctx, rel, abs);
      } catch (err) {
        if (err instanceof CloudError && err.kind !== 'not-found' && err.kind !== 'bad-request') throw err;
        ctx.warnings.push({ path: rel, reason: errText(err) });
      }
    }
  }

  /** 건너뛴 파일 (전체 맞춤마다 새로 채우고, 쓴 파일만 올릴 때는 더한다) */
  let skipped: SkippedFile[] = [];
  const mergeSkipped = (more: readonly SkippedFile[]): SkippedFile[] => {
    const byPath = new Map(skipped.map((f) => [f.path, f]));
    for (const f of more) byPath.set(f.path, f);
    return [...byPath.values()];
  };
  const idleStatus = (extra: Partial<CloudStatus> = {}): CloudStatus => ({
    state: 'idle', ...extra, ...(skipped.length ? { skipped } : {}),
  });

  /** 다시 계획해야 할 경로. 없으면 빈 배열 */
  async function runOnce(paths: readonly string[] | null, alive: () => boolean): Promise<string[]> {
    let ctx: RunCtx | null = null;
    try {
      const target = await deps.load();
      if (!target) {
        if (alive()) setStatus({ state: 'off' });
        return [];
      }
      if (alive()) setStatus({ state: 'syncing' });
      let oversize: string[] = [];
      if (paths === null) {
        const prepared = await prepare(target);
        ctx = prepared.ctx;
        oversize = prepared.oversize;
        await runFull(ctx, prepared.actions, alive);
      } else {
        ctx = await openCtx(target);
        await runPaths(ctx, paths, alive);
      }
      const found = [...oversize.map((p) => ({ path: p, reason: tooBig })), ...ctx.warnings];
      if (alive()) {
        skipped = paths === null ? found : mergeSkipped(found);
        setStatus(idleStatus({ lastSync: now().getTime(), message: summary(ctx, oversize) }));
      }
      return [...ctx.retry];
    } catch (err) {
      if (alive()) setStatus(failStatus(err));
      return [];
    } finally {
      await flush();
      flushChanged();
      for (const c of ctx?.conflicts ?? []) deps.emit({ type: 'conflict', ...c });
    }
  }

  async function loop(myGen: number): Promise<void> {
    const alive = (): boolean => gen === myGen;
    let reruns = 0;
    while (alive() && (pendingFull || pendingPaths.size > 0)) {
      const paths = pendingFull ? null : [...pendingPaths];
      pendingFull = false;
      pendingPaths.clear();
      const retry = await runOnce(paths, alive);
      if (!alive()) break;
      if (pendingFull || pendingPaths.size > 0) reruns = 0;
      else if (retry.length > 0 && reruns < MAX_AUTO_RERUNS) {
        pendingFull = true;
        reruns++;
      } else if (retry.length > 0 && status.state === 'idle') {
        skipped = mergeSkipped(retry.map((p) => ({ path: p, reason: '다시 시도해도 맞추지 못함' })));
        setStatus(idleStatus({ message: status.message }));
      }
    }
    // 끝났다고 판단한 바로 그 자리에서 비워 두어, 그 뒤에 온 요청은 새 실행을 연다
    if (current?.gen === myGen) current = null;
  }

  function sync(opts: { paths?: readonly string[] } = {}): Promise<void> {
    if (opts.paths) for (const p of opts.paths) pendingPaths.add(p);
    else pendingFull = true;
    if (current && current.gen === gen) return current.done;
    const myGen = gen;
    // 멈춘 세대의 실행이 남아 있으면 그 끝을 기다렸다 시작한다. 없으면 바로 시작해 지금 쌓인 요청을 이번 실행이 가져간다
    const done = current ? current.done.then(() => loop(myGen)) : loop(myGen);
    current = { gen: myGen, done };
    return done;
  }

  return {
    sync,
    rememberConditionalWrites: (cfg, value) => probes.set(probeKey(cfg), value),
    status: () => status,
    stop: () => {
      gen++;
      pendingFull = false;
      pendingPaths.clear();
      setStatus({ state: 'off' });
    },
    flush,
  };
}
