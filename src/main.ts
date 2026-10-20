// 렌더러 진입점. 탭 관리, 메뉴 명령 처리, 비교 화면, 번호 넣기, JSON·XML 정리를 연결한다
import './styles.css';
import { monaco } from './monaco';
import { generateNumbers } from './lib/numbering';
import { formatJson, minifyJson, formatXml, minifyXml } from './lib/format';
import { prepareForDiff, type DiffOptions } from './lib/diffPrep';
import { languageForPath, baseName } from './lib/language';
import { buildDailyNote, dateKey, isDateKey, previousKey, toggleTaskLine } from './lib/daily';
import {
  TAG_AT_START, allTasks, backlinks, buildGraph, buildIndex, fuzzyMatch, noteName, parseNote, resolveLink,
  notesByFolder, searchVault, splitLinkText, tagCounts, unlinkedMentions, type Mention, type VaultFile, type VaultIndex,
} from './lib/vault';
import { askFolders, askNoteName, askNumbering, askTab } from './ui/modal';
import { ATTACH_FOLDER, attachmentKind, attachmentMarkdown, isAttachableFile, isAttachmentTarget, pastedImageName, uniqueName } from './lib/attachments';
import {
  DEFAULT_FOLDERS, FOLDERS_FILE, NOTE_KIND_LABELS, kindNoteContent, kindNotePath, parseFolders, type NoteFolders, type NoteKind,
} from './lib/noteKinds';
import { openKeybindings } from './ui/keybindingsModal';
import { openPicker, type PickerItem } from './ui/picker';
import { createGraphView } from './ui/graphView';
import { IS_MAC, PLATFORM } from './platform';
import { api } from './api';
import { COMMANDS, acceleratorLabel, resolveBindings } from '../electron/keybindings';
import { marked } from 'marked';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface Tab {
  id: number;
  path: string | null;
  title: string;
  model: monaco.editor.ITextModel;
  savedVersionId: number;
  viewState: monaco.editor.ICodeEditorViewState | null;
  /** 저장하기 전 탭에 붙여 넣은 첨부(첨부 폴더 안 이름 → 내용). 탭을 저장할 때 함께 쓴다 */
  pending: Map<string, Blob>;
}

const tabs: Tab[] = [];
let active: Tab | null = null;
let nextId = 1;
let untitledCount = 0;

// 플랫폼별 제목 막대 배치를 CSS가 고를 수 있게 표시한다. preload가 없으면 웹이다
document.documentElement.dataset.platform = PLATFORM;
void api?.getAccentColor().then((hex) => {
  if (hex) document.documentElement.style.setProperty('--accent', `#${hex}`);
});

// 편집기 바탕을 화면 색(styles.css의 --bg)과 맞춘 테마
monaco.editor.defineTheme('aurora-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: { 'editor.background': '#ffffff', 'editor.lineHighlightBackground': '#00000008', 'editorLineNumber.foreground': '#b0b0b5' },
});
monaco.editor.defineTheme('aurora-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: { 'editor.background': '#1e1e20', 'editor.lineHighlightBackground': '#ffffff0a', 'editorLineNumber.foreground': '#5a5a60' },
});

const dark = window.matchMedia('(prefers-color-scheme: dark)');
const theme = () => (dark.matches ? 'aurora-dark' : 'aurora-light');
dark.addEventListener('change', () => monaco.editor.setTheme(theme()));

// 맥은 SF Mono, 윈도우는 Cascadia Code·Consolas로 떨어진다
const EDITOR_FONT = "'SF Mono', Menlo, 'Cascadia Code', Consolas, 'D2Coding', monospace";

const editor = monaco.editor.create($('editor-host'), {
  automaticLayout: true,
  theme: theme(),
  fontSize: 13,
  fontFamily: EDITOR_FONT,
  lineHeight: 20,
  padding: { top: 10 },
  renderLineHighlight: 'line',
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
  minimap: { enabled: true },
  // ⌥ 클릭으로 커서 추가, ⌥⇧ 드래그로 열 선택
  multiCursorModifier: 'alt',
  renderWhitespace: 'none',
  wordWrap: 'off',
  dragAndDrop: true,
});

// ───────── 탭 ─────────

function isDirty(tab: Tab) {
  return tab.model.getAlternativeVersionId() !== tab.savedVersionId;
}

function renderTabs() {
  const bar = $('tabbar');
  bar.innerHTML = '';
  // 윈도우(제목 막대를 탭 막대로 씀)와 웹에는 메뉴 막대가 없으므로 맨 앞에 메뉴 버튼을 둔다
  if (PLATFORM === 'win' || PLATFORM === 'web') {
    const menuBtn = document.createElement('button');
    menuBtn.className = 'app-menu';
    menuBtn.textContent = '☰';
    menuBtn.title = '메뉴';
    menuBtn.onclick = () => {
      const r = menuBtn.getBoundingClientRect();
      api.popupMenu(r.left, r.bottom);
    };
    bar.appendChild(menuBtn);
  }
  const sideBtn = document.createElement('button');
  sideBtn.className = 'app-menu';
  sideBtn.classList.toggle('on', !$('sidebar').hidden);
  sideBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1.5" y="2.5" width="13" height="11" rx="2.5"/><path d="M6 2.5v11"/></svg>';
  sideBtn.title = $('sidebar').hidden ? '사이드바 보이기' : '사이드바 숨기기';
  sideBtn.onclick = () => void toggleSidebar();
  bar.appendChild(sideBtn);
  for (const tab of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab === active ? ' active' : '');
    el.title = tab.path ?? tab.title;
    const badge = tab.id === markedTabId ? '<span class="badge">원본</span>' : '';
    el.innerHTML = `<span class="dirty">${isDirty(tab) ? '●' : ''}</span>${badge}<span class="name"></span><span class="close">×</span>`;
    el.querySelector('.name')!.textContent = tab.title;
    el.onclick = () => activate(tab);
    (el.querySelector('.close') as HTMLElement).onclick = (e) => {
      e.stopPropagation();
      void closeTab(tab);
    };
    bar.appendChild(el);
  }
  document.title = active ? `${active.title} — Aurora` : 'Aurora';
}

function addTab(path: string | null, content: string): Tab {
  const title = path ? baseName(path) : `제목 없음 ${++untitledCount}`;
  const model = monaco.editor.createModel(content, languageForPath(path));
  const tab: Tab = { id: nextId++, path, title, model, savedVersionId: model.getAlternativeVersionId(), viewState: null, pending: new Map() };
  model.onDidChangeContent(() => {
    renderTabs();
    if (tab === active) schedulePreview();
    if (tab.path && relPath(tab.path)) onVaultEdit();
  });
  tabs.push(tab);
  activate(tab);
  return tab;
}

function activate(tab: Tab) {
  closeCompare();
  closeGraph();
  if (active) active.viewState = editor.saveViewState();
  active = tab;
  editor.setModel(tab.model);
  if (tab.viewState) editor.restoreViewState(tab.viewState);
  editor.focus();
  renderTabs();
  renderPreview();
  renderCalendar();
  renderSidePanel();
  decorateLinks();
}

async function closeTab(tab: Tab) {
  if (isDirty(tab) && !(await api.confirmDiscard(`"${tab.title}"의 변경 사항을 저장하지 않고 닫을까요?`))) return;
  const idx = tabs.indexOf(tab);
  tabs.splice(idx, 1);
  if (markedTabId === tab.id) markedTabId = null;
  if (active === tab) {
    active = null;
    if (tabs.length === 0) addTab(null, '');
    else activate(tabs[Math.min(idx, tabs.length - 1)]);
  }
  tab.model.dispose();
  renderTabs();
}

