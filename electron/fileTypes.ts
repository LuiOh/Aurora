// 노트 폴더에서 읽을 텍스트 파일 확장자, 새 파일 형식 목록, 훑기·미리보기 판단을 모은 순수 함수 (렌더러와 메인 프로세스가 함께 쓴다)

/** 새 파일을 만들 때 고르는 형식. 맨 앞이 기본값 */
export const NOTE_FORMATS: readonly { ext: string; label: string }[] = [
  { ext: 'md', label: '마크다운 (.md)' },
  { ext: 'txt', label: '텍스트 (.txt)' },
  { ext: 'html', label: '웹 페이지 (.html)' },
  { ext: 'css', label: 'CSS (.css)' },
  { ext: 'js', label: '자바스크립트 (.js)' },
  { ext: 'json', label: 'JSON (.json)' },
  { ext: 'csv', label: 'CSV (.csv)' },
  { ext: 'xml', label: 'XML (.xml)' },
  { ext: 'yaml', label: 'YAML (.yaml)' },
  { ext: 'sql', label: 'SQL (.sql)' },
  { ext: 'sh', label: '셸 스크립트 (.sh)' },
  { ext: 'py', label: '파이썬 (.py)' },
];

/** 노트 폴더를 훑을 때 읽는 확장자 (소문자, 점 없이) */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  ...NOTE_FORMATS.map((f) => f.ext),
  'markdown', 'htm', 'ts', 'yml', 'log',
]);

/** 마크다운이 아닌 파일은 이보다 크면 읽지 않는다 */
export const MAX_TEXT_FILE_BYTES = 1024 * 1024;

const extOf = (name: string): string | null => {
  const file = name.slice(name.lastIndexOf('/') + 1);
  const dot = file.lastIndexOf('.');
  return dot > 0 ? file.slice(dot + 1).toLowerCase() : null;
};

/** 이름이 아는 확장자로 끝나면 확장자를 떼어 돌려준다 (대소문자 무시) */
export function splitKnownExtension(name: string): { base: string; ext: string | null } {
  const ext = extOf(name);
  if (!ext || !TEXT_EXTENSIONS.has(ext)) return { base: name, ext: null };
  return { base: name.slice(0, name.length - ext.length - 1), ext };
}

export function isMarkdownPath(p: string): boolean {
  const ext = extOf(p);
  return ext === 'md' || ext === 'markdown';
}

/** 노트 폴더에서 읽는 텍스트 파일인지 */
export function isTextPath(p: string): boolean {
  const ext = extOf(p);
  return ext !== null && TEXT_EXTENSIONS.has(ext);
}

/** 훑을 때 건너뛰는 폴더·파일 이름 (.obsidian·.git 같은 숨김과 node_modules) */
export function isSkippedEntry(name: string): boolean {
  return name.startsWith('.') || name === 'node_modules';
}

/** 읽기 전에 판단한다. 확장자가 맞아야 하고, 마크다운이 아니면 1MB 이하만 읽는다 */
export function shouldReadFile(name: string, size: number): boolean {
  if (!isTextPath(name)) return false;
  return isMarkdownPath(name) || size <= MAX_TEXT_FILE_BYTES;
}

/** 읽은 뒤 판단한다. 마크다운이 아닌데 NUL 글자가 있으면 바이너리로 보고 뺀다 */
export function shouldKeepContent(name: string, content: string): boolean {
  return isMarkdownPath(name) || !content.includes('\0');
}

/** 미리보기 방식. 경로가 없는 새 탭과 마크다운은 마크다운, html은 HTML 그대로, 나머지는 글자 그대로 */
export function previewMode(path: string | null): 'markdown' | 'html' | 'plain' {
  if (!path || isMarkdownPath(path)) return 'markdown';
  const ext = extOf(path);
  return ext === 'html' || ext === 'htm' ? 'html' : 'plain';
}
