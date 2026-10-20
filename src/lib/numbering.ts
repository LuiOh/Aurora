// 선택한 줄(커서)마다 넣을 일련번호를 만드는 순수 함수 모음

export interface NumberingOptions {
  start: number;
  step: number;
  /** true면 가장 긴 번호의 자릿수에 맞춰 앞을 0으로 채운다 */
  zeroPad: boolean;
}

/** count개의 번호 문자열을 만든다 */
export function generateNumbers(count: number, opts: NumberingOptions): string[] {
  const nums: number[] = [];
  for (let i = 0; i < count; i++) nums.push(opts.start + i * opts.step);
  if (!opts.zeroPad) return nums.map(String);
  const width = Math.max(...nums.map((n) => String(Math.abs(n)).length));
  return nums.map((n) => (n < 0 ? '-' : '') + String(Math.abs(n)).padStart(width, '0'));
}

/** 입력란의 문자열을 검사해 옵션으로 바꾼다. 잘못된 값이면 null */
export function parseNumberingInput(start: string, step: string, zeroPad: boolean): NumberingOptions | null {
  const s = Number(start.trim());
  const t = Number(step.trim());
  if (start.trim() === '' || step.trim() === '') return null;
  if (!Number.isInteger(s) || !Number.isInteger(t)) return null;
  return { start: s, step: t, zeroPad };
}