function openContent(path: string, content: string) {
  const existing = tabs.find((t) => t.path === path);
  if (existing) return activate(existing);
  // 아무것도 안 쓴 빈 새 탭 하나만 있으면 그 자리를 대신한다
  if (tabs.length === 1 && !tabs[0].path && !isDirty(tabs[0]) && tabs[0].model.getValueLength() === 0) {
    const blank = tabs[0];
    tabs.length = 0;
    active = null;
    blank.model.dispose();
  }
  addTab(path, content);
}

async function openFiles() {
  for (const f of await api.openFiles(true)) openContent(f.path, f.content);
}

async function save(tab: Tab, saveAs = false) {
  let path = tab.path;
  if (!path || saveAs) {
    path = await api.saveDialog(tab.path ?? tab.title + (tab.model.getLanguageId() === 'markdown' ? '.md' : '.txt'));
    if (!path) return;
  }
  try {
    await savePending(tab, path);
    await api.writeFile(path, tab.model.getValue());
  } catch (err) {
    return status(`저장하지 못했습니다: ${(err as Error).message}`);
  }
  tab.path = path;
  tab.title = baseName(path);
  tab.savedVersionId = tab.model.getAlternativeVersionId();
  monaco.editor.setModelLanguage(tab.model, languageForPath(path));
  status(`저장했습니다: ${path}`);
  renderTabs();
  if (relPath(path)) await refreshVault();
}

/**
 * 저장하기 전에 붙여 넣은 첨부를 저장할 노트 옆 첨부 폴더에 쓴다. 지운 링크의 첨부는 버리고,
 * 같은 이름이 이미 있으면 번호를 붙인 이름으로 쓰고 노트의 링크도 그 이름으로 고친다
 */
async function savePending(tab: Tab, notePath: string) {
  if (tab.pending.size === 0) return;
  const dir = `${dirOfPath(notePath)}/${ATTACH_FOLDER}`;
  for (const [name, blob] of tab.pending) {
    const ref = `${ATTACH_FOLDER}/${name}`;
    const matches = tab.model.findMatches(ref, false, false, true, null, false);
    if (matches.length === 0) continue;
    const final = await uniqueName(name, (n) => api.exists(`${dir}/${n}`));
    await api.writeBinary(`${dir}/${final}`, new Uint8Array(await blob.arrayBuffer()));
    if (final !== name) {
      tab.model.pushEditOperations([], matches.map((r) => ({ range: r.range, text: `${ATTACH_FOLDER}/${final}` })), () => null);
    }
  }
  tab.pending.clear();
}

// 창 어디에 끌어다 놓아도 파일을 연다. 마크다운 노트 편집기 위에 놓은 이미지·영상·문서는 노트에 첨부한다
window.addEventListener('dragover', (e) => e.preventDefault(), true);
window.addEventListener(
  'drop',
  async (e) => {
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const onNote = !!active && (active.model.getLanguageId() === 'markdown' || !active.path) && !!(e.target as HTMLElement).closest('#editor-host');
    const attach = onNote ? files.filter((f) => isAttachableFile(f.name)) : [];
    if (attach.length) {
      const target = editor.getTargetAtClientPoint(e.clientX, e.clientY);
      if (target?.position) editor.setPosition(target.position);
      await attachFiles(attach);
    }
    for (const file of files.filter((f) => !attach.includes(f))) {
      const path = api.pathForFile(file);
      openContent(path, await api.readFile(path));
    }
  },
  true,
);

// ───────── 첨부 (붙여넣기·끌어다 놓기) ─────────

const dirOfPath = (p: string) => p.slice(0, p.lastIndexOf('/'));
const PENDING = 'pending:';

/**
 * 첨부 대상을 파일 경로로 바꾼다. ![](첨부/a.png)는 노트 기준 상대 경로로 본다.
 * 옵시디언식 ![[첨부/a.png]]는 노트 폴더 안 노트면 노트 폴더 기준으로 본다
 */
