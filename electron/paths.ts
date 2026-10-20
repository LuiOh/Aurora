// 메인 프로세스가 화면에 넘기는 파일 경로를 / 구분자로 맞추고 file:// URL로 바꾸는 함수 (윈도우 대응)

/**
 * 윈도우 경로의 \ 를 / 로 바꾸고 끝의 구분자를 뗀다. 화면 코드는 늘 / 경로만 다룬다.
 * Node의 fs는 윈도우에서도 / 경로를 받으므로 그대로 다시 넘겨도 된다.
 */
export function toSlash(p: string): string {
  const s = p.replace(/\\/g, '/');
  // 루트(/, C:/)는 그대로 둔다
  if (s === '/' || /^[A-Za-z]:\/$/.test(s)) return s;
  return s.replace(/\/+$/, '');
}

/** 로컬 파일 경로(/ 구분자)를 file:// URL로 바꾼다. 윈도우 드라이브(C:)는 그대로 둔다 */
export function fileUrl(path: string): string {
  const parts = path.split('/').map((s, i) => (i === 0 && /^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s)));
  const joined = parts.join('/');
  return joined.startsWith('/') ? `file://${joined}` : `file:///${joined}`;
}
