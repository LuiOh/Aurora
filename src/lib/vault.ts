// 노트 폴더(vault)의 [[링크]]·태그·할 일을 파싱하고 백링크, 퍼지 검색, 노트 검색을 계산하는 순수 함수 모음
import { isAttachmentTarget } from './attachments';
import { isMarkdownPath } from '../../electron/fileTypes';

export interface VaultFile {
  /** 노트 폴더 기준 상대 경로. 구분자는 / */
  path: string;
  content: string;
}

export interface NoteLink {
  /** [[대상#제목|별칭]]의 "대상" 부분 */
  target: string;
  /** #제목 또는 #^블록 (# 포함). 없으면 빈 문자열 */
  subpath: string;
  alias: string | null;
  embed: boolean;
  /** 0부터 세는 줄 번호와 [[ 시작 열 */
  line: number;
  col: number;
  /** ![[...]] 전체 원문 */
  raw: string;
}

export interface NoteTask {
  line: number;
  /** [ ] 안의 글자. 공백이면 안 한 일 */
  status: string;
  done: boolean;
  text: string;
}

export interface ParsedNote {
  links: NoteLink[];
  tags: { tag: string; line: number }[];
  tasks: NoteTask[];
  headings: { level: number; text: string; line: number }[];
}

const LINK_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g;
// 공백·구두점이 아닌 글자. 구두점 중 -, _, / 만 허용한다 (/는 중첩 태그)
const TAG_BODY = `[^\\s\\u2000-\\u206F\\u2E00-\\u2E7F'!"#$%&()*+,.:;<=>?@^\`{|}~\\[\\]\\\\]+`;
const TAG_RE = new RegExp(`(^|\\s)#(${TAG_BODY})`, 'g');
/** 문자열 맨 앞의 #태그 하나. 숫자뿐인 태그는 따로 걸러야 한다 */
export const TAG_AT_START = new RegExp(`^#(${TAG_BODY})`);
const TASK_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[(.)\]\s?(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

/** 인라인 코드(`...`) 안은 같은 길이의 공백으로 지운다. 열 위치는 그대로 남는다 */
function blankInlineCode(line: string): string {
  return line.replace(/(`+)[^`]*?\1/g, (m) => ' '.repeat(m.length));
}

/** [[대상#제목|별칭]] 안쪽 문자열을 나눈다 */
export function splitLinkText(inner: string): { target: string; subpath: string; alias: string | null } {
  const bar = inner.indexOf('|');
  let left = bar >= 0 ? inner.slice(0, bar) : inner;
  const alias = bar >= 0 ? inner.slice(bar + 1).trim() : null;
  left = left.trim();
  if (left.endsWith('\\')) left = left.slice(0, -1);
  left = left.replace(/ /g, ' ').normalize('NFC');
  const hash = left.indexOf('#');
  return hash >= 0
    ? { target: left.slice(0, hash).trim(), subpath: left.slice(hash), alias }
    : { target: left, subpath: '', alias };
}

/** 앞머리 YAML의 tags: 값을 읽는다. 한 줄 목록([a, b]), 쉼표·공백 구분, 아래 줄 목록(- a)을 받는다 */
function frontmatterTags(lines: string[], end: number): string[] {
  const out: string[] = [];
  for (let i = 1; i < end; i++) {
    const m = lines[i].match(/^(tags?)\s*:\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (value === '') {
      while (i + 1 < end && /^\s*-\s+/.test(lines[i + 1])) out.push(lines[++i].replace(/^\s*-\s+/, ''));
      continue;
    }
    value = value.replace(/^\[|\]$/g, '');
    out.push(...value.split(/[,\s]+/));
  }
  return out
    .map((t) => t.trim().replace(/^["']|["']$/g, '').replace(/^#/, ''))
    .filter((t) => t && !/^\d+$/.test(t));
}

export function parseNote(content: string): ParsedNote {
  const lines = content.split('\n');
  const note: ParsedNote = { links: [], tags: [], tasks: [], headings: [] };
  let start = 0;
  // 맨 앞 --- 사이는 프런트매터. tags만 읽고 본문 파싱에서는 뺀다
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (end > 0) {
      for (const tag of frontmatterTags(lines, end)) note.tags.push({ tag, line: 0 });
      start = end + 1;
    }
  }
  let fence: string | null = null;
  for (let i = start; i < lines.length; i++) {
    const raw = lines[i];
    const f = raw.match(FENCE_RE);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const line = blankInlineCode(raw);

    for (const m of line.matchAll(LINK_RE)) {
      const parts = splitLinkText(m[2]);
      note.links.push({ ...parts, embed: m[1] === '!', line: i, col: m.index!, raw: m[0] });
    }
    // 링크 안의 #제목을 태그로 읽지 않도록 링크 자리는 지우고 찾는다
    const noLinks = line.replace(LINK_RE, (m) => ' '.repeat(m.length));
    const h = noLinks.match(HEADING_RE);
    if (h) note.headings.push({ level: h[1].length, text: h[2], line: i });
    else {
      for (const m of noLinks.matchAll(TAG_RE)) {
        if (!/^\d+$/.test(m[2])) note.tags.push({ tag: m[2], line: i });
      }
    }
    const t = raw.match(TASK_RE);
    if (t) note.tasks.push({ line: i, status: t[1], done: t[1] !== ' ', text: t[2] });
  }
  return note;
}

// ───────── 링크 해석 ─────────

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const fileName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
/** 확장자를 뺀 노트 이름 */
export const noteName = (p: string) => fileName(p).replace(/\.(md|markdown)$/i, '');
/** 목록에 보일 이름. 마크다운은 확장자를 빼고, 다른 파일은 확장자까지 보인다 (회의.txt) */
export const displayName = (p: string) => (isMarkdownPath(p) ? noteName(p) : fileName(p));
/** 빠르게 열기에 보일 경로. 마크다운만 확장자를 뺀다 */
export const displayPath = (p: string) => (isMarkdownPath(p) ? p.replace(/\.(md|markdown)$/i, '') : p);

/** 파일 이름(소문자) → 그 이름을 가진 파일 경로들 */
/** 노트를 폴더별로 묶는다. 폴더는 맨 위(빈 이름)부터 이름순, 노트도 이름순이다. skip 폴더와 그 아래는 뺀다 */
export function notesByFolder(paths: string[], skip: string[] = []): { folder: string; notes: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const folder = dirOf(p);
    if (skip.some((s) => folder === s || folder.startsWith(`${s}/`))) continue;
    groups.set(folder, [...(groups.get(folder) ?? []), p]);
  }
  const byName = (a: string, b: string) => a.localeCompare(b, 'ko');
  return [...groups.keys()].sort(byName).map((folder) => ({
    folder,
    notes: groups.get(folder)!.sort((a, b) => byName(displayName(a), displayName(b))),
  }));
}

export type NameLookup = Map<string, string[]>;

export function buildLookup(paths: string[]): NameLookup {
  const map: NameLookup = new Map();
  for (const p of paths) {
    const key = fileName(p).toLowerCase();
    map.set(key, [...(map.get(key) ?? []), p]);
  }
  return map;
}

/**
 * 링크 대상을 파일 경로로 바꾼다. 못 찾으면 null.
 * 이름이 하나뿐이면 바로 그 파일, 아니면 상대 경로 → 전체 경로 → 경로 끝 일치 순으로 찾고,
 * 끝 일치가 여럿이면 링크를 건 노트와 같은 폴더 아래 파일, 그다음 경로가 짧은 파일을 고른다.
 */
export function resolveLink(target: string, sourcePath: string, lookup: NameLookup): string | null {
  if (target === '') return sourcePath;
  let want = target.toLowerCase();
  let candidates = fileName(want).includes('.') ? lookup.get(fileName(want)) : undefined;
  if (!candidates) {
    want += '.md';
    candidates = lookup.get(fileName(want));
  }
  if (!candidates) return null;
  if (!want.includes('/') && candidates.length === 1) return candidates[0];

  let base = dirOf(sourcePath).toLowerCase();
  if (want.startsWith('./') || want.startsWith('../')) {
    let rel = want.startsWith('./') ? want.slice(2) : want;
    while (rel.startsWith('../')) {
      rel = rel.slice(3);
      base = dirOf(base);
    }
    const full = base ? `${base}/${rel}` : rel;
    const hit = candidates.find((c) => c.toLowerCase() === full);
    if (hit) return hit;
  }
  if (want.startsWith('/')) want = want.slice(1);
  const exact = candidates.find((c) => c.toLowerCase() === want);
  if (exact) return exact;
  if (target.startsWith('/')) return null;

  const srcDir = dirOf(sourcePath).toLowerCase();
  const ends = candidates.filter((c) => {
    const lc = c.toLowerCase();
    return lc === want || lc.endsWith('/' + want);
  });
  const byLen = (a: string, b: string) => a.length - b.length;
  const near = ends.filter((c) => c.toLowerCase().startsWith(srcDir)).sort(byLen);
  const far = ends.filter((c) => !c.toLowerCase().startsWith(srcDir)).sort(byLen);
  return near[0] ?? far[0] ?? null;
}

// ───────── 색인 ─────────

export interface VaultIndex {
  /** 마크다운 노트만. 링크·백링크·태그·할 일·그래프는 이것만 본다 */
  files: VaultFile[];
  /** 텍스트 파일까지 모두. 노트 목록·빠르게 열기·전체 검색에 쓴다 */
  allFiles: VaultFile[];
  notes: Map<string, ParsedNote>;
  lookup: NameLookup;
  /** 노트별로 해석한 링크 대상 (못 찾은 링크는 null) */
  resolved: Map<string, (string | null)[]>;
}

export function buildIndex(allFiles: VaultFile[]): VaultIndex {
  const files = allFiles.filter((f) => isMarkdownPath(f.path));
  const notes = new Map(files.map((f) => [f.path, parseNote(f.content)]));
  const lookup = buildLookup(files.map((f) => f.path));
  const resolved = new Map<string, (string | null)[]>();
  for (const [path, note] of notes) resolved.set(path, note.links.map((l) => resolveLink(l.target, path, lookup)));
  return { files, allFiles, notes, lookup, resolved };
}

export interface Mention {
  source: string;
  line: number;
  text: string;
}

const lineAt = (index: VaultIndex, path: string, line: number) =>
  index.files.find((f) => f.path === path)?.content.split('\n')[line] ?? '';

/** path 노트를 [[링크]]로 가리키는 곳들. 자기 자신 안의 링크는 뺀다 */
export function backlinks(index: VaultIndex, path: string): Mention[] {
  const out: Mention[] = [];
  for (const [src, targets] of index.resolved) {
    if (src === path) continue;
    const links = index.notes.get(src)!.links;
    const seen = new Set<number>();
    targets.forEach((t, i) => {
      if (t !== path || seen.has(links[i].line)) return;
      seen.add(links[i].line);
      out.push({ source: src, line: links[i].line, text: lineAt(index, src, links[i].line).trim() });
    });
  }
  return out.sort((a, b) => a.source.localeCompare(b.source) || a.line - b.line);
}

/** 링크 없이 노트 이름만 적힌 곳들 (대소문자 무시). 코드 블록과 링크 안은 뺀다 */
export function unlinkedMentions(index: VaultIndex, path: string): Mention[] {
  const name = noteName(path).toLowerCase();
  if (name.length < 2) return [];
  const out: Mention[] = [];
  for (const f of index.files) {
    if (f.path === path) continue;
    let fence = false;
    f.content.split('\n').forEach((raw, i) => {
      if (FENCE_RE.test(raw)) fence = !fence;
      if (fence || FENCE_RE.test(raw)) return;
      const plain = blankInlineCode(raw).replace(LINK_RE, (m) => ' '.repeat(m.length));
      if (plain.toLowerCase().includes(name)) out.push({ source: f.path, line: i, text: raw.trim() });
    });
  }
  return out;
}

/** 찾지 못한 링크 대상과 그 링크를 건 노트들 */
export function unresolvedLinks(index: VaultIndex): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [src, targets] of index.resolved) {
    const links = index.notes.get(src)!.links;
    targets.forEach((t, i) => {
      // 첨부 파일은 노트 색인에 없으므로 못 찾은 링크로 치지 않는다
      if (t !== null || isAttachmentTarget(links[i].target)) return;
      const key = links[i].target;
      out.set(key, (out.get(key) ?? new Set()).add(src));
    });
  }
  return out;
}

/** 태그별 노트 수. 중첩 태그(a/b)는 상위 태그(a)에도 센다 */
export function tagCounts(index: VaultIndex): { tag: string; count: number }[] {
  const notesByTag = new Map<string, Set<string>>();
  for (const [path, note] of index.notes) {
    for (const { tag } of note.tags) {
      const parts = tag.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const key = parts.slice(0, i).join('/').toLowerCase();
        if (!key) continue;
        notesByTag.set(key, (notesByTag.get(key) ?? new Set()).add(path));
      }
    }
  }
  return [...notesByTag]
    .map(([tag, set]) => ({ tag, count: set.size }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export function hasTag(note: ParsedNote, tag: string): boolean {
  const want = tag.replace(/^#/, '').toLowerCase();
  return note.tags.some(({ tag: t }) => {
    const lc = t.toLowerCase();
    return lc === want || lc.startsWith(want + '/');
  });
}

// ───────── 퍼지 검색 ─────────

export interface FuzzyMatch {
  /** 0 이하. 0에 가까울수록 잘 맞음 */
  score: number;
  /** [시작, 끝) 위치 목록 */
  matches: [number, number][];
}

const PUNCT_RE = /[ -⁯⸀-⹿\\'!"#$%&()*+,\-./:;<=>?@\[\]^_`{|}~]/;
const CJK_RE = /[ༀ-࿿぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/;
const isBreak = (c: string) => PUNCT_RE.test(c) || CJK_RE.test(c);

/** 단어 시작 위치인지. 앞 글자가 구두점·공백이거나 camelCase 경계면 단어 시작이다 */
function atWordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const c = text[i];
  const p = text[i - 1];
  if (isBreak(c)) return true;
  if (/\s/.test(p) || isBreak(p)) return true;
  const upper = c !== c.toLowerCase();
  const prevLower = p !== p.toUpperCase();
  return upper && prevLower;
}

function matchPieces(pieces: string[], query: string, text: string, charMode: boolean): FuzzyMatch | null {
  if (pieces.length === 0) return null;
  const lower = text.toLowerCase();
  const ranges: [number, number][] = [];
  let pos = 0;
  let misses = 0;
  for (const piece of pieces) {
    const at = lower.indexOf(piece, pos);
    if (at < 0) return null;
    // 글자 단위일 때 바로 이어 맞은 글자는 감점하지 않는다
    if (!atWordStart(text, at) && !(charMode && at === pos)) misses++;
    const last = ranges[ranges.length - 1];
    if (last && last[1] >= at) last[1] = at + piece.length;
    else ranges.push([at, at + piece.length]);
    pos = at + piece.length;
  }
  const span = ranges[ranges.length - 1][1] - ranges[0][0];
  const score =
    -Math.max(0, ranges.length - 1) - misses / 10 - (span - query.length) / 100 - ranges[0][0] / 1000 - lower.length / 10000;
  return { score, matches: ranges };
}

/** 먼저 단어 조각으로 맞춰 보고, 안 되면 글자 하나하나를 순서대로 맞춘다 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase();
  if (q.trim() === '') return { score: 0, matches: [] };
  const words: string[] = [];
  let cur = '';
  for (const c of q) {
    if (/\s/.test(c)) {
      if (cur) words.push(cur);
      cur = '';
    } else if (isBreak(c)) {
      if (cur) words.push(cur);
      words.push(c);
      cur = '';
    } else cur += c;
  }
  if (cur) words.push(cur);
  return (
    matchPieces(words, q, text, false) ??
    matchPieces([...q].filter((c) => !/\s/.test(c)), q, text, true)
  );
}

// ───────── 노트 검색 ─────────

export interface SearchHit {
  path: string;
  /** 본문에서 맞은 줄. 파일 이름·경로·태그 조건만 있으면 비어 있다 */
  lines: { line: number; text: string }[];
}

interface Term {
  op: '' | 'file' | 'path' | 'tag' | 'task' | 'task-todo' | 'task-done' | 'line';
  value: string;
  regex: RegExp | null;
  negate: boolean;
}

/**
 * 검색어를 조건들로 나눈다. 공백으로 나뉜 조건은 모두 맞아야 한다(AND).
 * "따옴표"는 한 덩어리, -는 제외, /정규식/는 정규식, file: path: tag: task: task-todo: task-done: line: 연산자를 지원한다.
 */
export function parseQuery(query: string): Term[] {
  const terms: Term[] = [];
  const re = /(-?)(?:(file|path|tag|task-todo|task-done|task|line):)?(?:"([^"]*)"|\/((?:\\\/|[^/])+)\/|(\S+))/g;
  for (const m of query.matchAll(re)) {
    const value = m[3] ?? m[4] ?? m[5] ?? '';
    let regex: RegExp | null = null;
    if (m[4] !== undefined) {
      try {
        regex = new RegExp(m[4], 'i');
      } catch {
        regex = null;
      }
    }
    if (!value) continue;
    terms.push({ op: (m[2] ?? '') as Term['op'], value: value.toLowerCase(), regex, negate: m[1] === '-' });
  }
  return terms;
}

const EMPTY_NOTE: ParsedNote = { links: [], tags: [], tasks: [], headings: [] };

const textHas = (text: string, t: Term) => (t.regex ? t.regex.test(text) : text.toLowerCase().includes(t.value));

export function searchVault(index: VaultIndex, query: string): SearchHit[] {
  const terms = parseQuery(query);
  if (terms.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const f of index.allFiles) {
    // 마크다운이 아닌 파일은 태그·할 일이 없으므로 tag:·task: 조건이 있으면 (제외 조건이라도) 결과에서 뺀다
    const parsed = index.notes.get(f.path);
    if (!parsed && terms.some((t) => t.op === 'tag' || t.op.startsWith('task'))) continue;
    const note = parsed ?? EMPTY_NOTE;
    const lines = f.content.split('\n');
    const matched = new Map<number, string>();
    let ok = true;
    for (const t of terms) {
      let found: number[] = [];
      let fileLevel = false;
      switch (t.op) {
        case 'file':
          fileLevel = textHas(noteName(f.path), t);
          break;
        case 'path':
          fileLevel = textHas(f.path, t);
          break;
        case 'tag':
          fileLevel = hasTag(note, t.value);
          found = note.tags.filter((x) => hasTag({ ...note, tags: [x] }, t.value) && x.line > 0).map((x) => x.line);
          break;
        case 'task':
        case 'task-todo':
        case 'task-done':
          found = note.tasks
            .filter((k) => (t.op === 'task' || (t.op === 'task-done') === k.done) && textHas(k.text, t))
            .map((k) => k.line);
          break;
        default:
          // 일반 단어는 파일 이름이나 본문 어느 쪽에 있어도 된다
          fileLevel = textHas(noteName(f.path), t);
          found = lines.flatMap((l, i) => (textHas(l, t) ? [i] : []));
      }
      const hit = fileLevel || found.length > 0;
      if (hit === t.negate) {
        ok = false;
        break;
      }
      if (!t.negate) for (const i of found) matched.set(i, lines[i]);
    }
    if (!ok) continue;
    hits.push({
      path: f.path,
      lines: [...matched].sort((a, b) => a[0] - b[0]).map(([line, text]) => ({ line, text: text.trim() })),
    });
  }
  return hits.sort((a, b) => b.lines.length - a.lines.length || a.path.localeCompare(b.path));
}

/** 모든 노트의 할 일. 안 한 일 먼저, 같은 노트 안에서는 줄 순서대로 */
export function allTasks(index: VaultIndex): (NoteTask & { path: string })[] {
  const out: (NoteTask & { path: string })[] = [];
  for (const [path, note] of index.notes) for (const t of note.tasks) out.push({ ...t, path });
  return out.sort((a, b) => Number(a.done) - Number(b.done) || b.path.localeCompare(a.path) || a.line - b.line);
}

/** 그래프용 노드·간선. 못 찾은 링크와 태그는 옵션에 따라 노드로 넣는다 */
export interface GraphData {
  nodes: { id: string; label: string; kind: 'note' | 'unresolved' | 'tag'; degree: number }[];
  edges: [number, number][];
}

export function buildGraph(index: VaultIndex, opts: { tags: boolean; unresolved: boolean; focus?: string; depth?: number }): GraphData {
  const ids = new Map<string, number>();
  const nodes: GraphData['nodes'] = [];
  const edgeSet = new Set<string>();
  const edges: [number, number][] = [];
  const node = (id: string, label: string, kind: GraphData['nodes'][number]['kind']) => {
    if (!ids.has(id)) {
      ids.set(id, nodes.length);
      nodes.push({ id, label, kind, degree: 0 });
    }
    return ids.get(id)!;
  };
  const edge = (a: number, b: number) => {
    if (a === b) return;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push([a, b]);
    nodes[a].degree++;
    nodes[b].degree++;
  };
  for (const f of index.files) node(f.path, noteName(f.path), 'note');
  for (const [src, targets] of index.resolved) {
    const links = index.notes.get(src)!.links;
    targets.forEach((t, i) => {
      if (t) edge(ids.get(src)!, node(t, noteName(t), 'note'));
      else if (opts.unresolved && links[i].target && !isAttachmentTarget(links[i].target)) {
        edge(ids.get(src)!, node(`?${links[i].target.toLowerCase()}`, links[i].target, 'unresolved'));
      }
    });
    if (opts.tags) {
      for (const { tag } of index.notes.get(src)!.tags) edge(ids.get(src)!, node(`#${tag.toLowerCase()}`, `#${tag}`, 'tag'));
    }
  }
  if (!opts.focus || !ids.has(opts.focus)) return { nodes, edges };

  // 현재 노트에서 depth 단계 안에 닿는 노드만 남긴다
  const adj = nodes.map(() => [] as number[]);
  for (const [a, b] of edges) {
    adj[a].push(b);
    adj[b].push(a);
  }
  const keep = new Map<number, number>([[ids.get(opts.focus)!, 0]]);
  let frontier = [ids.get(opts.focus)!];
  for (let d = 0; d < (opts.depth ?? 1); d++) {
    const next: number[] = [];
    for (const n of frontier) for (const m of adj[n]) if (!keep.has(m)) { keep.set(m, 0); next.push(m); }
    frontier = next;
  }
  const order = [...keep.keys()];
  order.forEach((old, i) => keep.set(old, i));
  return {
    nodes: order.map((i) => ({ ...nodes[i] })),
    edges: edges.filter(([a, b]) => keep.has(a) && keep.has(b)).map(([a, b]) => [keep.get(a)!, keep.get(b)!]),
  };
}