function attachmentPath(target: string, wiki = false): string | null {
  const note = active?.path;
  if (!note) {
    // 저장하지 않은 탭은 들고 있는 첨부를 pending:이름으로 가리킨다
    const name = target.replace(/^\.\//, '').slice(ATTACH_FOLDER.length + 1);
    return target.replace(/^\.\//, '').startsWith(`${ATTACH_FOLDER}/`) && active?.pending.has(name) ? `${PENDING}${name}` : null;
  }
  if (wiki && target.includes('/') && relPath(note) !== null) return `${notesDir}/${target}`;
  return `${dirOfPath(note)}/${target.replace(/^\.\//, '')}`;
}

/**
 * 파일을 노트 옆 첨부 폴더에 저장하고 커서 자리에 링크를 넣는다.
 * 저장하지 않은 탭이면 첨부를 탭에 들고 있다가 탭을 저장할 때 함께 쓴다
 */
async function attachFiles(files: File[]) {
  const tab = active;
  if (!tab) return;
  const dir = tab.path ? `${dirOfPath(tab.path)}/${ATTACH_FOLDER}` : null;
  const lines: string[] = [];
  try {
    for (const file of files) {
      // 클립보드 이미지는 이름이 image.png 같은 기본값이라 시각을 넣은 이름을 붙인다
      const raw = file.type.startsWith('image/') && /^image\.\w+$/.test(file.name) ? pastedImageName(new Date(), file.type) : file.name;
      if (!dir) {
        const name = await uniqueName(raw, (n) => tab.pending.has(n));
        tab.pending.set(name, file);
        lines.push(attachmentMarkdown(name));
        continue;
      }
      const name = await uniqueName(raw, (n) => api.exists(`${dir}/${n}`));
      const dest = `${dir}/${name}`;
      const src = PLATFORM === 'web' ? '' : api.pathForFile(file);
      if (!(src && (await api.copyFile(src, dest)))) await api.writeBinary(dest, new Uint8Array(await file.arrayBuffer()));
      lines.push(attachmentMarkdown(name));
    }
  } catch (e) {
    return status(`첨부하지 못했습니다: ${(e as Error).message}`);
  }
  if (active !== tab) return status(dir ? `${dir}에 저장했지만 다른 탭으로 옮겨서 링크는 넣지 않았습니다.` : '다른 탭으로 옮겨서 첨부하지 않았습니다.');
  // 새 탭에 붙여 넣으면 마크다운 노트로 보고 미리보기가 첨부를 보여 주게 한다
  if (!tab.path) monaco.editor.setModelLanguage(tab.model, 'markdown');
  editor.executeEdits('attach', [{ range: editor.getSelection()!, text: lines.join('\n'), forceMoveMarkers: true }]);
  editor.focus();
  status(dir ? `${lines.length}개를 ${dir}에 첨부했습니다.` : `${lines.length}개를 첨부했습니다. 탭을 저장하면 노트 옆 ${ATTACH_FOLDER} 폴더에 함께 저장됩니다.`);
}

// 클립보드의 이미지나 파인더·탐색기에서 복사한 파일을 마크다운 노트나 저장 안 한 새 탭에 붙여 넣으면 첨부한다
$('editor-host').addEventListener(
  'paste',
  (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length === 0 || !active || (active.model.getLanguageId() !== 'markdown' && active.path)) return;
    // 엑셀·웹 페이지처럼 글과 그림을 함께 복사한 경우는 글을 붙여 넣는다. 복사한 파일은 글이 파일 이름이다
    const text = e.clipboardData!.getData('text/plain');
    if (text && !files.some((f) => text.includes(f.name))) return;
    e.preventDefault();
    e.stopPropagation();
    void attachFiles(files);
  },
  true,
);

// ───────── 상태 막대 ─────────

function status(msg: string) {
  $('status-msg').textContent = msg;
}

editor.onDidChangeCursorSelection(() => {
  const sels = editor.getSelections() ?? [];
  const pos = editor.getPosition();
  const multi = sels.length > 1 ? ` · 커서 ${sels.length}개` : '';
  $('status-pos').textContent = pos ? `줄 ${pos.lineNumber}, 열 ${pos.column}${multi}` : '';
});

// ───────── 번호 넣기 ─────────

/** 번호를 넣을 위치를 구한다. 여러 줄에 걸친 선택 하나면 그 줄마다 시작 열에 넣는다 */
function numberTargets(): monaco.IRange[] {
  const model = editor.getModel()!;
  const sels = [...(editor.getSelections() ?? [])].sort((a, b) =>
    a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn,
  );
  if (sels.length === 1 && sels[0].startLineNumber !== sels[0].endLineNumber) {
    const s = sels[0];
    const ranges: monaco.IRange[] = [];
    for (let line = s.startLineNumber; line <= s.endLineNumber; line++) {
      const col = Math.min(s.startColumn, model.getLineMaxColumn(line));
      ranges.push(new monaco.Range(line, col, line, col));
    }
    return ranges;
  }
  return sels;
}

async function insertNumbers() {
  const targets = numberTargets();
  const opts = await askNumbering(targets.length);
  editor.focus();
  if (!opts) return;
  const nums = generateNumbers(targets.length, opts);
  editor.executeEdits(
    'insert-numbers',
    targets.map((range, i) => ({ range, text: nums[i], forceMoveMarkers: true })),
  );
  status(`${targets.length}곳에 번호를 넣었습니다.`);
}

// ───────── JSON·XML 정리 ─────────

function transform(name: string, fn: (s: string) => string) {
  const model = editor.getModel();
  if (!model) return;
  const sel = editor.getSelection();
  // 선택 영역이 있으면 그 부분만, 없으면 문서 전체를 바꾼다
  const range = sel && !sel.isEmpty() ? sel : model.getFullModelRange();
  try {
    const out = fn(model.getValueInRange(range));
    editor.executeEdits(name, [{ range, text: out }]);
    if (name.startsWith('json')) monaco.editor.setModelLanguage(model, 'json');
    if (name.startsWith('xml')) monaco.editor.setModelLanguage(model, 'xml');
    status(`${name} 완료`);
  } catch (err) {
    status(`${name} 실패: ${(err as Error).message}`);
  }
}

// ───────── 비교 ─────────

interface Side {
  title: string;
  model: monaco.editor.ITextModel;
  /** 비교를 위해 새로 만든 모델이면 닫을 때 정리한다 */
  owned: boolean;
}

const diffOpts: DiffOptions = { ignoreWhitespace: true, ignoreCase: false };
let compare: { left: Side; right: Side; temp: monaco.editor.ITextModel[] } | null = null;

const diffEditor = monaco.editor.createDiffEditor($('diff-host'), {
  automaticLayout: true,
  theme: theme(),
  fontSize: 13,
  fontFamily: EDITOR_FONT,
  lineHeight: 20,
  renderSideBySide: true,
  ignoreTrimWhitespace: diffOpts.ignoreWhitespace,
  originalEditable: false,
  multiCursorModifier: 'alt',
});

diffEditor.onDidUpdateDiff(() => {
  const n = diffEditor.getLineChanges()?.length ?? 0;
  $('compare-count').textContent = n === 0 ? '차이 없음' : `차이 ${n}곳`;
});

function showCompare(left: Side, right: Side) {
  closeCompare();
  closeGraph();
  compare = { left, right, temp: [] };
  $('compare-title').textContent = `${left.title}  ↔  ${right.title}`;
  $('compare-bar').hidden = false;
  $('editor-host').hidden = true;
  $('preview').hidden = true;
  $('diff-host').hidden = false;
  applyCompareModels();
}

function applyCompareModels() {
  if (!compare) return;
  // 이전 사본은 비교 편집기가 새 모델로 바뀐 뒤에 정리해야 한다
  const old = compare.temp;
  compare.temp = [];
  const view = (side: Side) => {
    if (!diffOpts.ignoreCase) return side.model;
    // 대소문자 무시는 소문자 사본끼리 비교한다 (이때 오른쪽 편집은 원본에 반영되지 않음)
    const m = monaco.editor.createModel(prepareForDiff(side.model.getValue(), diffOpts), side.model.getLanguageId());
    compare!.temp.push(m);
    return m;
  };
  diffEditor.setModel({ original: view(compare.left), modified: view(compare.right) });
  old.forEach((m) => m.dispose());
  diffEditor.updateOptions({ ignoreTrimWhitespace: diffOpts.ignoreWhitespace, readOnly: diffOpts.ignoreCase });
}

function closeCompare() {
  if (!compare) return;
  diffEditor.setModel(null);
  compare.temp.forEach((m) => m.dispose());
  for (const side of [compare.left, compare.right]) if (side.owned) side.model.dispose();
  compare = null;
  $('compare-bar').hidden = true;
  $('diff-host').hidden = true;
  $('editor-host').hidden = false;
  $('preview').hidden = !previewOn;
  editor.focus();
}

const tabSide = (tab: Tab): Side => ({ title: tab.title, model: tab.model, owned: false });
const textSide = (title: string, text: string, lang: string): Side => ({
  title,
  model: monaco.editor.createModel(text, lang),
  owned: true,
});

async function compareTabs() {
  if (!active) return;
  const others = tabs.filter((t) => t !== active);
  if (others.length === 0) return status('비교할 다른 탭이 없습니다.');
  const id = others.length === 1 ? others[0].id : await askTab(others.map((t) => ({ id: t.id, title: t.path ?? t.title })));
  const other = tabs.find((t) => t.id === id);
  if (other) showCompare(tabSide(active), tabSide(other));
}

// ⌘1로 찍어 둔 비교 원본 탭
let markedTabId: number | null = null;

function markCompareSource() {
  if (!active) return;
  markedTabId = active.id;
  renderTabs();
  status(`비교 원본: ${active.title}. 다른 탭으로 옮긴 뒤 ${keyHint('compare:with-marked')}를 누르세요.`);
}

function compareWithMarked() {
  const source = tabs.find((t) => t.id === markedTabId);
  if (!source) return status(`먼저 ${keyHint('compare:mark')}로 비교 원본 탭을 지정하세요.`);
  if (!active || source === active) return status(`비교할 다른 탭으로 옮긴 뒤 ${keyHint('compare:with-marked')}를 누르세요.`);
  showCompare(tabSide(source), tabSide(active));
}

async function compareClipboard() {
  if (!active) return;
  const clip = await api.readClipboard();
  showCompare(tabSide(active), textSide('클립보드', clip, active.model.getLanguageId()));
}

async function compareFiles() {
  const files = await api.openFiles(true);
  if (files.length === 0) return;
  let pair = files.slice(0, 2);
  if (pair.length === 1) {
    status('두 번째 파일을 고르세요.');
    const more = await api.openFiles(false);
    if (more.length === 0) return;
    pair = [pair[0], more[0]];
  }
  const [a, b] = pair;
  showCompare(
    textSide(a.path, a.content, languageForPath(a.path)),
    textSide(b.path, b.content, languageForPath(b.path)),
  );
}

function syncCompareOptionsUI() {
  ($('opt-whitespace') as HTMLInputElement).checked = diffOpts.ignoreWhitespace;
  ($('opt-case') as HTMLInputElement).checked = diffOpts.ignoreCase;
}

$('opt-whitespace').addEventListener('change', (e) => {
  diffOpts.ignoreWhitespace = (e.target as HTMLInputElement).checked;
  applyCompareModels();
});
$('opt-case').addEventListener('change', (e) => {
  diffOpts.ignoreCase = (e.target as HTMLInputElement).checked;
  applyCompareModels();
});

// ───────── 업무 노트 ─────────

let notesDir: string | null = null;
let noteKeys: string[] = [];
let folders: NoteFolders = DEFAULT_FOLDERS;
const today = new Date();
let calYear = today.getFullYear();
let calMonth = today.getMonth();

/**
 * 사이드바 아래에 노트 폴더 경로를 쓴다. 긴 경로를 왼쪽부터 자르려고 CSS를 오른쪽→왼쪽 방향으로 두었는데,
 * 그러면 맨 앞의 / 가 끝으로 밀려 보이므로 왼쪽→오른쪽 표시(LRM) 문자로 감싼다
 */
function showNotesDir(dir: string) {
  $('notes-dir').textContent = `\u200e${dir}\u200e`;
  $('notes-dir').title = dir;
}

const notePath = (key: string) => `${notesDir}/${folders.daily}/${key}.md`;

/** 노트 폴더의 저장 위치 설정을 읽고 데일리 노트 날짜 목록을 가져온다 */
async function loadNoteKeys() {
  folders = parseFolders(await api.readFile(`${notesDir}/${FOLDERS_FILE}`).catch(() => null));
  noteKeys = await api.listNotes(notesDir!, folders.daily);
}

async function changeFolders() {
  if (!(await ensureNotesDir())) return status('노트 폴더를 먼저 골라야 합니다.');
  const next = await askFolders(folders, notesDir!, PLATFORM === 'web' ? null : api.chooseFolder);
  if (!next) return;
  await api.writeFile(`${notesDir}/${FOLDERS_FILE}`, JSON.stringify(next, null, 2) + '\n');
  await loadNoteKeys();
  renderCalendar();
  await refreshVault();
  status(`저장 위치를 바꿨습니다: 날짜 ${next.daily}/, 주제 ${next.topic}/, 목차 ${next.moc}/`);
}

/** 열린 탭이 데일리 노트면 그 날짜를 돌려준다 */
function activeNoteKey(): string | null {
  if (!active?.path || !notesDir || !active.path.startsWith(`${notesDir}/${folders.daily}/`)) return null;
  const key = baseName(active.path).replace(/\.md$/, '');
  return isDateKey(key) ? key : null;
}

async function ensureNotesDir(): Promise<boolean> {
  notesDir ??= await api.getNotesDir();
  notesDir ??= await api.chooseNotesDir();
  if (!notesDir) return false;
  await loadNoteKeys();
  showNotesDir(notesDir);
  return true;
}

async function openNote(key: string) {
  if (!(await ensureNotesDir())) return status('노트 폴더를 골라야 노트를 쓸 수 있습니다.');
  const path = notePath(key);
  if (!noteKeys.includes(key)) {
    // 처음 여는 날이면 가장 최근 노트에서 일감을 넘겨받아 새로 만든다
    const prevKey = previousKey(noteKeys, key);
    const prev = prevKey ? { key: prevKey, content: await api.readFile(notePath(prevKey)) } : null;
    await api.writeFile(path, buildDailyNote(key, prev));
    noteKeys = [...noteKeys, key].sort();
    status(prev ? `${key} 노트를 만들고 ${prevKey} 노트의 일감을 넘겨받았습니다.` : `${key} 노트를 만들었습니다.`);
  }
  openContent(path, await api.readFile(path));
  if (!previewOn) togglePreview();
}

async function changeNotesDir() {
  const dir = await api.chooseNotesDir();
  if (!dir) return;
  notesDir = dir;
  await loadNoteKeys();
  showNotesDir(dir);
  renderCalendar();
  await refreshVault();
}

function renderCalendar() {
  if ($('sidebar').hidden) return;
  $('cal-title').textContent = `${calYear}년 ${calMonth + 1}월`;
  const cal = $('calendar');
  cal.innerHTML = '';
  for (const d of ['일', '월', '화', '수', '목', '금', '토']) {
    const el = document.createElement('div');
    el.className = 'dow';
    el.textContent = d;
    cal.appendChild(el);
  }
  const first = new Date(calYear, calMonth, 1).getDay();
  const days = new Date(calYear, calMonth + 1, 0).getDate();
  for (let i = 0; i < first; i++) cal.appendChild(document.createElement('div'));
  const todayKey = dateKey(new Date());
  const openKey = activeNoteKey();
  for (let d = 1; d <= days; d++) {
    const key = dateKey(new Date(calYear, calMonth, d));
    const el = document.createElement('div');
    el.className = 'day';
    if (noteKeys.includes(key)) el.classList.add('has-note');
    if (key === todayKey) el.classList.add('today');
    if (key === openKey) el.classList.add('open');
    el.textContent = String(d);
    el.title = noteKeys.includes(key) ? `${key} 노트 열기` : `${key} 노트 만들기`;
    el.onclick = () => void openNote(key);
    cal.appendChild(el);
  }
}

$('cal-prev').onclick = () => {
  calMonth--;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  renderCalendar();
};
$('cal-next').onclick = () => {
  calMonth++;
  if (calMonth > 11) { calMonth = 0; calYear++; }
  renderCalendar();
};
$('notes-dir').onclick = () => void changeNotesDir();

async function toggleSidebar() {
  const sidebar = $('sidebar');
  sidebar.hidden = !sidebar.hidden;
  renderTabs();
  if (!sidebar.hidden) {
    notesDir ??= await api.getNotesDir();
    if (notesDir) {
      await loadNoteKeys();
      showNotesDir(notesDir);
    } else {
      $('notes-dir').textContent = '노트 폴더를 고르려면 여기를 누르세요';
    }
    renderCalendar();
    await refreshVault();
  }
}

/** 커서나 선택이 걸친 줄마다 체크박스를 토글한다 */
function toggleTasks() {
  const model = editor.getModel();
  if (!model) return;
  const lines = new Set<number>();
  for (const s of editor.getSelections() ?? []) {
    for (let l = s.startLineNumber; l <= s.endLineNumber; l++) lines.add(l);
  }
  editor.executeEdits(
    'toggle-task',
    [...lines].map((l) => ({
      range: new monaco.Range(l, 1, l, model.getLineMaxColumn(l)),
      text: toggleTaskLine(model.getLineContent(l)),
    })),
  );
}

// ───────── 마크다운 미리보기 ─────────

let previewOn = false;
let previewTimer: number | undefined;

function renderPreview() {
  if (!previewOn || !active) return;
  $('preview').innerHTML = marked.parse(active.model.getValue(), { async: false });
  void loadMedia($('preview'));
}

/** 첨부 하나를 미리보기 요소로. 이미지·영상·오디오는 바로 보이고, 그 밖의 파일은 눌러서 기본 앱으로 연다 */
function attachmentHtml(path: string, label: string): string {
  const p = escapeHtml(path);
  switch (attachmentKind(path)) {
    case 'image': return `<img data-path="${p}" alt="${escapeHtml(label)}">`;
    case 'video': return `<video data-path="${p}" controls preload="metadata"></video>`;
    case 'audio': return `<audio data-path="${p}" controls preload="metadata"></audio>`;
    default: return `<a class="attachment" data-path="${p}">${escapeHtml(label)}</a>`;
  }
}

const isExternal = (src: string) => /^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(src);

// 미리보기를 다시 그릴 때 지난번 웹용 blob 주소를 놓아준다
let mediaUrls: string[] = [];
/** 일반 마크다운 ![](파일)·[](파일)의 로컬 파일도 첨부처럼 바꾸고, 첨부 요소에 실제 주소를 채운다 */
async function loadMedia(root: HTMLElement) {
  for (const img of root.querySelectorAll<HTMLImageElement>('img:not([data-path])')) {
    const src = img.getAttribute('src') ?? '';
    const path = !isExternal(src) && attachmentPath(decodeURIComponent(src));
    if (path) img.outerHTML = attachmentHtml(path, img.alt || src);
  }
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href]:not(.wikilink):not(.tag)')) {
    const href = a.getAttribute('href') ?? '';
    const path = !isExternal(href) && isAttachmentTarget(href) && attachmentPath(decodeURIComponent(href));
    if (!path) continue;
    a.removeAttribute('href');
    a.className = 'attachment';
    a.dataset.path = path;
  }
  for (const u of mediaUrls) URL.revokeObjectURL(u);
  mediaUrls = [];
  for (const el of root.querySelectorAll<HTMLImageElement | HTMLMediaElement>('img[data-path], video[data-path], audio[data-path]')) {
    try {
      const path = el.dataset.path!;
      const blob = path.startsWith(PENDING) && active?.pending.get(path.slice(PENDING.length));
      const url = blob ? URL.createObjectURL(blob) : await api.mediaUrl(path);
      if (url.startsWith('blob:')) mediaUrls.push(url);
      el.src = url;
    } catch {
      el.replaceWith(Object.assign(document.createElement('span'), { className: 'missing', textContent: `첨부를 찾지 못했습니다: ${el.dataset.path}` }));
    }
  }
}

