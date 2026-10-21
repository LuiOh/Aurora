// 디스크가 기준과 달라 쓰지 못했을 때 다시 읽은 내용 위에 사용자의 변경을 다시 얹는 순수 함수

/**
 * want 줄(처음 읽을 때의 할 일 줄)을 끝낸 일로 바꾼 전체 텍스트. 그 줄이 같은 자리에 없으면 같은 내용의 줄을 하나만 찾아 고친다.
 * 찾지 못하거나 여럿이면(어느 줄인지 모르면) null
 */
export function markTaskDone(text: string, line: number, want: string): string | null {
  const lines = text.split('\n');
  let at = lines[line] === want ? line : -1;
  if (at < 0) {
    const found = lines.flatMap((l, i) => (l === want ? [i] : []));
    if (found.length !== 1) return null;
    at = found[0];
  }
  if (!/\[ \]/.test(lines[at])) return null;
  lines[at] = lines[at].replace(/\[ \]/, '[x]');
  return lines.join('\n');
}

/** before에서 after로 사용자가 바꾼 칸만 base(다시 읽은 디스크 값)에 얹는다 */
export function applyChangedFields<T extends object>(base: T, before: T, after: T): T {
  const out = { ...base };
  for (const key of Object.keys(after) as (keyof T)[]) {
    if (after[key] !== before[key]) out[key] = after[key];
  }
  return out;
}
