// 디스크 내용이 바뀌었는지 보는 빠른 문자열 해시. 화면과 메인 프로세스가 같은 값을 쓰도록 함께 쓴다

/** 빠른 53비트 문자열 해시(cyrb53)를 16진수로. 보안용이 아니라 디스크 내용이 바뀌었는지 보는 데만 쓴다 */
export function contentHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/** 기준 해시를 건 쓰기의 결과. conflict면 디스크가 기준과 달라 쓰지 않았다 */
export type WriteResult = { ok: true } | { ok: false; conflict: true };
