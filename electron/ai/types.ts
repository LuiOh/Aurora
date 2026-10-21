// AI 채팅 코어가 공유하는 공급자·대화·이벤트·오류 타입 정의
export type Provider = 'openai' | 'anthropic' | 'gemini';

export const PROVIDERS: readonly Provider[] = ['openai', 'anthropic', 'gemini'];

export interface Citation { url: string; title: string; snippet?: string }

/** images는 대화 기록 폴더 기준 상대 경로다. 요청에는 보내지 않는다 */
export interface ChatTurn { role: 'user' | 'assistant'; text: string; citations?: Citation[]; images?: string[] }

export type ErrorKind = 'auth' | 'quota' | 'rate' | 'network' | 'bad-request' | 'server' | 'aborted';

export type ChatEvent =
  | { type: 'text'; delta: string }
  | { type: 'status'; text: string }
  /** 모델이 만든 그림 한 장. data는 받은 그대로의 base64다 */
  | { type: 'image'; mimeType: string; data: string }
  | {
    type: 'done'; text: string; citations: Citation[]; searchQueries?: string[]; searchEntryHtml?: string; notice?: string;
    imageCount?: number;
  }
  | { type: 'error'; kind: ErrorKind; message: string };

export interface ModelInfo { id: string; label: string; webSearch?: boolean; imageOutput?: boolean }

export interface StreamOptions {
  provider: Provider;
  model: string;
  apiKey: string;
  system: string;
  turns: ChatTurn[];
  webSearch: boolean;
  signal: AbortSignal;
  fetch: typeof fetch;
}

export interface ListModelsOptions { provider: Provider; apiKey: string; fetch: typeof fetch }

/** 어댑터가 내보내는 중간 이벤트 — done 조립은 공통 드라이버가 맡는다 */
export type AdapterEvent =
  | { type: 'text'; delta: string }
  | { type: 'status'; text: string }
  | { type: 'image'; mimeType: string; data: string }
  | { type: 'citations'; citations: Citation[] }
  | { type: 'search'; queries?: string[]; entryHtml?: string }
  /** 공급자가 알린 끝난 이유. truncated면 답이 중간에 끊겼다 */
  | { type: 'finish'; reason: string; truncated: boolean };

/** 분류된 오류 — 어댑터와 listModels가 던지고 드라이버가 error 이벤트로 바꾼다 */
export class AiError extends Error {
  readonly kind: ErrorKind;
  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.name = 'AiError';
    this.kind = kind;
  }
}