function schedulePreview() {
  if (!previewOn) return;
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(renderPreview, 150);
}

function togglePreview() {
  previewOn = !previewOn;
  $('preview').hidden = !previewOn || !!compare || graphOn;
  renderPreview();
}

// ───────── 노트 폴더 색인 ([[링크]]·백링크·태그·할 일) ─────────

let vaultFiles: VaultFile[] = [];
let vaultMtime = new Map<string, number>();
// 탭 내용이 바뀌면 null로 지우고, 필요할 때 다시 만든다
let vaultIndex: VaultIndex | null = null;

/** 노트 폴더 안 파일이면 폴더 기준 상대 경로, 아니면 null */
function relPath(abs: string): string | null {
  return notesDir && abs.startsWith(`${notesDir}/`) ? abs.slice(notesDir.length + 1) : null;
}

async function refreshVault() {
  if (!notesDir) return;
  const files = await api.scanVault(notesDir);
  vaultFiles = files.map(({ path, content }) => ({ path, content }));
  vaultMtime = new Map(files.map((f) => [f.path, f.mtime]));
  vaultIndex = null;
  renderSidePanel();
  decorateLinks();
  if (graphOn) renderGraph();
}

/** 색인. 열린 탭의 저장하지 않은 내용을 디스크 내용보다 앞세운다 */
function getIndex(): VaultIndex {
  if (vaultIndex) return vaultIndex;
  const open = new Map<string, Tab>();
  for (const t of tabs) {
    const rel = t.path && relPath(t.path);
    if (rel && rel.toLowerCase().endsWith('.md')) open.set(rel, t);
  }
  const files = vaultFiles.map((f) => (open.has(f.path) ? { path: f.path, content: open.get(f.path)!.model.getValue() } : f));
  vaultIndex = buildIndex(files);
  return vaultIndex;
}

