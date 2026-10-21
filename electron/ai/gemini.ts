// Gemini generateContent 스트리밍 어댑터(google_search 그라운딩)와 모델 목록 조회
import { geminiStreamError, isObj, makeError, parseEventJson, request, requestJson, str } from './errors';
import { isImageModel } from '../aiShared';
import { readSse } from './sse';
import type { AdapterEvent, Citation, ModelInfo, StreamOptions } from './types';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

type Json = Record<string, unknown>;

const headers = (apiKey: string): Record<string, string> => ({
  'x-goog-api-key': apiKey,
  'Content-Type': 'application/json',
});

function requestBody(opts: StreamOptions): Json {
  return {
    systemInstruction: { parts: [{ text: opts.system }] },
    contents: opts.turns.map((t) => ({ role: t.role === 'user' ? 'user' : 'model', parts: [{ text: t.text }] })),
    ...(opts.webSearch ? { tools: [{ google_search: {} }] } : {}),
    ...(isImageModel('gemini', opts.model) ? { generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } } : {}),
  };
}

const arr = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isObj) : []);

function groundingCitations(meta: Json): Citation[] {
  return arr(meta.groundingChunks)
    .map((chunk) => (isObj(chunk.web) ? chunk.web : {}))
    .filter((web) => str(web.uri) !== '')
    .map((web) => ({ url: str(web.uri), title: str(web.title) }));
}

/** 그라운딩 메타데이터는 보통 마지막 청크에만 오므로 청크마다 새 검색어만 골라 상태로 알린다 */
function* handleChunk(data: Json, seenQueries: Set<string>): Generator<AdapterEvent> {
  if (isObj(data.error)) {
    throw geminiStreamError(str(data.error.status), str(data.error.message));
  }
  const candidate = arr(data.candidates)[0];
  if (!candidate) {
    const feedback = isObj(data.promptFeedback) ? str(data.promptFeedback.blockReason) : '';
    if (feedback) throw makeError('bad-request', `요청이 차단되었습니다(${feedback})`);
    return;
  }
  const parts = isObj(candidate.content) ? arr(candidate.content.parts) : [];
  for (const part of parts) {
    if (part.thought === true) continue; // 생각 중에 만든 글·그림은 중간 결과라 보이지 않는다
    if (str(part.text)) yield { type: 'text', delta: str(part.text) };
    const inline = isObj(part.inlineData) ? part.inlineData : null;
    if (inline && str(inline.mimeType).startsWith('image/') && str(inline.data)) {
      yield { type: 'image', mimeType: str(inline.mimeType), data: str(inline.data) };
    }
  }
  const meta = isObj(candidate.groundingMetadata) ? candidate.groundingMetadata : null;
  if (!meta) return;
  const queries = (Array.isArray(meta.webSearchQueries) ? meta.webSearchQueries.map(str) : []).filter((q) => q && !seenQueries.has(q));
  for (const q of queries) {
    seenQueries.add(q);
    yield { type: 'status', text: `웹 검색 중: ${q}` };
  }
  const entry = isObj(meta.searchEntryPoint) ? str(meta.searchEntryPoint.renderedContent) : '';
  if (queries.length > 0 || entry) yield { type: 'search', queries, ...(entry ? { entryHtml: entry } : {}) };
  const citations = groundingCitations(meta);
  if (citations.length > 0) yield { type: 'citations', citations };
}

export async function* streamGemini(opts: StreamOptions): AsyncGenerator<AdapterEvent> {
  const url = `${BASE}/models/${encodeURIComponent(opts.model)}:streamGenerateContent?alt=sse`;
  const res = await request('gemini', opts.fetch, url, {
    method: 'POST', headers: headers(opts.apiKey), body: JSON.stringify(requestBody(opts)), signal: opts.signal,
  });
  if (!res.body) throw makeError('server', '응답 본문이 없습니다');
  const seenQueries = new Set<string>();
  let reason = '';
  for await (const ev of readSse(res.body)) {
    const data = parseEventJson(ev.data);
    yield* handleChunk(data, seenQueries);
    const finished = arr(data.candidates).map((c) => str(c.finishReason)).find((r) => r !== '');
    if (finished) reason = finished;
  }
  if (!reason) throw makeError('network', '응답이 완료되기 전에 연결이 끊겼습니다');
  yield { type: 'finish', reason, truncated: reason !== 'STOP' };
}

const EXCLUDED = /embedding|imagen|aqa|tts|live|veo|lyria|gemma/i;

function modelInfo(id: string, displayName: string): ModelInfo {
  const label = displayName || id;
  return isImageModel('gemini', id) ? { id, label: `${label} (이미지)`, imageOutput: true } : { id, label };
}

export async function listGeminiModels(apiKey: string, f: typeof fetch): Promise<ModelInfo[]> {
  const out: ModelInfo[] = [];
  let token = '';
  for (let page = 0; page < 50; page++) {
    const query = `pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
    const json = await requestJson('gemini', f, `${BASE}/models?${query}`, { headers: headers(apiKey) });
    for (const m of arr(json.models)) {
      const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
      const id = str(m.name).replace(/^models\//, '');
      if (id && methods.includes('generateContent') && !EXCLUDED.test(id)) out.push(modelInfo(id, str(m.displayName)));
    }
    token = str(json.nextPageToken);
    if (!token) break;
  }
  return out;
}
