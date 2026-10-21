// 채팅 기록을 마크다운 파일로 직렬화·역직렬화하고 파일 이름을 만드는 모듈
import { citationLine, escapeLinkUrl } from './context';
import { PROVIDERS, type Citation, type ChatTurn, type Provider } from './types';

export interface SavedChat { provider: Provider; model: string; created: string; updated: string; turns: ChatTurn[] }

const USER_HEADER = '## 나';
const AI_HEADER = '## AI';
const SOURCES_HEADER = '### 출처';
const IMAGES_HEADER = '### 이미지';

/** 본문 안에 구분 줄과 똑같은 줄이 있으면 역슬래시를 하나 더 붙여 구분 줄과 겹치지 않게 한다(역변환 가능) */
const RESERVED_LINE = /^\\*(## 나|## AI|### 출처|### 이미지)$/;
const escapeBody = (text: string): string[] => text.split('\n').map((l) => (RESERVED_LINE.test(l) ? `\\${l}` : l));
const unescapeBody = (lines: string[]): string => lines.map((l) => (RESERVED_LINE.test(l) && l.startsWith('\\') ? l.slice(1) : l)).join('\n');

const FRONT_KEYS = ['provider', 'model', 'created', 'updated'] as const;

export function serializeChat(chat: SavedChat): string {
  const lines = ['---', ...FRONT_KEYS.map((k) => `${k}: ${JSON.stringify(chat[k])}`), '---', ''];
  for (const turn of chat.turns) {
    lines.push(turn.role === 'user' ? USER_HEADER : AI_HEADER, '', ...escapeBody(turn.text));
    if (turn.role === 'assistant' && turn.images && turn.images.length > 0) {
      lines.push('', IMAGES_HEADER, '', ...turn.images.map((p) => `- ![](<${escapeLinkUrl(p)}>)`));
    }
    if (turn.role === 'assistant' && turn.citations && turn.citations.length > 0) {
      lines.push('', SOURCES_HEADER, '', ...turn.citations.map(citationLine));
    }
    lines.push('');
  }
  return lines.join('\n');
}

const unescapeMd = (s: string): string => s.replace(/\\([\\[\]<>])/g, '$1');

/** citationLine이 만든 `- [제목](<url>)` 한 줄을 되읽는다 */
function parseCitation(line: string): Citation | null {
  const m = /^- \[((?:\\.|[^\\\]])*)\]\(<((?:\\.|[^\\>])*)>\)$/.exec(line);
  if (!m) return null;
  const url = unescapeMd(m[2]);
  const title = unescapeMd(m[1]);
  return { url, title: title === url ? '' : title };
}

/** 값은 JSON 문자열로 쓰지만, 사람이 따옴표 없이 고친 값도 받아 준다 */
function frontValue(raw: string): string {
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'string' ? v : raw.trim();
  } catch {
    return raw.trim();
  }
}

function parseFrontmatter(lines: string[]): { fields: Record<string, string>; end: number } | null {
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const m = /^(\w+):\s?(.*)$/.exec(line);
    if (m) fields[m[1]] = frontValue(m[2]);
  }
  return { fields, end };
}

/** `- ![](<경로>)` 한 줄을 되읽는다 */
function parseImageLine(line: string): string | null {
  const m = /^- !\[\]\(<((?:\\.|[^\\>])*)>\)$/.exec(line);
  return m ? unescapeMd(m[1]) : null;
}

/** 본문 끝의 `### 머리` 칸을 떼어 낸다. 칸 모양이 아니거나 줄을 못 읽으면 null */
function splitSection<T>(body: string[], header: string, parse: (line: string) => T | null): { rest: string[]; items: T[] } | null {
  const idx = body.lastIndexOf(header);
  if (idx < 1 || body[idx - 1] !== '' || body[idx + 1] !== '') return null;
  const items = body.slice(idx + 2).map(parse);
  if (items.some((c) => c === null)) return null;
  return { rest: body.slice(0, idx - 1), items: items.filter((c): c is T => c !== null) };
}

function parseAssistant(body: string[]): ChatTurn {
  const sources = splitSection(body, SOURCES_HEADER, parseCitation);
  const beforeSources = sources ? sources.rest : body;
  const images = splitSection(beforeSources, IMAGES_HEADER, parseImageLine);
  const turn: ChatTurn = { role: 'assistant', text: unescapeBody(images ? images.rest : beforeSources) };
  if (images) turn.images = images.items;
  if (sources) turn.citations = sources.items;
  return turn;
}

/** 기록 폴더 밖이나 절대 경로를 가리키지 않는 상대 경로인가. 기록 파일은 사람이 고칠 수 있으므로 열 때 확인한다 */
export function isSafeRelativePath(rel: string): boolean {
  if (!rel || /^[\\/]|^[a-z]:/i.test(rel) || rel.includes('\0')) return false;
  return rel.split(/[\\/]/).every((seg) => seg !== '..' && seg !== '');
}

export function parseChat(markdown: string): SavedChat | null {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const parsed = parseFrontmatter(lines);
  if (!parsed) return null;
  const front = parsed.fields;
  const provider = PROVIDERS.find((p) => p === front.provider);
  if (!provider || !front.model) return null;
  const headers: number[] = [];
  lines.forEach((l, i) => { if (i > parsed.end && (l === USER_HEADER || l === AI_HEADER)) headers.push(i); });
  const turns = headers.map((h, n): ChatTurn => {
    const next = n + 1 < headers.length ? headers[n + 1] : lines.length;
    // 헤더 다음 빈 줄과 섹션 끝 빈 줄은 serializeChat이 넣은 구분자다
    const body = lines.slice(h + 2, Math.max(h + 2, next - 1));
    return lines[h] === USER_HEADER ? { role: 'user', text: unescapeBody(body) } : parseAssistant(body);
  });
  return { provider, model: front.model, created: front.created ?? '', updated: front.updated ?? '', turns };
}

const pad = (n: number): string => String(n).padStart(2, '0');

export function chatFileName(created: Date, firstQuestion: string): string {
  const stamp = `${created.getFullYear()}-${pad(created.getMonth() + 1)}-${pad(created.getDate())} ${pad(created.getHours())}${pad(created.getMinutes())}`;
  const cleaned = firstQuestion
    .normalize('NFC')
    .replace(/[<>:"|?*/\\\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const title = Array.from(cleaned).slice(0, 30).join('').replace(/[\s.]+$/, '') || '대화';
  return `${stamp} ${title}.md`;
}

/** 이름이 겹칠 때 쓸 후보. n이 1이면 그대로, 2부터는 확장자 앞에 ' (n)'을 붙인다 */
export function numberedFileName(name: string, n: number): string {
  if (n <= 1) return name;
  const dot = name.toLowerCase().endsWith('.md') ? name.length - 3 : name.length;
  return `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
}
