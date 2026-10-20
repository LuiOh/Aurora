// 스탠드업 형식 데일리 노트를 만들고, 지난 노트의 일감을 넘겨받고, 체크박스를 토글하는 순수 함수 모음

export const DONE_HEADING = '## 어제 한 일';
export const TODO_HEADING = '## 오늘 할 일';
export const ISSUE_HEADING = '## 이슈';
export const MEMO_HEADING = '## 메모';

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const TASK_RE = /^(\s*[-*+] )\[([ xX])\] ?(.*)$/;

/** 로컬 시간 기준 YYYY-MM-DD */
export function dateKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function isDateKey(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function weekday(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return WEEKDAYS[new Date(y, m - 1, d).getDay()];
}

/** key보다 앞선 날짜 중 가장 최근 노트를 고른다 */
export function previousKey(keys: string[], key: string): string | null {
  const before = keys.filter((k) => k < key).sort();
  return before.length ? before[before.length - 1] : null;
}

/** heading 바로 아래부터 다음 ## 제목 전까지의 줄을 돌려준다 */
function sectionLines(md: string, heading: string): string[] {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2} /.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/**
 * "오늘 할 일" 칸의 최상위 일감을 끝낸 것과 남은 것으로 나눈다.
 * 일감 아래 더 들여쓴 줄(하위 항목, 메모)은 그 일감에 붙여서 함께 옮긴다.
 */
export function splitTasks(md: string): { done: string[][]; open: string[][] } {
  const done: string[][] = [];
  const open: string[][] = [];
  let current: string[] | null = null;
  let baseIndent = 0;
  for (const line of sectionLines(md, TODO_HEADING)) {
    const m = line.match(TASK_RE);
    if (m && (!current || indentOf(line) <= baseIndent)) {
      current = [line];
      baseIndent = indentOf(line);
      (m[2] === ' ' ? open : done).push(current);
    } else if (current && line.trim() !== '' && indentOf(line) > baseIndent) {
      current.push(line);
    } else if (line.trim() !== '') {
      current = null;
    }
  }
  return { done, open };
}

/** 새 데일리 노트를 만든다. prev가 있으면 끝낸 일은 "어제 한 일"로, 남은 일은 "오늘 할 일"로 넘긴다 */
export function buildDailyNote(key: string, prev: { key: string; content: string } | null): string {
  const { done, open } = prev ? splitTasks(prev.content) : { done: [], open: [] };
  const base = (block: string[]) => indentOf(block[0]);
  // 끝낸 일은 체크박스를 떼고 평범한 목록으로 적는다
  const doneLines = done.flatMap((b) =>
    b.map((l, i) => (i === 0 ? l.slice(base(b)).replace(TASK_RE, '$1$3') : l.slice(base(b)))),
  );
  const openLines = open.flatMap((b) => b.map((l) => l.slice(base(b))));
  const lines = [
    `# ${key} (${weekday(key)})`,
    '',
    prev ? `${DONE_HEADING} (${prev.key.slice(5).replace('-', '/')})` : DONE_HEADING,
    ...(doneLines.length ? doneLines : ['- ']),
    '',
    TODO_HEADING,
    ...(openLines.length ? openLines : ['- [ ] ']),
    '',
    ISSUE_HEADING,
    '- ',
    '',
    MEMO_HEADING,
    '',
  ];
  return lines.join('\n');
}

/**
 * 체크박스를 토글한다. [ ] → [x] → [ ], 일반 목록은 [ ]를 붙이고, 일반 줄은 "- [ ] "를 붙인다.
 */
export function toggleTaskLine(line: string): string {
  const m = line.match(TASK_RE);
  if (m) return `${m[1]}[${m[2] === ' ' ? 'x' : ' '}] ${m[3]}`;
  const list = line.match(/^(\s*[-*+] )(.*)$/);
  if (list) return `${list[1]}[ ] ${list[2]}`;
  const indent = line.slice(0, indentOf(line));
  return `${indent}- [ ] ${line.trimStart()}`;
}
