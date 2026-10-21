// 로컬 파일·버킷 객체·지난 동기화 상태를 비교해 할 일을 정하는 순수 동기화 계획기 (삭제는 절대 만들지 않는다)
import { conflictName, findCaseCollisions } from './keys';
import { stripEtag } from './xml';
import type { LocalFile, PlanAction, RemoteObject, SyncState } from './types';

export interface PlanOptions {
  device: string;
  now: Date;
  conditionalWrites: boolean;
}

/** 단일 PUT의 ETag는 MD5와 같다. 멀티파트('-' 포함)는 내용 해시를 알 수 없다 */
export function etagHash(etag: string): string | null {
  const e = stripEtag(etag).toLowerCase();
  return /^[0-9a-f]{32}$/.test(e) ? e : null;
}

const sameContent = (md5: string, etag: string): boolean => {
  const h = etagHash(etag);
  return h !== null && h === md5.toLowerCase();
};

const byRel = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** raw는 디스크 이름이나 저장소 키 그대로다. NFC로 같아지는 서로 다른 raw가 있으면 dupes에 넣는다 */
function indexByNfc<T extends { rel: string; raw: string }>(items: readonly T[], dupes: Set<string>): Map<string, T> {
  const out = new Map<string, T>();
  const raw = new Map<string, string>();
  for (const item of items) {
    const rel = item.rel.normalize('NFC');
    const prev = raw.get(rel);
    if (prev !== undefined && prev !== item.raw) dupes.add(rel);
    raw.set(rel, item.raw);
    out.set(rel, { ...item, rel });
  }
  return out;
}

/** remote의 key는 이미 toRel로 바꾼 노트 폴더 경로여야 한다 */
export function planSync(
  local: readonly LocalFile[],
  remote: readonly RemoteObject[],
  state: SyncState,
  opts: PlanOptions,
): PlanAction[] {
  const dupes = new Set<string>();
  const localMap = indexByNfc(local.map((l) => ({ ...l, raw: l.rel })), dupes);
  const remoteMap = indexByNfc(remote.map((r) => ({ rel: r.key, raw: r.rawKey ?? r.key, etag: stripEtag(r.etag) })), dupes);
  const all = [...new Set([...localMap.keys(), ...remoteMap.keys()])].sort(byRel);
  const taken = new Set(all);

  const skipped = new Map<string, string>();
  for (const rel of dupes) skipped.set(rel, '원격에 같은 이름이 두 형태로 있음 (유니코드 정규화)');
  for (const group of findCaseCollisions(all)) {
    for (const rel of group) skipped.set(rel, `대소문자만 다른 이름이 있음 (${group.join(', ')})`);
  }

  const pickCopyName = (rel: string): string => {
    for (let n = 1; ; n++) {
      const name = conflictName(rel, opts.device, opts.now, n);
      if (!taken.has(name)) {
        taken.add(name);
        return name;
      }
    }
  };
  const uploadNew = (rel: string): PlanAction =>
    opts.conditionalWrites ? { type: 'upload', rel, ifNoneMatch: '*' } : { type: 'upload', rel };

  const actions: PlanAction[] = [];
  for (const rel of all) {
    const reason = skipped.get(rel);
    if (reason !== undefined) {
      actions.push({ type: 'skip', rel, reason });
      continue;
    }
    const l = localMap.get(rel);
    const r = remoteMap.get(rel);
    const st = state[rel];
    if (l && !r) {
      actions.push(uploadNew(rel));
      continue;
    }
    if (!l && r) {
      actions.push({ type: 'download', rel, etag: r.etag });
      continue;
    }
    if (!l || !r) continue;
    const resolveBoth = (): PlanAction =>
      sameContent(l.md5, r.etag)
        ? { type: 'record', rel, md5: l.md5, etag: r.etag }
        : { type: 'conflict', rel, copyRel: pickCopyName(rel), etag: r.etag };
    if (!st) {
      actions.push(resolveBoth());
      continue;
    }
    const localChanged = l.md5.toLowerCase() !== st.md5.toLowerCase();
    const remoteChanged = r.etag !== stripEtag(st.etag);
    if (!localChanged && !remoteChanged) continue;
    if (localChanged && !remoteChanged) {
      actions.push(opts.conditionalWrites ? { type: 'upload', rel, ifMatch: r.etag } : { type: 'upload', rel });
    } else if (!localChanged) {
      actions.push({ type: 'download', rel, etag: r.etag });
    } else {
      actions.push(resolveBoth());
    }
  }
  return actions;
}
