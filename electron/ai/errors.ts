// HTTP 응답·예외를 공급자별 규칙에 따라 ErrorKind로 분류하고 공통 fetch 호출을 감싸는 모듈
import { GEMINI_FREE_TIER_MESSAGE } from '../aiShared';
import { AiError, type ErrorKind, type Provider } from './types';

const KIND_LABEL: Record<ErrorKind, string> = {
  auth: 'API 키 인증 실패',
  quota: '사용 한도·잔액 부족',
  rate: '요청이 너무 많음',
  network: '네트워크 오류',
  'bad-request': '잘못된 요청',
  server: '서버 오류',
  aborted: '중단됨',
};

interface ParsedBody { message: string; code: string; status: string; reasons: string[] }

type Json = Record<string, unknown>;

export const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 세 공급자의 오류 본문 모양({error:{message,code|type,status,details}})을 하나로 읽는다 */
function parseErrorBody(text: string): ParsedBody {
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = undefined; }
  const err = isObj(json) && isObj(json.error) ? json.error : isObj(json) ? json : {};
  const details = Array.isArray(err.details) ? err.details : [];
  return {
    message: str(err.message) || text.slice(0, 300),
    code: str(err.code) || str(err.type),
    status: str(err.status),
    reasons: details.filter(isObj).map((d) => str(d.reason)).filter(Boolean),
  };
}

/** Gemini 무료 키로 쓸 수 없는 모델은 한도 0인 RESOURCE_EXHAUSTED로 거절된다 */
const isGeminiFreeTierBlock = (status: string, message: string): boolean =>
  /^resource_exhausted$/i.test(status) && /limit:\s*0\b|free_tier/i.test(message);

function kindFor(provider: Provider, status: number, b: ParsedBody): ErrorKind {
  if (provider === 'gemini' && (b.reasons.includes('API_KEY_INVALID') || /api key not valid/i.test(b.message))) return 'auth';
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'quota';
  if (status === 429) {
    if (provider === 'openai') return b.code === 'insufficient_quota' ? 'quota' : 'rate';
    return /billing|credit|prepay/i.test(b.message) ? 'quota' : 'rate';
  }
  if (provider === 'anthropic' && status === 400 && /credit balance/i.test(b.message)) return 'quota';
  if (status === 408) return 'network';
  if (status >= 500) return 'server';
  return 'bad-request';
}

export function makeError(kind: ErrorKind, detail: string): AiError {
  return new AiError(kind, detail ? `${KIND_LABEL[kind]}: ${detail}` : KIND_LABEL[kind]);
}

export function httpError(provider: Provider, status: number, bodyText: string): AiError {
  const body = parseErrorBody(bodyText);
  if (provider === 'gemini' && status === 429 && isGeminiFreeTierBlock(body.status, body.message)) {
    return makeError('quota', `${GEMINI_FREE_TIER_MESSAGE} (HTTP ${status} ${body.message})`);
  }
  return makeError(kindFor(provider, status, body), `HTTP ${status} ${body.message}`.trim());
}

/** Gemini 스트림 안에 온 오류. 무료 요금제로 막힌 모델이면 quota로 본다 */
export function geminiStreamError(status: string, message: string): AiError {
  if (isGeminiFreeTierBlock(status, message)) return makeError('quota', `${GEMINI_FREE_TIER_MESSAGE} (${message})`);
  return makeError(streamErrorKind(status), message || status);
}

/** 스트림 도중 오는 오류 이벤트의 code/type 문자열을 분류한다 */
export function streamErrorKind(code: string): ErrorKind {
  if (/insufficient_quota|billing|credit/i.test(code)) return 'quota';
  if (/rate_limit|too_many|resource_exhausted/i.test(code)) return 'rate';
  if (/auth|permission|api_key/i.test(code)) return 'auth';
  if (/invalid_request|invalid_prompt|invalid_argument|bad_request|not_found|failed_precondition/i.test(code)) return 'bad-request';
  return 'server';
}

/** fetch가 던진 예외를 분류한다 — 중단 신호가 켜져 있으면 무엇이든 aborted로 본다 */
export function toAiError(err: unknown, signal?: AbortSignal): AiError {
  if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) return makeError('aborted', '');
  if (err instanceof AiError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return makeError('network', message);
}

/** 요청을 보내고 2xx가 아니면 분류된 AiError를 던진다 */
export async function request(
  provider: Provider, f: typeof fetch, url: string, init: RequestInit,
): Promise<Response> {
  let res: Response;
  try {
    res = await f(url, init);
  } catch (err) {
    throw toAiError(err, init.signal ?? undefined);
  }
  if (!res.ok) throw httpError(provider, res.status, await res.text().catch(() => ''));
  return res;
}

/** SSE data 줄의 JSON을 읽는다 — 깨진 JSON은 공급자 쪽 문제이므로 server로 분류한다 */
export function parseEventJson(data: string): Json {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    throw makeError('server', `스트림 데이터를 해석할 수 없습니다: ${data.slice(0, 100)}`);
  }
  return isObj(json) ? json : {};
}

export async function requestJson(provider: Provider, f: typeof fetch, url: string, init: RequestInit): Promise<Json> {
  const res = await request(provider, f, url, init);
  const json: unknown = await res.json().catch(() => undefined);
  if (!isObj(json)) throw makeError('server', '응답을 해석할 수 없습니다');
  return json;
}
