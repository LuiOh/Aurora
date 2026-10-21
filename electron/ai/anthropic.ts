// Anthropic Messages API 스트리밍 어댑터(web_search_20250305 서버 도구, pause_turn 이어받기)와 모델 목록 조회
import { isObj, makeError, parseEventJson, request, requestJson, str, streamErrorKind } from './errors';
import { readSse } from './sse';
import type { AdapterEvent, Citation, ModelInfo, StreamOptions } from './types';

const BASE = 'https://api.anthropic.com/v1';
const MAX_TOKENS = 8192;
const MAX_CONTINUATIONS = 3;
const COMPLETE_STOPS = new Set(['end_turn', 'stop_sequence']);

type Json = Record<string, unknown>;

const headers = (apiKey: string): Record<string, string> => ({
  'x-api-key': apiKey,
  'anthropic-version': '2023-06-01',
  'content-type': 'application/json',
});

const SEARCH_ERRORS: Record<string, string> = {
  too_many_requests: '검색 요청이 너무 많음',
  max_uses_exceeded: '검색 횟수 한도 도달',
  query_too_long: '검색어가 너무 김',
  invalid_tool_input: '잘못된 검색어',
  unavailable: '검색 서비스 일시 오류',
};

/** 한 번의 요청 스트림을 읽으며 콘텐츠 블록을 원형 그대로 복원한다 — pause_turn 때 그대로 되돌려 보내야 하기 때문이다 */
class TurnState {
  blocks: Json[] = [];
  private json = new Map<number, string>();
  stopReason = '';

  *handle(data: Json): Generator<AdapterEvent> {
    const index = typeof data.index === 'number' ? data.index : -1;
    switch (data.type) {
      case 'content_block_start':
        if (isObj(data.content_block)) yield* this.start(index, { ...data.content_block });
        break;
      case 'content_block_delta':
        if (isObj(data.delta)) yield* this.delta(index, data.delta);
        break;
      case 'content_block_stop':
        yield* this.stop(index);
        break;
      case 'message_delta':
        if (isObj(data.delta) && str(data.delta.stop_reason)) this.stopReason = str(data.delta.stop_reason);
        break;
      case 'error': {
        const err = isObj(data.error) ? data.error : {};
        throw makeError(streamErrorKind(str(err.type)), str(err.message) || str(err.type));
      }
      default:
        break;
    }
  }

  private *start(index: number, block: Json): Generator<AdapterEvent> {
    this.blocks[index] = block;
    if (block.type === 'server_tool_use') this.json.set(index, '');
    if (block.type === 'web_search_tool_result' && isObj(block.content)) {
      const code = str(block.content.error_code);
      yield { type: 'status', text: `웹 검색 실패: ${SEARCH_ERRORS[code] ?? code}` };
    }
  }

  private *delta(index: number, delta: Json): Generator<AdapterEvent> {
    const block = this.blocks[index];
    if (!block) return;
    if (delta.type === 'text_delta' && str(delta.text)) {
      block.text = str(block.text) + str(delta.text);
      yield { type: 'text', delta: str(delta.text) };
    } else if (delta.type === 'thinking_delta') {
      block.thinking = str(block.thinking) + str(delta.thinking);
    } else if (delta.type === 'signature_delta') {
      block.signature = str(block.signature) + str(delta.signature);
    } else if (delta.type === 'input_json_delta') {
      this.json.set(index, (this.json.get(index) ?? '') + str(delta.partial_json));
    } else if (delta.type === 'citations_delta' && isObj(delta.citation)) {
      block.citations = [...(Array.isArray(block.citations) ? block.citations : []), delta.citation];
      const c = toCitation(delta.citation);
      if (c) yield { type: 'citations', citations: [c] };
    }
  }

  private *stop(index: number): Generator<AdapterEvent> {
    const block = this.blocks[index];
    const raw = this.json.get(index);
    if (!block || raw === undefined) return;
    this.json.delete(index);
    const input = raw ? parseEventJson(raw) : {};
    block.input = input;
    const query = str(input.query);
    if (block.name === 'web_search' && query) {
      yield { type: 'status', text: `웹 검색 중: ${query}` };
      yield { type: 'search', queries: [query] };
    }
  }
}

function toCitation(c: Json): Citation | null {
  if (c.type !== 'web_search_result_location' || !str(c.url)) return null;
  const snippet = str(c.cited_text);
  return snippet ? { url: str(c.url), title: str(c.title), snippet } : { url: str(c.url), title: str(c.title) };
}

/** 이전 턴은 평문으로 보낸다 — 암호화된 검색 블록을 저장하지 않으므로 맥락은 텍스트로만 이어진다 */
function baseMessages(opts: StreamOptions): Json[] {
  return opts.turns.map((t) => ({ role: t.role, content: t.text }));
}

export async function* streamAnthropic(opts: StreamOptions): AsyncGenerator<AdapterEvent> {
  const tools = opts.webSearch ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] : undefined;
  const assistant: Json[] = [];
  for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
    const messages = assistant.length > 0 ? [...baseMessages(opts), { role: 'assistant', content: assistant }] : baseMessages(opts);
    const body = { model: opts.model, max_tokens: MAX_TOKENS, system: opts.system, messages, stream: true, ...(tools ? { tools } : {}) };
    const res = await request('anthropic', opts.fetch, `${BASE}/messages`, {
      method: 'POST', headers: headers(opts.apiKey), body: JSON.stringify(body), signal: opts.signal,
    });
    if (!res.body) throw makeError('server', '응답 본문이 없습니다');
    const turn = new TurnState();
    for await (const ev of readSse(res.body)) {
      if (ev.event === 'ping') continue;
      yield* turn.handle(parseEventJson(ev.data));
    }
    if (!turn.stopReason) throw makeError('network', '응답이 완료되기 전에 연결이 끊겼습니다');
    if (turn.stopReason !== 'pause_turn') {
      yield { type: 'finish', reason: turn.stopReason, truncated: !COMPLETE_STOPS.has(turn.stopReason) };
      return;
    }
    assistant.push(...turn.blocks.filter(isObj));
    if (attempt < MAX_CONTINUATIONS) yield { type: 'status', text: '검색을 이어서 진행 중…' };
  }
  yield { type: 'finish', reason: 'pause_turn', truncated: true };
}

export async function listAnthropicModels(apiKey: string, f: typeof fetch): Promise<ModelInfo[]> {
  const out: ModelInfo[] = [];
  let after = '';
  for (let page = 0; page < 50; page++) {
    const query = `limit=1000&lifecycle=active${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
    const json = await requestJson('anthropic', f, `${BASE}/models?${query}`, { headers: headers(apiKey) });
    for (const m of Array.isArray(json.data) ? json.data.filter(isObj) : []) {
      const id = str(m.id);
      if (!id) continue;
      const caps = isObj(m.capabilities) ? m.capabilities : {};
      const tools = isObj(caps.server_tools) ? caps.server_tools : {};
      const ws = isObj(tools.web_search) ? tools.web_search.supported : undefined;
      out.push({ id, label: str(m.display_name) || id, ...(typeof ws === 'boolean' ? { webSearch: ws } : {}) });
    }
    after = json.has_more === true ? str(json.last_id) : '';
    if (!after) break;
  }
  return out;
}
