// 노트 폴더 경로와 버킷 키를 서로 바꾸고, 동기화 대상·충돌 사본 이름·대소문자 겹침을 판단하는 순수 함수
import { isTextPath } from '../fileTypes';

const cleanPath = (p: string): string =>
  p.normalize('NFC').replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');

export function normalizePrefix(prefix: string): string {
  const p = cleanPath(prefix).replace(/\/+$/, '');
  return p === '' ? '' : `${p}/`;
}

export function toKey(prefix: string, rel: string): string {
  return normalizePrefix(prefix) + cleanPath(rel);
}

/** 접두사 밖의 키나 접두사 자체(폴더 표시 객체)는 null */
export function toRel(prefix: string, key: string): string | null {
  const p = normalizePrefix(prefix);
  const k = key.normalize('NFC');
  if (!k.startsWith(p)) return null;
  const rel = k.slice(p.length);
  return rel === '' || rel.endsWith('/') ? null : rel;
}

const isTempName = (name: string): boolean =>
  name.startsWith('~$') || name.toLowerCase().endsWith('.tmp') || name === '.DS_Store' || name === 'Thumbs.db';

// U+0000–U+001F, U+007F. 목록을 url 인코딩 없이 받으므로 XML에 담을 수 없는 이름은 다루지 않는다
const hasControlChar = (s: string): boolean => /[\u0000-\u001f\u007f]/.test(s);

const BUNDLE_SEGMENT = /(\.(app|framework|bundle|download)|^__macosx)$/i;

/** 앱 묶음(.app 등)·내려받는 중 폴더·압축 해제 찌꺼기(__MACOSX)처럼 들어가지도 올리지도 않는 이름 (대소문자 무시) */
export const isBundleSegment = (seg: string): boolean => BUNDLE_SEGMENT.test(seg);

export function isSyncable(rel: string): boolean {
  if (hasControlChar(rel)) return false;
  const segs = cleanPath(rel).split('/');
  const name = segs[segs.length - 1];
  if (name === '' || isTempName(name) || segs.includes('node_modules') || segs.some(isBundleSegment)) return false;
  if (segs[0] === '.aurora') {
    if (segs.length === 2) return name === 'folders.json';
    return segs[1] === 'chats' && !segs.slice(2).some((s) => s.startsWith('.'));
  }
  if (segs.some((s) => s.startsWith('.'))) return false;
  if (segs.slice(0, -1).includes('첨부')) return true;
  return isTextPath(rel);
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `이름 (충돌 기기 MM-DD HHmm).ext`. 같은 이름이 이미 있으면 n(2부터)을 붙여 고른다 */
export function conflictName(rel: string, device: string, date: Date, n = 1): string {
  const clean = cleanPath(rel);
  const slash = clean.lastIndexOf('/');
  const dir = clean.slice(0, slash + 1);
  const file = clean.slice(slash + 1);
  const dot = file.lastIndexOf('.');
  const base = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : '';
  const dev = device.normalize('NFC').replace(/[/\\:*?"<>|]/g, '').trim() || '기기';
  const stamp = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}`;
  const suffix = n > 1 ? ` ${n}` : '';
  return `${dir}${base} (충돌 ${dev} ${stamp}${suffix})${ext}`;
}

/** 소문자+NFC로 같아지는 서로 다른 경로 묶음 (대소문자를 가리지 않는 디스크에서 서로 덮어쓴다) */
export function findCaseCollisions(rels: readonly string[]): string[][] {
  const groups = new Map<string, Set<string>>();
  for (const rel of rels) {
    const fold = rel.normalize('NFC').toLowerCase();
    const g = groups.get(fold) ?? new Set<string>();
    g.add(rel);
    groups.set(fold, g);
  }
  return [...groups.values()].filter((g) => g.size > 1).map((g) => [...g].sort());
}
