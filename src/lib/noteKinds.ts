// 날짜·주제·목차 노트의 저장 폴더 설정과 주제·목차 노트의 첫 내용 틀

export type NoteKind = 'topic' | 'moc';

export const NOTE_KIND_LABELS: Record<NoteKind, string> = { topic: '주제', moc: '목차' };

/** 노트 종류별 저장 폴더. 노트 폴더 기준 상대 경로 */
export interface NoteFolders {
  daily: string;
  topic: string;
  moc: string;
}

export const DEFAULT_FOLDERS: NoteFolders = { daily: 'daily', topic: '주제', moc: '목차' };

/** 저장 위치 설정 파일. 노트 폴더 안 숨김 폴더라 노트 색인에는 잡히지 않는다 */
export const FOLDERS_FILE = '.aurora/folders.json';

/** 윈도우 파일 이름에 쓸 수 없는 글자. 맥에서 만든 노트도 윈도우에서 열리도록 어디서나 막는다 */
export const INVALID_NAME_CHARS = /[<>:"|?*\\]/;

/** 폴더 이름을 다듬는다. 비었거나 숨김 폴더, 노트 폴더 밖을 가리키거나 윈도우에서 못 쓰는 글자가 있으면 null */
export function cleanFolder(s: string): string | null {
  const parts = s.split('/').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0 || parts.some((p) => p === '..' || p.startsWith('.') || INVALID_NAME_CHARS.test(p))) return null;
  return parts.join('/');
}

/**
 * 저장 위치 입력을 노트 폴더 기준 폴더로 바꾼다. 전체 경로(맥 /…, 윈도우 C:\…)와 상대 경로를 모두 받는다.
 * 노트 폴더 밖이면 링크·검색에 잡히지 않으므로 받지 않는다
 */
export function folderFromInput(root: string, input: string): { folder: string } | { error: string } {
  const s = input.trim().replace(/\\/g, '/');
  const isAbs = s.startsWith('/') || /^[A-Za-z]:\//.test(s);
  const base = root.replace(/\/+$/, '');
  // 윈도우 경로(C:/…)는 대소문자를 가리지 않는다
  const fold = (p: string) => (/^[A-Za-z]:\//.test(base) ? p.toLowerCase() : p);
  if (isAbs && fold(s.replace(/\/+$/, '')) === fold(base)) return { error: '노트 폴더 바로 아래가 아니라 그 안의 폴더를 골라야 합니다.' };
  if (isAbs && !fold(s).startsWith(fold(`${base}/`))) return { error: `노트 폴더(${base}) 안의 폴더만 쓸 수 있습니다. 다른 곳을 쓰려면 노트 폴더부터 바꾸세요.` };
  const folder = cleanFolder(isAbs ? s.slice(base.length + 1) : s);
  return folder ? { folder } : { error: '폴더 이름이 비었거나, .으로 시작하거나, 노트 폴더 밖을 가리키거나, < > : " | ? * 같은 쓸 수 없는 글자가 있습니다.' };
}

/** 설정 파일 내용을 읽는다. 없거나 잘못된 값은 기본 폴더로 채운다 */
export function parseFolders(json: string | null): NoteFolders {
  let raw: Record<string, unknown> = {};
  try {
    raw = json ? JSON.parse(json) : {};
  } catch {
    // 깨진 설정 파일은 기본값으로 쓴다
  }
  const pick = (k: keyof NoteFolders) => (typeof raw[k] === 'string' && cleanFolder(raw[k] as string)) || DEFAULT_FOLDERS[k];
  return { daily: pick('daily'), topic: pick('topic'), moc: pick('moc') };
}

/** 노트 폴더 기준 경로. 이름에 폴더가 들어 있거나 folder가 비었으면 이름 그대로 쓰고, 확장자(기본 md)가 없으면 붙인다 */
export function kindNotePath(folder: string, name: string, ext = 'md'): string {
  const rel = name.includes('/') || !folder ? name : `${folder}/${name}`;
  return rel.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? rel : `${rel}.${ext}`;
}

/** 형식별 새 파일 첫 내용. md는 제목 한 줄, html은 최소 HTML5 틀, 나머지는 빈 파일 */
export function formatContent(ext: string, title: string): string {
  const e = ext.toLowerCase();
  if (e === 'md' || e === 'markdown') return `# ${title}\n\n`;
  if (e === 'html' || e === 'htm') {
    const t = title.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
    return ['<!DOCTYPE html>', '<html lang="ko">', '<head>', '  <meta charset="utf-8">', `  <title>${t}</title>`, '</head>', '<body>', '', '</body>', '</html>', ''].join('\n');
  }
  return '';
}

export function kindNoteContent(kind: NoteKind, title: string): string {
  if (kind === 'topic') {
    return [`# ${title}`, '', '#주제', '', '## 요약', '- ', '', '## 내용', '- ', '', '## 관련', '- ', ''].join('\n');
  }
  return [`# ${title}`, '', '#목차', '', '## 주제', '- [[]]', ''].join('\n');
}
