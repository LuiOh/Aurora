// OpenAI Responses API 스트리밍 어댑터(내장 web_search 도구)와 모델 목록 조회
import { isObj, makeError, parseEventJson, request, requestJson, str, streamErrorKind } from './errors';
import { readSse } from './sse';
import type { AdapterEvent, Citation, ModelInfo, StreamOptions } from './types';

const BASE = 'https://api.openai.com/v1';

type Json = Record<string, unknown>;

const headers = (apiKey: string): Record<string, string> => ({
  Authorization: `Bearer ${apiKey}`,
  'Content-Type': 'application/json',
});

function requestBody(opts: StreamOptions): Json {
  return {
    model: opts.model,
    instructions: opts.system,
    input: opts.turns.map((t) => ({ role: t.role, content: t.text })),
    stream: true,
    store: false,
    ...(opts.webSearch ? { tools: [{ type: 'web_search' }] } : {}),
  };
}

function urlCitation(a: unknown): Citation | null {
  if (!isObj(a) || a.type !== 'url_citation' || !str(a.url)) return null;
  return { url: str(a.url), title: str(a.title) };
}

/** web_search_call.action은 query 하나 또는 queries 배열을 줄 수 있다 */
function searchQueries(item: Json): string[] {
  const action = isObj(item.action) ? item.action : {};
  const list = Array.isArray(action.queries) ? action.queries.map(str) : [];
  return [...list, str(action.query)].filter((q, i, all) => q !== '' && all.indexOf(q) === i);
}

/** response.completed의 최종 output에서 인용을 다시 모아 스트림 중 누락분을 보완한다 */
function citationsFromOutput(output: unknown): Citation[] {
  if (!Array.isArray(output)) return [];
  const contents = output.filter(isObj).flatMap((item) => (Array.isArray(item.content) ? item.content : []));
  return contents.filter(isObj)
    .flatMap((c) => (Array.isArray(c.annotations) ? c.annotations : []))
    .map(urlCitation)
    .filter((c): c is Citation => c !== null);
}

function failure(err: unknown): Error {
  const e = isObj(err) ? err : {};
  const code = str(e.code) || str(e.type);
  return makeError(streamErrorKind(code), str(e.message) || code || '응답 생성 실패');
}

function* handleEvent(data: Json): Generator<AdapterEvent, boolean> {
  const item = isObj(data.item) ? data.item : {};
  switch (data.type) {
    case 'response.output_text.delta':
      if (str(data.delta)) yield { type: 'text', delta: str(data.delta) };
      return false;
    case 'response.web_search_call.searching':
      yield { type: 'status', text: '웹 검색 중…' };
      return false;
    case 'response.output_item.done':
      if (item.type === 'web_search_call') {
        const queries = searchQueries(item);
        for (const q of queries) yield { type: 'status', text: `웹 검색 중: ${q}` };
        if (queries.length > 0) yield { type: 'search', queries };
      }
      return false;
    case 'response.output_text.annotation.added': {
      const c = urlCitation(data.annotation);
      if (c) yield { type: 'citations', citations: [c] };
      return false;
    }
    case 'response.completed':
    case 'response.incomplete': {
      const response = isObj(data.response) ? data.response : {};
      yield { type: 'citations', citations: citationsFromOutput(response.output) };
      if (data.type === 'response.completed') yield { type: 'finish', reason: 'completed', truncated: false };
      else {
        const details = isObj(response.incomplete_details) ? response.incomplete_details : {};
        yield { type: 'finish', reason: str(details.reason) || 'incomplete', truncated: true };
      }
      return true;
    }
    case 'response.failed':
      throw failure(isObj(data.response) ? data.response.error : undefined);
    case 'error':
      throw failure(data);
    default:
      return false;
  }
}

export async function* streamOpenAI(opts: StreamOptions): AsyncGenerator<AdapterEvent> {
  const res = await request('openai', opts.fetch, `${BASE}/responses`, {
    method: 'POST', headers: headers(opts.apiKey), body: JSON.stringify(requestBody(opts)), signal: opts.signal,
  });
  if (!res.body) throw makeError('server', '응답 본문이 없습니다');
  for await (const ev of readSse(res.body)) {
    if (yield* handleEvent(parseEventJson(ev.data))) return;
  }
  throw makeError('network', '응답이 완료되기 전에 연결이 끊겼습니다');
}

const EXCLUDED = /embedding|tts|whisper|dall-e|image|realtime|audio|moderation|transcribe|search|instruct/i;
const CHAT_PREFIX = /^(gpt-|chatgpt-|o\d|codex-)/i;

export async function listOpenAIModels(apiKey: string, f: typeof fetch): Promise<ModelInfo[]> {
  const out: ModelInfo[] = [];
  let after = '';
  for (let page = 0; page < 50; page++) {
    const json = await requestJson('openai', f, `${BASE}/models${after ? `?after=${encodeURIComponent(after)}` : ''}`, {
      headers: headers(apiKey),
    });
    const data = Array.isArray(json.data) ? json.data.filter(isObj) : [];
    for (const m of data) {
      const id = str(m.id);
      if (id && CHAT_PREFIX.test(id) && !EXCLUDED.test(id)) out.push({ id, label: id });
    }
    after = json.has_more === true ? str(json.last_id) || str(data[data.length - 1]?.id) : '';
    if (!after) break;
  }
  return out.sort((a, b) => b.id.localeCompare(a.id));
}
