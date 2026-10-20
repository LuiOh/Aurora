// 메뉴 명령 목록과 기본 단축키, 키 입력을 Electron accelerator로 바꾸는 순수 함수 모음 (메인·렌더러 공용)

export interface CommandDef {
  id: string;
  label: string;
  group: string;
  /** Electron accelerator 형식. 빈 문자열이면 기본 단축키 없음 */
  key: string;
}

export const COMMANDS: CommandDef[] = [
  { id: 'file:new', label: '새 탭', group: 'File', key: 'CmdOrCtrl+N' },
  { id: 'file:open', label: '열기…', group: 'File', key: 'CmdOrCtrl+O' },
  { id: 'file:save', label: '저장', group: 'File', key: 'CmdOrCtrl+S' },
  { id: 'file:save-as', label: '다른 이름으로 저장…', group: 'File', key: 'CmdOrCtrl+Shift+S' },
  { id: 'file:close-tab', label: '탭 닫기', group: 'File', key: 'CmdOrCtrl+W' },
  { id: 'edit:undo', label: '실행 취소', group: 'Edit', key: 'CmdOrCtrl+Z' },
  { id: 'edit:redo', label: '다시 실행', group: 'Edit', key: 'CmdOrCtrl+Shift+Z' },
  { id: 'edit:select-all', label: '모두 선택', group: 'Edit', key: 'CmdOrCtrl+A' },
  { id: 'edit:find', label: '찾기', group: 'Edit', key: 'CmdOrCtrl+F' },
  { id: 'edit:replace', label: '바꾸기', group: 'Edit', key: 'CmdOrCtrl+Alt+F' },
  { id: 'edit:insert-numbers', label: '선택한 줄마다 번호 넣기…', group: 'Edit', key: 'CmdOrCtrl+Alt+N' },
  { id: 'view:toggle-wrap', label: '줄 바꿈 켜기/끄기', group: 'View', key: 'Alt+Z' },
  { id: 'view:toggle-whitespace', label: '공백 문자 표시 켜기/끄기', group: 'View', key: '' },
  { id: 'compare:tabs', label: '현재 탭과 다른 탭 비교…', group: 'Compare', key: 'CmdOrCtrl+Alt+D' },
  { id: 'compare:clipboard', label: '현재 탭과 클립보드 비교', group: 'Compare', key: 'CmdOrCtrl+Alt+V' },
  { id: 'compare:files', label: '디스크의 두 파일 비교…', group: 'Compare', key: '' },
  { id: 'compare:mark', label: '현재 탭을 비교 원본으로 지정', group: 'Compare', key: 'CmdOrCtrl+1' },
  { id: 'compare:with-marked', label: '비교 원본과 현재 탭 비교', group: 'Compare', key: 'CmdOrCtrl+Shift+C' },
  { id: 'compare:next', label: '다음 차이', group: 'Compare', key: 'F7' },
  { id: 'compare:prev', label: '이전 차이', group: 'Compare', key: 'Shift+F7' },
  { id: 'compare:toggle-whitespace', label: '공백 무시 켜기/끄기', group: 'Compare', key: '' },
  { id: 'compare:toggle-case', label: '대소문자 무시 켜기/끄기', group: 'Compare', key: '' },
  // Esc는 편집기 안의 찾기 창·멀티 커서 해제와 겹치므로 메뉴 단축키로 두지 않는다 (렌더러가 따로 처리)
  { id: 'compare:close', label: '비교 닫기', group: 'Compare', key: '' },
  { id: 'tools:json-format', label: 'JSON 정리', group: 'Tools', key: 'CmdOrCtrl+Alt+J' },
  { id: 'tools:json-minify', label: 'JSON 압축', group: 'Tools', key: '' },
  { id: 'tools:xml-format', label: 'XML 정리', group: 'Tools', key: 'CmdOrCtrl+Alt+X' },
  { id: 'tools:xml-minify', label: 'XML 압축', group: 'Tools', key: '' },
  { id: 'notes:today', label: '오늘 노트', group: 'Notes', key: 'CmdOrCtrl+T' },
  { id: 'notes:toggle-task', label: '체크박스 토글', group: 'Notes', key: 'CmdOrCtrl+Enter' },
  { id: 'view:toggle-sidebar', label: '노트 사이드바 켜기/끄기', group: 'Notes', key: 'CmdOrCtrl+B' },
  { id: 'view:toggle-preview', label: '마크다운 미리보기 켜기/끄기', group: 'Notes', key: 'CmdOrCtrl+Shift+V' },
  { id: 'notes:quick-open', label: '노트 빠르게 열기…', group: 'Notes', key: 'CmdOrCtrl+P' },
  { id: 'notes:search', label: '노트 전체 검색…', group: 'Notes', key: 'CmdOrCtrl+Shift+F' },
  { id: 'notes:graph', label: '그래프 보기 켜기/끄기', group: 'Notes', key: 'CmdOrCtrl+Alt+G' },
  { id: 'notes:follow-link', label: '커서의 [[링크]] 따라가기', group: 'Notes', key: 'CmdOrCtrl+Alt+Enter' },
  { id: 'notes:choose-dir', label: '노트 폴더 바꾸기…', group: 'Notes', key: '' },
  { id: 'notes:folders', label: '노트 저장 위치…', group: 'Notes', key: '' },
  { id: 'app:keybindings', label: '단축키 설정…', group: 'Aurora', key: 'CmdOrCtrl+,' },
];