let vaultEditTimer: number | undefined;
function onVaultEdit() {
  vaultIndex = null;
  clearTimeout(vaultEditTimer);
  vaultEditTimer = window.setTimeout(() => {
    renderSidePanel();
    decorateLinks();
    if (graphOn) renderGraph();
  }, 400);
}

async function ensureVault(): Promise<boolean> {
  if (!(await ensureNotesDir())) {
    status('노트 폴더를 골라야 이 기능을 쓸 수 있습니다.');
    return false;
  }
  if (vaultFiles.length === 0) await refreshVault();
  return true;
}

/** 노트를 열고 line(0부터)이나 제목으로 커서를 옮긴다 */
async function openVaultNote(rel: string, at?: { line?: number; subpath?: string }) {
  const abs = `${notesDir}/${rel}`;
  openContent(abs, await api.readFile(abs));
  let line = at?.line;
  if (line === undefined && at?.subpath && !at.subpath.startsWith('#^')) {
    const want = at.subpath.slice(1).trim().toLowerCase();
    line = parseNote(editor.getModel()!.getValue()).headings.find((h) => h.text.toLowerCase() === want)?.line;
  }
  if (line !== undefined) {
    editor.setPosition({ lineNumber: line + 1, column: 1 });
    editor.revealLineInCenter(line + 1);
  }
}

/** [[대상]]을 따라간다. 없는 노트면 노트 폴더 맨 위에 새로 만든다 */
async function followLink(target: string, subpath = '') {
  // 첨부 파일은 노트가 아니므로 기본 앱으로 연다
  const attached = isAttachmentTarget(target) && attachmentPath(target, true);
  if (attached && !attached.startsWith(PENDING)) return void api.openPath(attached);
  if (attached) return status('저장하지 않은 첨부는 미리보기에서 볼 수 있습니다.');
  if (!(await ensureVault())) return;
  const source = (active?.path && relPath(active.path)) || '';
  const dest = resolveLink(target, source, getIndex().lookup);
  if (dest) return openVaultNote(dest, { subpath });
  if (!target) return;
  const rel = /\.md$/i.test(target) ? target : `${target}.md`;
  await api.writeFile(`${notesDir}/${rel}`, `# ${noteName(rel)}\n\n`);
  await refreshVault();
  status(`새 노트를 만들었습니다: ${rel}`);
  await openVaultNote(rel);
}

const WIKILINK_RE = /!?\[\[([^\[\]\n]+?)\]\]/g;

/** 줄의 column(1부터) 위치를 덮는 [[링크]] */
function linkAt(model: monaco.editor.ITextModel, pos: monaco.IPosition) {
  for (const m of model.getLineContent(pos.lineNumber).matchAll(WIKILINK_RE)) {
    const start = m.index! + 1;
    if (pos.column >= start && pos.column <= start + m[0].length) return splitLinkText(m[1]);
  }
  return null;
}

async function followLinkAtCursor() {
  const pos = editor.getPosition();
  const link = pos && editor.getModel() && linkAt(editor.getModel()!, pos);
  if (!link) return status('커서가 [[링크]] 위에 있지 않습니다.');
  await followLink(link.target, link.subpath);
}

// ⌘클릭(윈도우는 Ctrl+클릭)으로 [[링크]]를 따라간다
editor.onMouseDown((e) => {
  const model = editor.getModel();
  if (!(IS_MAC ? e.event.metaKey : e.event.ctrlKey) || !e.target.position || model?.getLanguageId() !== 'markdown') return;
  const link = linkAt(model, e.target.position);
  if (!link) return;
  e.event.preventDefault();
  void followLink(link.target, link.subpath);
});

