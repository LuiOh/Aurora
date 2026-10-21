// AI 채팅 화면이 쓰는 순수 로직 — 오류 문구, 턴 정리, 요청 조립, 모델 선택지
import { answerToMarkdown } from '../../electron/ai/context';
import type { Citation, ChatTurn, ErrorKind, ModelInfo, Provider } from '../../electron/ai/types';
import { GEMINI_FREE_TIER_MESSAGE, KEY_UNDECRYPTABLE_MESSAGE, type AiChatRequest, type AiModelsResult, type AiSettings } from '../../electron/aiShared';

export const PROVIDER_LABELS: Record<Provider, string> = { openai: 'OpenAI', anthropic: 'Claude', gemini: 'Gemini' };

export function errorText(kind: ErrorKind, message: string): string {
  switch (kind) {
    case 'auth': return message === KEY_UNDECRYPTABLE_MESSAGE ? message : 'API 키가 올바르지 않습니다. AI 설정에서 키를 확인해 주세요.';
    case 'quota': return message.includes(GEMINI_FREE_TIER_MESSAGE) ? GEMINI_FREE_TIER_MESSAGE : '사용 한도나 크레딧이 부족합니다.';
    case 'rate': return '요청이 너무 잦습니다. 잠시 뒤 다시 시도해 주세요.';
    case 'network': return '네트워크에 연결할 수 없습니다.';
    case 'aborted': return '중지했습니다.';
    case 'bad-request': return `요청이 거부되었습니다: ${message}`;
    case 'server': return `AI 서버 오류: ${message}`;
  }
}

export type StreamOutcome =
  | { type: 'done'; text: string; citations: Citation[] }
  | { type: 'error'; kind: ErrorKind; partial: string; images?: number };

/**
 * 마지막 사용자 턴에 대한 응답 결과로 대화 턴을 정리한다.
 * 답이 남으면 assistant 턴을 붙이고, 남을 답이 없으면 사용자 턴을 빼서 입력란에 되돌릴 글을 돌려준다
 */
export function settleTurns(turns: ChatTurn[], outcome: StreamOutcome): { turns: ChatTurn[]; restore: string | null; answered: boolean } {
  const last = turns[turns.length - 1];
  if (!last || last.role !== 'user') return { turns, restore: null, answered: false };
  if (outcome.type === 'done') {
    return { turns: [...turns, { role: 'assistant', text: outcome.text, citations: outcome.citations }], restore: null, answered: true };
  }
  if (outcome.kind === 'aborted' && (outcome.partial.trim() || (outcome.images ?? 0) > 0)) {
    return { turns: [...turns, { role: 'assistant', text: outcome.partial }], restore: null, answered: true };
  }
  return { turns: turns.slice(0, -1), restore: last.text, answered: false };
}

export const EMPTY_ANSWER_MARK = '(빈 답변)';
export const IMAGE_ANSWER_MARK = '(이미지를 만들어 보여 주었습니다)';

/**
 * 설정과 대화로 보낼 요청을 만든다. 모델이 비면 메인 프로세스가 기본 모델을 고른다.
 * 그림은 보내지 않는다. 글 없는 답은 자리표시 글로 바꿔 공급자가 거절하지 않게 한다
 */
export function buildChatRequest(settings: AiSettings, system: string, turns: ChatTurn[]): AiChatRequest {
  const provider = settings.provider;
  const safeTurns = turns.map(({ images, ...t }): ChatTurn => {
    if (t.role !== 'assistant' || t.text.trim()) return t;
    return { ...t, text: images && images.length > 0 ? IMAGE_ANSWER_MARK : EMPTY_ANSWER_MARK };
  });
  return { provider, model: settings.models[provider] ?? '', system, turns: safeTurns, webSearch: settings.webSearch };
}

/** 출처 주소를 링크로 걸어도 되는지 — http(s)만 허용한다 */
export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false; // 주소 모양이 아니면 링크로 걸지 않는다
  }
}

export interface ModelOption { id: string; label: string }

/** 모델 선택지. 목록을 못 가져왔으면 저장된 모델(없으면 '기본 모델')만 둔다. 저장된 모델이 목록에 없으면 앞에 붙인다 */
export function modelOptions(saved: string, list: ModelInfo[] | null): ModelOption[] {
  const base: ModelOption[] = list ? list.map((m) => ({ id: m.id, label: m.label || m.id })) : [];
  if (!list || list.length === 0) return [saved ? { id: saved, label: saved } : { id: '', label: '기본 모델' }];
  if (saved && !base.some((m) => m.id === saved)) base.unshift({ id: saved, label: saved });
  if (!saved) base.unshift({ id: '', label: '기본 모델' });
  return base;
}

export function modelsResultText(res: AiModelsResult): string {
  return res.ok ? `저장했습니다 · 모델 ${res.models.length}개` : errorText(res.kind, res.message);
}

/** 노트에 넣을 답. 글 다음에 그림 링크, 그 뒤에 출처를 둔다 */
export function answerWithImagesMarkdown(text: string, imageLines: string[], citations: Citation[]): string {
  const body = [text.trimEnd(), imageLines.join('\n')].filter(Boolean).join('\n\n');
  return answerToMarkdown(imageLines.length > 0 ? body : text, citations);
}

/** base64 글을 바이트로 바꾼다 */
export function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 웹 검색을 켰는데 출처가 하나도 없을 때 답 아래에 보일 안내. 보일 게 없으면 빈 글 */
export function missingSourcesNotice(webSearch: boolean, citations: Citation[], searchQueries?: string[]): string {
  if (!webSearch || citations.some((c) => c.url)) return '';
  return searchQueries && searchQueries.length > 0
    ? '검색했지만 인용한 출처가 없습니다'
    : '검색 출처 없음 · 모델이 웹 검색을 하지 않았을 수 있습니다';
}