/** 잘라내기·복사처럼 시스템 역할 메뉴가 쓰는 키. 다른 명령에 줄 수 없다 */
export const RESERVED: Record<string, string> = {
  'CmdOrCtrl+X': '잘라내기',
  'CmdOrCtrl+C': '복사',
  'CmdOrCtrl+V': '붙여넣기',
  'CmdOrCtrl+Q': '종료',
  'CmdOrCtrl+H': '숨기기',
  'CmdOrCtrl+Alt+H': '다른 앱 숨기기',
  'CmdOrCtrl+M': '최소화',
  'CmdOrCtrl+=': '확대',
  'CmdOrCtrl+-': '축소',
  'CmdOrCtrl+0': '원래 크기',
  'CmdOrCtrl+Alt+I': '개발자 도구',
};

/** 사용자가 바꾼 단축키만 담는다. 빈 문자열은 단축키를 지운 것 */
export type KeyOverrides = Record<string, string>;

export function resolveBindings(overrides: KeyOverrides): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of COMMANDS) out[c.id] = c.id in overrides ? overrides[c.id] : c.key;
  return out;
}

/** 기본값과 같은 항목은 빼고 바뀐 것만 남긴다 */
export function toOverrides(bindings: Record<string, string>): KeyOverrides {
  const out: KeyOverrides = {};
  for (const c of COMMANDS) if (c.id in bindings && bindings[c.id] !== c.key) out[c.id] = bindings[c.id];
  return out;
}

export interface KeyInput {
  code: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
}

const CODE_KEYS: Record<string, string> = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Enter: 'Enter', Escape: 'Escape', Space: 'Space', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`',
};

/**
 * 키 입력을 accelerator 문자열로 바꾼다. 글자 대신 물리 키(code)를 쓰므로 ⌥ 조합으로 특수문자가 나와도 키를 바로 알 수 있다.
 * 수정키만 눌렀으면 null, 글자 키를 수정키 없이(또는 ⇧만) 누르면 타이핑과 겹치므로 error를 돌려준다.
 */
export function inputToAccelerator(input: KeyInput, isMac = true): { accel: string } | { error: string } | null {
  let key: string | undefined;
  if (/^Key[A-Z]$/.test(input.code)) key = input.code.slice(3);
  else if (/^Digit\d$/.test(input.code)) key = input.code.slice(5);
  else if (/^F\d{1,2}$/.test(input.code)) key = input.code;
  else key = CODE_KEYS[input.code];
  if (!key) return null;

  const cmd = isMac ? input.meta : input.control;
  const ctrl = isMac && input.control;
  const standalone = /^F\d{1,2}$/.test(key) || key === 'Escape';
  if (!standalone && !cmd && !ctrl && !input.alt) {
    return { error: isMac ? '글자 키는 ⌘, ⌃, ⌥ 중 하나와 함께 눌러야 합니다.' : '글자 키는 Ctrl이나 Alt와 함께 눌러야 합니다.' };
  }
  const parts: string[] = [];
  if (cmd) parts.push('CmdOrCtrl');
  if (ctrl) parts.push('Ctrl');
  if (input.alt) parts.push('Alt');
  if (input.shift) parts.push('Shift');
  parts.push(key);
  return { accel: parts.join('+') };
}

const KEY_SYMBOLS: Record<string, string> = {
  Up: '↑', Down: '↓', Left: '←', Right: '→', Enter: '↩', Escape: 'Esc', Backspace: '⌫', Delete: '⌦', Tab: '⇥',
};

const WIN_KEY_NAMES: Record<string, string> = { Up: '↑', Down: '↓', Left: '←', Right: '→', Escape: 'Esc' };

/** accelerator를 맥은 ⌃⌥⇧⌘ 기호로, 윈도우·리눅스는 Ctrl+Alt+Shift+키 글자로 바꾼다 */
export function acceleratorLabel(accel: string, isMac = true): string {
  if (!accel) return '';
  const parts = accel.split('+');
  // '+' 키 자체는 split하면 빈 조각이 생기므로 따로 처리한다
  const key = accel.endsWith('++') ? '+' : parts[parts.length - 1];
  const mods = new Set(parts.slice(0, accel.endsWith('++') ? -2 : -1));
  if (!isMac) {
    const names: string[] = [];
    if (mods.has('CmdOrCtrl') || mods.has('Ctrl') || mods.has('Cmd')) names.push('Ctrl');
    if (mods.has('Alt')) names.push('Alt');
    if (mods.has('Shift')) names.push('Shift');
    names.push(WIN_KEY_NAMES[key] ?? key);
    return names.join('+');
  }
  let out = '';
  if (mods.has('Ctrl')) out += '⌃';
  if (mods.has('Alt')) out += '⌥';
  if (mods.has('Shift')) out += '⇧';
  if (mods.has('CmdOrCtrl') || mods.has('Cmd')) out += '⌘';
  return out + (KEY_SYMBOLS[key] ?? key);
}

/** 같은 accelerator를 쓰는 다른 명령 ID */
export function findConflict(bindings: Record<string, string>, commandId: string, accel: string): string | null {
  if (!accel) return null;
  for (const [id, a] of Object.entries(bindings)) if (id !== commandId && a === accel) return id;
  return null;
}

/** 실행 취소·다시 실행·모두 선택은 입력란과 편집기가 스스로 처리하게 둔다 */
const PASS_THROUGH = new Set(['edit:undo', 'edit:redo', 'edit:select-all']);

/**
 * 키 입력에 묶인 명령 ID. 편집기가 키를 먼저 써 버리지 않도록 메뉴보다 앞에서 명령을 고를 때 쓴다.
 * 묶인 명령이 없거나 편집기에 맡길 명령이면 null.
 */
export function commandForInput(bindings: Record<string, string>, input: KeyInput, isMac = true): string | null {
  const res = inputToAccelerator(input, isMac);
  if (!res || !('accel' in res)) return null;
  const id = Object.keys(bindings).find((k) => bindings[k] === res.accel);
  return id && !PASS_THROUGH.has(id) ? id : null;
}