// 편집기 안의 [[링크]]에 밑줄을 긋는다. 못 찾은 링크는 흐리게 보인다
const linkDecorations = editor.createDecorationsCollection();
const CLICK_KEY = IS_MAC ? '⌘' : 'Ctrl+';
function decorateLinks() {
  const model = editor.getModel();
  if (!model || model.getLanguageId() !== 'markdown' || !notesDir || vaultFiles.length === 0) {
    linkDecorations.clear();
    return;
  }
  const index = getIndex();
  const source = (active?.path && relPath(active.path)) || '';
  const decos: monaco.editor.IModelDeltaDecoration[] = [];
  for (const link of parseNote(model.getValue()).links) {
    const attached = isAttachmentTarget(link.target);
    const ok = !link.target || attached || resolveLink(link.target, source, index.lookup);
    const hover = attached ? `미리보기에서 보입니다 · ${CLICK_KEY}클릭으로 기본 앱에서 열기` : `${CLICK_KEY}클릭으로 ${ok ? '열기' : '새 노트 만들기'}`;
    decos.push({
      range: new monaco.Range(link.line + 1, link.col + 1, link.line + 1, link.col + 1 + link.raw.length),
      options: { inlineClassName: ok ? 'wl-deco' : 'wl-deco unresolved', hoverMessage: { value: hover } },
    });
  }
  linkDecorations.set(decos);
}

