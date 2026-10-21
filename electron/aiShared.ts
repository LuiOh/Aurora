// AI 메인 연결부와 화면이 함께 쓰는 설정 타입·정규화, 텍스트 조각 묶기, 채팅 파일 정렬 같은 순수 함수
import { PROVIDERS, type ChatEvent, type ChatTurn, type ErrorKind, type ModelInfo, type Provider } from './ai/types';
import { toSlash } from './paths';

export interface AiSettings {
  provider: Provider;
  models: Partial<Record<Provider, string>>;
  webSearch: boolean;
  includeNote: boolean;
  historyDir: string | null;
}

export type AiModelsResult = { ok: true; models: ModelInfo[] } | { ok: false; kind: ErrorKind; message: string };

export interface AiChatRequest { provider: Provider; model: string; system: string; turns: ChatTurn[]; webSearch: boolean }

export type KeyStorage = 'os' | 'weak' | 'unavailable';

export interface AiKeyStatus { storage: KeyStorage; keys: Record<Provider, boolean> }

export interface ChatFileInfo { path: string; name: string; mtime: number }

export const defaultAiSettings = (): AiSettings => ({
  provider: 'openai', models: {}, webSearch: true, includeNote: true, historyDir: null,
});

/** 그림을 만드는 모델인가. Gemini 모델 목록에는 출력 종류 칸이 없어 id로 가린다(imagen은 다른 API라 뺀다) */
export function isImageModel(provider: Provider, modelId: string): boolean {
  if (provider !== 'gemini') return false;
  const id = modelId.toLowerCase();
  return id === 'gemini-2.0-flash-exp' || id.includes('banana') || (id.includes('image') && !id.includes('imagen'));
}

export const isProvider = (v: unknown): v is Provider => typeof v === 'string' && (PROVIDERS as readonly string[]).includes(v);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 저장된 값이나 화면이 넘긴 값을 믿지 않고, 모르는 값·잘못된 값은 기본값으로 바꾼다 */
export function normalizeAiSettings(raw: unknown): AiSettings {
  const d = defaultAiSettings();
  if (!isRecord(raw)) return d;
  const models: Partial<Record<Provider, string>> = {};
  if (isRecord(raw.models)) {
    for (const p of PROVIDERS) {
      const m = raw.models[p];
      if (typeof m === 'string' && m.trim()) models[p] = m.trim();
    }
  }
  return {
    provider: isProvider(raw.provider) ? raw.provider : d.provider,
    models,
    webSearch: typeof raw.webSearch === 'boolean' ? raw.webSearch : d.webSearch,
    includeNote: typeof raw.includeNote === 'boolean' ? raw.includeNote : d.includeNote,
    historyDir: typeof raw.historyDir === 'string' && raw.historyDir.trim() ? raw.historyDir.trim() : d.historyDir,
  };
}

export const GEMINI_FREE_TIER_MESSAGE = '무료 요금제에서는 쓸 수 없는 모델이거나 무료 한도가 없습니다. 결제를 연결하거나 다른 모델을 고르세요.';

export const KEY_UNDECRYPTABLE_MESSAGE = '저장된 키를 풀지 못했습니다. 키체인 접근을 허용했는지 확인하거나 AI 설정에서 키를 다시 저장해 주세요.';

const MAX_MODEL_CHARS = 200;

const toTurn = (t: unknown): ChatTurn => {
  if (!isRecord(t) || (t.role !== 'user' && t.role !== 'assistant') || typeof t.text !== 'string') {
    throw new Error('대화 턴 형식이 올바르지 않습니다');
  }
  return { role: t.role, text: t.text };
};

/** 화면이 보낸 채팅 요청을 믿지 않고 모양을 확인한다. 출처는 요청에 쓰지 않으므로 버린다. 잘못되면 던진다 */
export function validateChatRequest(raw: unknown): AiChatRequest {
  if (!isRecord(raw)) throw new Error('채팅 요청 형식이 올바르지 않습니다');
  const { provider, model, system, turns, webSearch } = raw;
  if (!isProvider(provider)) throw new Error('알 수 없는 AI 공급자입니다');
  if (typeof model !== 'string' || model.length > MAX_MODEL_CHARS) throw new Error('모델 이름이 올바르지 않습니다');
  if (typeof system !== 'string') throw new Error('시스템 프롬프트가 올바르지 않습니다');
  if (typeof webSearch !== 'boolean') throw new Error('웹 검색 설정이 올바르지 않습니다');
  if (!Array.isArray(turns)) throw new Error('대화 턴 형식이 올바르지 않습니다');
  return { provider, model, system, webSearch, turns: turns.map(toTurn) };
}

/** 키 저장 수준. 리눅스 basic_text는 암호화가 사실상 없으므로 weak로 본다 */
export function keyStorageLevel(available: boolean, platform: string, linuxBackend: string): KeyStorage {
  if (!available) return 'unavailable';
  return platform === 'linux' && linuxBackend === 'basic_text' ? 'weak' : 'os';
}

/** 채팅 폴더 바로 아래 .md 파일만 골라 최근 수정 순으로 정렬한다 */
export function sortChatFiles(dir: string, entries: { name: string; isFile: boolean; mtime: number }[]): ChatFileInfo[] {
  const base = toSlash(dir);
  return entries
    .filter((e) => e.isFile && e.name.toLowerCase().endsWith('.md'))
    .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
    .map((e) => ({ path: `${base}/${e.name}`, name: e.name, mtime: e.mtime }));
}

export interface Coalescer { push(ev: ChatEvent): void; flush(): void; dispose(): void }

/** 연속된 text 조각을 windowMs 동안 또는 maxChars까지 모아 한 번에 보낸다. 다른 이벤트 앞에서는 먼저 비운다 */
export function createCoalescer(emit: (ev: ChatEvent) => void, windowMs = 16, maxChars = 2048): Coalescer {
  let buf = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const flush = () => {
    clear();
    if (!buf) return;
    const delta = buf;
    buf = '';
    emit({ type: 'text', delta });
  };
  const push = (ev: ChatEvent) => {
    if (ev.type !== 'text') {
      flush();
      emit(ev);
      return;
    }
    buf += ev.delta;
    if (buf.length >= maxChars) flush();
    else if (!timer) timer = setTimeout(flush, windowMs);
  };
  return { push, flush, dispose: clear };
}