// [[ 를 치면 노트 이름을 제안한다
monaco.languages.registerCompletionItemProvider('markdown', {
  triggerCharacters: ['['],
  provideCompletionItems(model, position) {
    const line = model.getLineContent(position.lineNumber);
    const m = line.slice(0, position.column - 1).match(/\[\[([^\[\]|#]*)$/);
    if (!m || !notesDir || vaultFiles.length === 0) return { suggestions: [] };
    const closes = line.slice(position.column - 1).startsWith(']]');
    const range = new monaco.Range(position.lineNumber, position.column - m[1].length, position.lineNumber, position.column + (closes ? 2 : 0));
    const index = getIndex();
    const scored = index.files
      .map((f) => {
        const full = f.path.replace(/\.md$/i, '');
        return { f, full, match: fuzzyMatch(m[1], full) };
      })
      .filter((x) => x.match)
      .sort((a, b) => b.match!.score - a.match!.score)
      .slice(0, 50);
    return {
      // 글자를 더 칠 때마다 다시 계산하도록 한다 (Monaco 자체 거르기 대신 우리 점수를 쓴다)
      incomplete: true,
      suggestions: scored.map(({ f, full }, i) => {
        // 같은 이름 노트가 여럿이면 경로까지 넣어 헷갈리지 않게 한다
        const dup = (index.lookup.get(f.path.slice(f.path.lastIndexOf('/') + 1).toLowerCase())?.length ?? 0) > 1;
        return {
          label: noteName(f.path),
          detail: f.path,
          kind: monaco.languages.CompletionItemKind.File,
          insertText: `${dup ? full : noteName(f.path)}]]`,
          filterText: m[1],
          sortText: String(i).padStart(4, '0'),
          range,
        };
      }),
    };
  },
});

// ───────── 사이드바 패널 (노트·백링크·태그·할 일) ─────────

let sidePanel: 'notes' | 'backlinks' | 'tags' | 'tasks' = 'notes';

document.querySelectorAll<HTMLButtonElement>('.side-tabs button').forEach((b) => {
  b.onclick = () => {
    sidePanel = b.dataset.panel as typeof sidePanel;
    document.querySelectorAll('.side-tabs button').forEach((x) => x.classList.toggle('active', x === b));
    renderSidePanel();
  };
});

function panelItem(file: string, ctx: string, onClick: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'item';
  el.innerHTML = '<div class="file"></div><div class="ctx"></div>';
  el.querySelector('.file')!.textContent = file;
  el.querySelector('.ctx')!.textContent = ctx;
  el.title = ctx;
  el.onclick = onClick;
  return el;
}

function panelSection(panel: HTMLElement, title: string, mentions: Mention[]) {
  const head = document.createElement('div');
  head.className = 'sec';
  head.textContent = `${title} ${mentions.length}`;
  panel.append(head);
  for (const m of mentions) panel.append(panelItem(noteName(m.source), m.text, () => void openVaultNote(m.source, { line: m.line })));
}

function panelEmpty(panel: HTMLElement, text: string) {
  const el = document.createElement('div');
  el.className = 'empty';
  el.textContent = text;
  panel.append(el);
}

function renderSidePanel() {
  if ($('sidebar').hidden) return;
  const panel = $('side-panel');
  panel.innerHTML = '';
  if (!notesDir || vaultFiles.length === 0) return panelEmpty(panel, '노트 폴더를 고르면 보입니다.');
  const index = getIndex();
  if (sidePanel === 'notes') {
    const add = document.createElement('div');
    add.className = 'new-note';
    const button = (label: string, onClick: () => void) => {
      const b = document.createElement('button');
      b.textContent = `+ ${label}`;
      b.onclick = onClick;
      add.append(b);
    };
    button('날짜', () => void openNote(dateKey(new Date())));
    for (const kind of Object.keys(NOTE_KIND_LABELS) as NoteKind[]) button(NOTE_KIND_LABELS[kind], () => void newNote(kind));
    panel.append(add);
    const current = active?.path && relPath(active.path);
    // 데일리 노트는 달력으로 찾으므로 목록에서 뺀다
    for (const { folder, notes } of notesByFolder(index.files.map((f) => f.path), [folders.daily])) {
      const head = document.createElement('div');
      head.className = 'sec';
      head.textContent = folder || '노트 폴더';
      panel.append(head);
      for (const rel of notes) {
        const el = document.createElement('div');
        el.className = 'item';
        el.classList.toggle('active', rel === current);
        // 오른쪽 숫자는 이 노트를 링크한 노트 수
        el.innerHTML = '<span class="count"></span><span></span>';
        el.children[0].textContent = String(new Set(backlinks(index, rel).map((b) => b.source)).size || '');
        el.children[1].textContent = noteName(rel);
        el.title = rel;
        el.onclick = () => void openVaultNote(rel);
        panel.append(el);
      }
    }
  } else if (sidePanel === 'backlinks') {
    const rel = active?.path && relPath(active.path);
    if (!rel) return panelEmpty(panel, '노트 폴더 안의 노트를 열면 그 노트를 가리키는 링크가 보입니다.');
    panelSection(panel, '링크된 언급', backlinks(index, rel));
    panelSection(panel, '링크 안 된 언급', unlinkedMentions(index, rel));
  } else if (sidePanel === 'tags') {
    const tags = tagCounts(index);
    if (tags.length === 0) return panelEmpty(panel, '#태그가 없습니다.');
    for (const { tag, count } of tags) {
      const el = document.createElement('div');
      el.className = 'item';
      // 중첩 태그는 단계만큼 들여 쓰고 마지막 조각만 보여 준다
      const depth = tag.split('/').length - 1;
      el.style.paddingLeft = `${4 + depth * 12}px`;
      el.innerHTML = '<span class="count"></span><span></span>';
      el.children[0].textContent = String(count);
      el.children[1].textContent = `#${tag.split('/').pop()}`;
      el.title = `#${tag}`;
      el.onclick = () => void searchNotes(`tag:#${tag}`);
      panel.append(el);
    }
  } else {
    const tasks = allTasks(index).filter((t) => !t.done);
    if (tasks.length === 0) return panelEmpty(panel, '남은 할 일이 없습니다.');
    let last = '';
    for (const t of tasks) {
      if (t.path !== last) {
        const head = document.createElement('div');
        head.className = 'sec';
        head.textContent = noteName(t.path);
        panel.append(head);
        last = t.path;
      }
      const el = document.createElement('div');
      el.className = 'item';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.title = '끝낸 일로 표시';
      box.onclick = (e) => {
        e.stopPropagation();
        void completeTask(t.path, t.line);
      };
      el.append(box, t.text);
      el.onclick = () => void openVaultNote(t.path, { line: t.line });
      panel.append(el);
    }
  }
}

/** 할 일을 끝낸 일로 바꾼다. 열린 탭이면 탭 내용을 고치고(저장은 직접), 아니면 파일을 바로 고친다 */
async function completeTask(rel: string, line: number) {
  const abs = `${notesDir}/${rel}`;
  const done = (text: string) => text.replace(/\[ \]/, '[x]');
  const tab = tabs.find((t) => t.path === abs);
  if (tab) {
    const n = line + 1;
    tab.model.pushEditOperations([], [{ range: new monaco.Range(n, 1, n, tab.model.getLineMaxColumn(n)), text: done(tab.model.getLineContent(n)) }], () => null);
    return status(`${noteName(rel)} 탭에서 끝낸 일로 바꿨습니다. 저장해야 파일에 반영됩니다.`);
  }
  const lines = (await api.readFile(abs)).split('\n');
  lines[line] = done(lines[line]);
  await api.writeFile(abs, lines.join('\n'));
  await refreshVault();
  status(`${noteName(rel)}의 할 일을 끝낸 일로 바꿨습니다.`);
}

/** 이름을 물어 주제·목차 노트를 그 종류 폴더에 틀과 함께 만든다. 이미 있으면 그 노트를 연다 */
async function newNote(kind: NoteKind) {
  if (!(await ensureVault())) return;
  const label = NOTE_KIND_LABELS[kind];
  const name = await askNoteName(`새 ${label} 노트`, `${kind === 'topic' ? 'Electron IPC' : '업무 목차'} (${folders[kind]} 폴더에 만듭니다)`);
  if (!name) return;
  const rel = kindNotePath(folders[kind], name);
  if (!getIndex().files.some((f) => f.path === rel)) {
    await api.writeFile(`${notesDir}/${rel}`, kindNoteContent(kind, noteName(rel)));
    await refreshVault();
    status(`새 ${label} 노트를 만들었습니다: ${rel}`);
  }
  await openVaultNote(rel);
}

// ───────── 빠른 열기·전체 검색 ─────────

async function quickOpen() {
  if (!(await ensureVault())) return;
  const openRank = new Map(tabs.map((t, i) => [t.path && relPath(t.path), i]));
  openPicker<string>({
    title: '노트 빠르게 열기',
    placeholder: '노트 이름이나 경로 일부를 입력하세요',
    help: '↑↓ 이동 · Enter 열기 · ⇧Enter 입력한 이름으로 새 노트 만들기',
    search: (q) => {
      const files = getIndex().files;
      if (!q.trim()) {
        // 검색어가 없으면 열린 탭, 그다음 최근에 고친 노트 순서
        return [...files]
          .sort((a, b) => (openRank.get(b.path) ?? -1) - (openRank.get(a.path) ?? -1) || (vaultMtime.get(b.path) ?? 0) - (vaultMtime.get(a.path) ?? 0))
          .slice(0, 50)
          .map((f) => ({ label: f.path.replace(/\.md$/i, ''), data: f.path }));
      }
      const out: (PickerItem<string> & { score: number })[] = [];
      for (const f of files) {
        const label = f.path.replace(/\.md$/i, '');
        const m = fuzzyMatch(q, label);
        if (m) out.push({ label, matches: m.matches, data: f.path, score: m.score });
      }
      return out.sort((a, b) => b.score - a.score).slice(0, 50);
    },
    onPick: (item, q, shift) => {
      if (item && !shift) return void openVaultNote(item.data);
      if (q.trim()) void followLink(q.trim());
    },
  });
}

async function searchNotes(initial = '') {
  if (!(await ensureVault())) return;
  openPicker<{ path: string; line?: number }>({
    title: '노트 전체 검색',
    placeholder: '검색어 (예: 배포 -리뷰 tag:#업무 "정확한 문구")',
    help: '모든 조건이 맞는 노트를 찾습니다. file: path: tag: task: task-todo: task-done: line: 과 -제외, "문구", /정규식/ 을 쓸 수 있습니다.',
    initial,
    search: (q) => {
      const items: PickerItem<{ path: string; line?: number }>[] = [];
      for (const hit of searchVault(getIndex(), q)) {
        if (hit.lines.length === 0) items.push({ label: noteName(hit.path), sub: hit.path, data: { path: hit.path } });
        for (const l of hit.lines.slice(0, 5)) {
          items.push({ label: l.text || noteName(hit.path), sub: `${hit.path} · ${l.line + 1}줄`, data: { path: hit.path, line: l.line } });
        }
        if (items.length >= 300) break;
      }
      return items;
    },
    onPick: (item) => item && void openVaultNote(item.data.path, { line: item.data.line }),
  });
}

// ───────── 미리보기의 [[링크]]·#태그 ─────────

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

marked.use({
  extensions: [
    {
      name: 'wikilink',
      level: 'inline',
      start: (src: string) => {
        const i = src.indexOf('[[');
        return i < 0 ? undefined : src[i - 1] === '!' ? i - 1 : i;
      },
      tokenizer: (src: string) => {
        const m = /^!?\[\[([^\[\]\n]+?)\]\]/.exec(src);
        return m ? { type: 'wikilink', raw: m[0], inner: m[1] } : undefined;
      },
      renderer: (tok) => {
        const { target, subpath, alias } = splitLinkText(tok.inner as string);
        const attached = isAttachmentTarget(target) && attachmentPath(target, true);
        if (attached) return (tok.raw as string).startsWith('!') ? attachmentHtml(attached, alias ?? target) : `<a class="attachment" data-path="${escapeHtml(attached)}">${escapeHtml(alias ?? target)}</a>`;
        const source = (active?.path && relPath(active.path)) || '';
        const ok = !target || (notesDir && vaultFiles.length > 0 && resolveLink(target, source, getIndex().lookup));
        const text = alias ?? (target + (subpath ? ` > ${subpath.slice(1)}` : ''));
        return `<a class="wikilink${ok ? '' : ' unresolved'}" data-target="${escapeHtml(target)}" data-subpath="${escapeHtml(subpath)}">${escapeHtml(text)}</a>`;
      },
    },
    {
      name: 'tag',
      level: 'inline',
      // 줄 맨 앞이나 공백 뒤의 #만 태그로 본다
      start: (src: string) => {
        const m = /(^|\s)#[^\s#]/.exec(src);
        return m ? m.index + m[1].length : undefined;
      },
      tokenizer: (src: string) => {
        const m = TAG_AT_START.exec(src);
        return m && !/^\d+$/.test(m[1]) ? { type: 'tag', raw: m[0], tag: m[1] } : undefined;
      },
      renderer: (tok) => `<a class="tag" data-tag="${escapeHtml(tok.tag as string)}">#${escapeHtml(tok.tag as string)}</a>`,
    },
  ],
});

$('preview').addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest('a');
  if (!a) return;
  if (a.classList.contains('attachment')) {
    e.preventDefault();
    const path = a.dataset.path!;
    if (path.startsWith(PENDING)) status('저장하지 않은 첨부 파일은 탭을 저장한 뒤 열 수 있습니다.');
    else void api.openPath(path);
  } else if (a.classList.contains('wikilink')) {
    e.preventDefault();
    void followLink(a.dataset.target ?? '', a.dataset.subpath ?? '');
  } else if (a.classList.contains('tag')) {
    e.preventDefault();
    void searchNotes(`tag:#${a.dataset.tag}`);
  } else if (a.href) {
    // 일반 링크가 앱 화면을 바꿔 버리지 않게 새 창(데스크톱은 기본 브라우저)으로 연다
    e.preventDefault();
    window.open(a.href, '_blank', 'noopener');
  }
});

// 웹에서는 저장하지 않은 탭이 있으면 브라우저 탭을 닫기 전에 묻는다
window.addEventListener('beforeunload', (e) => {
  if (PLATFORM === 'web' && tabs.some(isDirty)) e.preventDefault();
});

// ───────── 그래프 ─────────

let graphOn = false;
const graphView = createGraphView($('graph-canvas') as HTMLCanvasElement, (rel) => void openVaultNote(rel));
// 그래프를 열 때의 노트. "현재 노트 주변만"의 중심이 된다
let graphFocus: string | null = null;

function renderGraph() {
  const local = ($('graph-local') as HTMLInputElement).checked;
  const data = buildGraph(getIndex(), {
    tags: ($('graph-tags') as HTMLInputElement).checked,
    unresolved: true,
    focus: local && graphFocus ? graphFocus : undefined,
    depth: 2,
  });
  $('graph-title').textContent = `그래프 · 노트 ${data.nodes.filter((n) => n.kind === 'note').length}개 · 링크 ${data.edges.length}개`;
  graphView.setData(data, graphFocus ?? undefined);
}

async function openGraph() {
  if (!(await ensureVault())) return;
  closeCompare();
  graphFocus = (active?.path && relPath(active.path)) || null;
  ($('graph-local') as HTMLInputElement).disabled = !graphFocus;
  if (!graphFocus) ($('graph-local') as HTMLInputElement).checked = false;
  graphOn = true;
  $('editor-host').hidden = true;
  $('preview').hidden = true;
  $('graph-host').hidden = false;
  renderGraph();
}

function closeGraph() {
  if (!graphOn) return;
  graphOn = false;
  graphView.stop();
  $('graph-host').hidden = true;
  $('editor-host').hidden = false;
  $('preview').hidden = !previewOn;
  editor.focus();
}

$('graph-local').addEventListener('change', renderGraph);
$('graph-tags').addEventListener('change', renderGraph);

// ───────── 단축키 표시 ─────────

let bindings: Record<string, string> = resolveBindings({});

/** 안내 문구에 넣을 단축키. 단축키가 없으면 메뉴 이름을 알려준다 */
function keyHint(id: string): string {
  return acceleratorLabel(bindings[id], IS_MAC) || `메뉴의 "${COMMANDS.find((c) => c.id === id)?.label}"`;
}

/** 비교 막대 버튼 등의 툴팁을 현재 단축키로 맞춘다 */
function applyKeyHints() {
  document.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach((b) => {
    const c = COMMANDS.find((x) => x.id === b.dataset.cmd);
    if (!c) return;
    const key = acceleratorLabel(bindings[c.id], IS_MAC);
    b.title = key ? `${c.label} (${key})` : c.label;
  });
}

async function editKeybindings() {
  const next = await openKeybindings();
  if (!next) return;
  bindings = next;
  applyKeyHints();
  status('단축키를 저장했습니다.');
}

// Esc는 메뉴 단축키가 아니므로 여기서 처리한다. 편집기가 Esc를 먼저 썼으면(찾기 창 닫기 등) 비교는 그대로 둔다
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || (!compare && !graphOn)) return;
  if (document.querySelector('.modal-backdrop')) return;
  closeCompare();
  closeGraph();
});

// ───────── 명령 처리 ─────────

let wrap = false;
let showWs = false;

/** 비교 중이면 오른쪽 편집기, 아니면 일반 편집기를 대상으로 한다 */
function focusedEditor(): monaco.editor.ICodeEditor {
  return compare ? diffEditor.getModifiedEditor() : editor;
}

async function run(command: string) {
  switch (command) {
    case 'file:new': return void addTab(null, '');
    case 'file:open': return openFiles();
    case 'file:save': return active && save(active);
    case 'file:save-as': return active && save(active, true);
    case 'file:close-tab': return compare ? closeCompare() : active && closeTab(active);
    case 'edit:undo': return focusedEditor().trigger('menu', 'undo', null);
    case 'edit:redo': return focusedEditor().trigger('menu', 'redo', null);
    case 'edit:select-all': {
      // 모달 입력란에 포커스가 있으면 그 안에서만 전체 선택
      const el = document.activeElement;
      if (el instanceof HTMLInputElement) return el.select();
      return focusedEditor().trigger('menu', 'editor.action.selectAll', null);
    }
    case 'edit:find': return focusedEditor().trigger('menu', 'actions.find', null);
    case 'edit:replace': return focusedEditor().trigger('menu', 'editor.action.startFindReplaceAction', null);
    case 'edit:insert-numbers': return compare ? undefined : insertNumbers();
    case 'view:toggle-wrap':
      wrap = !wrap;
      editor.updateOptions({ wordWrap: wrap ? 'on' : 'off' });
      return diffEditor.updateOptions({ wordWrap: wrap ? 'on' : 'off' });
    case 'view:toggle-whitespace':
      showWs = !showWs;
      editor.updateOptions({ renderWhitespace: showWs ? 'all' : 'none' });
      return diffEditor.updateOptions({ renderWhitespace: showWs ? 'all' : 'none' });
    case 'compare:tabs': return compareTabs();
    case 'compare:clipboard': return compareClipboard();
    case 'compare:files': return compareFiles();
    case 'compare:next': return compare && diffEditor.goToDiff('next');
    case 'compare:prev': return compare && diffEditor.goToDiff('previous');
    case 'compare:toggle-whitespace':
      diffOpts.ignoreWhitespace = !diffOpts.ignoreWhitespace;
      syncCompareOptionsUI();
      return applyCompareModels();
    case 'compare:toggle-case':
      diffOpts.ignoreCase = !diffOpts.ignoreCase;
      syncCompareOptionsUI();
      return applyCompareModels();
    case 'compare:close': return closeCompare();
    case 'compare:mark': return markCompareSource();
    case 'compare:with-marked': return compareWithMarked();
    case 'notes:today': return openNote(dateKey(new Date()));
    case 'notes:toggle-task': return compare ? undefined : toggleTasks();
    case 'notes:choose-dir': return changeNotesDir();
    case 'notes:folders': return changeFolders();
    case 'notes:quick-open': return quickOpen();
    case 'notes:search': return searchNotes();
    case 'notes:graph': return graphOn ? closeGraph() : openGraph();
    case 'notes:follow-link': return followLinkAtCursor();
    case 'view:toggle-sidebar': return toggleSidebar();
    case 'view:toggle-preview': return togglePreview();
    case 'app:keybindings': return editKeybindings();
    case 'tools:json-format': return transform('json 정리', (s) => formatJson(s));
    case 'tools:json-minify': return transform('json 압축', minifyJson);
    case 'tools:xml-format': return transform('xml 정리', (s) => formatXml(s));
    case 'tools:xml-minify': return transform('xml 압축', minifyXml);
    case 'app:request-close': {
      const dirty = tabs.filter(isDirty);
      if (dirty.length === 0 || (await api.confirmDiscard(`저장하지 않은 탭이 ${dirty.length}개 있습니다. 저장하지 않고 종료할까요?`))) {
        api.approveClose();
      }
      return;
    }
  }
}

api.onMenu((command) => void run(command));
api.onOpenPath(async (p) => {
  try {
    openContent(p, await api.readFile(p));
  } catch (e) {
    status(`파일을 열지 못했습니다: ${p} (${(e as Error).message})`);
  }
});
document.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach((b) => {
  b.onclick = () => void run(b.dataset.cmd!);
});

addTab(null, '');
status('준비됨');
// 사이드바와 오른쪽 미리보기는 처음부터 켜 둔다
void toggleSidebar();
togglePreview();
void api.getKeyOverrides().then((o) => {
  bindings = resolveBindings(o);
  applyKeyHints();
});
