// 세 공급자 어댑터의 스트림 해석·오류 분류·모델 목록을 가짜 fetch로 검사하는 단위 테스트
import { describe, expect, it } from 'vitest';
import { AiError, listModels, streamChat, type ChatEvent, type Provider } from '../electron/ai';

interface Call { url: string; init: RequestInit }

const sse = (events: [string | null, unknown][]): string =>
  events.map(([name, data]) => `${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(data)}\n\n`).join('');

/** 본문을 작은 조각으로 쪼개 보내 청크 경계 처리까지 함께 검사한다 */
function bodyStream(text: string, signal?: AbortSignal | null, hang = false): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
      if (!hang) controller.close();
    },
  });
}

type Reply = { status?: number; body: string; hang?: boolean } | Error;

function fakeFetch(replies: Reply[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    const reply = replies.shift();
    if (!reply) throw new Error('예상하지 못한 요청');
    if (reply instanceof Error) throw reply;
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return new Response(bodyStream(reply.body, init?.signal, reply.hang), { status: reply.status ?? 200 });
  };
  return { fetch: impl, calls };
}

async function run(provider: Provider, replies: Reply[], webSearch = true, signal = new AbortController().signal) {
  const fake = fakeFetch(replies);
  const events: ChatEvent[] = [];
  for await (const ev of streamChat({
    provider, model: 'm-1', apiKey: 'k', system: '시스템', webSearch, signal, fetch: fake.fetch,
    turns: [{ role: 'user', text: '서울 날씨?' }],
  })) events.push(ev);
  return { events, calls: fake.calls };
}

const bodyOf = (call: Call): Record<string, unknown> => JSON.parse(String(call.init.body));

const OPENAI_STREAM = sse([
  ['response.created', { type: 'response.created', response: { id: 'r1' } }],
  ['response.output_item.added', { type: 'response.output_item.added', item: { type: 'web_search_call', id: 'ws1', status: 'in_progress' } }],
  ['response.web_search_call.searching', { type: 'response.web_search_call.searching', item_id: 'ws1' }],
  ['response.output_item.done', { type: 'response.output_item.done', item: { type: 'web_search_call', id: 'ws1', action: { type: 'search', query: '서울 날씨' } } }],
  ['response.output_text.delta', { type: 'response.output_text.delta', delta: '오늘 서울은 ' }],
  ['response.output_text.annotation.added', { type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', url: 'https://a.example/w', title: '날씨 A', start_index: 0, end_index: 5 } }],
  ['response.output_text.delta', { type: 'response.output_text.delta', delta: '맑습니다.' }],
  ['response.completed', { type: 'response.completed', response: { output: [
    { type: 'web_search_call', id: 'ws1' },
    { type: 'message', content: [{ type: 'output_text', text: '오늘 서울은 맑습니다.', annotations: [
      { type: 'url_citation', url: 'https://a.example/w', title: '날씨 A' },
      { type: 'url_citation', url: 'https://b.example/x', title: '날씨 B' },
    ] }] },
  ] } }],
]);

const ANTHROPIC_PAUSED = sse([
  ['message_start', { type: 'message_start', message: { id: 'msg1' } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"서울' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ' 날씨"}' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://a.example/w', title: '날씨 A', encrypted_content: 'enc' }] } }],
  ['content_block_stop', { type: 'content_block_stop', index: 1 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'pause_turn' } }],
  ['message_stop', { type: 'message_stop' }],
]);

const ANTHROPIC_FINAL = sse([
  ['message_start', { type: 'message_start', message: { id: 'msg2' } }],
  ['ping', { type: 'ping' }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '오늘 서울은 맑습니다.' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://a.example/w', title: '날씨 A', cited_text: '맑음', encrypted_index: 'ei' } } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
  ['message_stop', { type: 'message_stop' }],
]);

const GEMINI_STREAM = sse([
  [null, { candidates: [{ content: { role: 'model', parts: [{ text: '오늘 서울은 ' }] } }] }],
  [null, { candidates: [{ content: { role: 'model', parts: [{ text: '맑습니다.' }] }, finishReason: 'STOP', groundingMetadata: {
    webSearchQueries: ['서울 날씨'],
    searchEntryPoint: { renderedContent: '<div>검색 제안</div>' },
    groundingChunks: [{ web: { uri: 'https://vertexaisearch.cloud.google.com/a', title: 'a.example' } }, { web: { uri: 'https://vertexaisearch.cloud.google.com/a', title: 'a.example' } }],
  } }] }],
]);

describe('OpenAI 어댑터', () => {
  it('웹 검색·본문·인용을 순서대로 이벤트로 바꾼다', async () => {
    const { events, calls } = await run('openai', [{ body: OPENAI_STREAM }]);
    expect(events).toEqual([
      { type: 'status', text: '웹 검색 중…' },
      { type: 'status', text: '웹 검색 중: 서울 날씨' },
      { type: 'text', delta: '오늘 서울은 ' },
      { type: 'text', delta: '맑습니다.' },
      { type: 'done', text: '오늘 서울은 맑습니다.', searchQueries: ['서울 날씨'], citations: [
        { url: 'https://a.example/w', title: '날씨 A' }, { url: 'https://b.example/x', title: '날씨 B' },
      ] },
    ]);
    expect(calls[0].url).toBe('https://api.openai.com/v1/responses');
    expect(bodyOf(calls[0])).toMatchObject({ instructions: '시스템', stream: true, tools: [{ type: 'web_search' }], input: [{ role: 'user', content: '서울 날씨?' }] });
  });

  it('웹 검색을 끄면 tools를 보내지 않는다', async () => {
    const { calls } = await run('openai', [{ body: OPENAI_STREAM }], false);
    expect(bodyOf(calls[0]).tools).toBeUndefined();
  });

  it('스트림 중 response.failed를 오류 하나로 끝낸다', async () => {
    const body = sse([['response.output_text.delta', { type: 'response.output_text.delta', delta: '부분' }],
      ['response.failed', { type: 'response.failed', response: { error: { code: 'server_error', message: '실패' } } }]]);
    const { events } = await run('openai', [{ body }]);
    expect(events.at(-1)).toMatchObject({ type: 'error', kind: 'server' });
    expect(events.filter((e) => e.type === 'done' || e.type === 'error')).toHaveLength(1);
  });

  it('completed 없이 끊기면 network 오류다', async () => {
    const body = sse([['response.output_text.delta', { type: 'response.output_text.delta', delta: '부분' }]]);
    const { events } = await run('openai', [{ body }]);
    expect(events.at(-1)).toMatchObject({ type: 'error', kind: 'network' });
  });
});

describe('Anthropic 어댑터', () => {
  it('pause_turn이면 받은 블록을 붙여 다시 요청하고 인용을 모은다', async () => {
    const { events, calls } = await run('anthropic', [{ body: ANTHROPIC_PAUSED }, { body: ANTHROPIC_FINAL }]);
    expect(events).toEqual([
      { type: 'status', text: '웹 검색 중: 서울 날씨' },
      { type: 'status', text: '검색을 이어서 진행 중…' },
      { type: 'text', delta: '오늘 서울은 맑습니다.' },
      { type: 'done', text: '오늘 서울은 맑습니다.', searchQueries: ['서울 날씨'], citations: [
        { url: 'https://a.example/w', title: '날씨 A', snippet: '맑음' },
      ] },
    ]);
    const first = bodyOf(calls[0]);
    expect(first).toMatchObject({ system: '시스템', max_tokens: 8192, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] });
    expect(calls[0].init.headers).toMatchObject({ 'x-api-key': 'k', 'anthropic-version': '2023-06-01' });
    const messages = bodyOf(calls[1]).messages as { role: string; content: unknown }[];
    expect(messages[1]).toEqual({ role: 'assistant', content: [
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: '서울 날씨' } },
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://a.example/w', title: '날씨 A', encrypted_content: 'enc' }] },
    ] });
  });

  it('검색 도구 오류는 HTTP 200이어도 상태로만 알린다', async () => {
    const body = sse([
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'web_search_tool_result', tool_use_id: 's', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } } }],
      ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '답' } }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
    ]);
    const { events } = await run('anthropic', [{ body }]);
    expect(events[0]).toEqual({ type: 'status', text: '웹 검색 실패: 검색 횟수 한도 도달' });
    expect(events.at(-1)).toEqual({ type: 'done', text: '답', citations: [] });
  });

  it('스트림 error 이벤트(overloaded)를 server로 분류한다', async () => {
    const body = sse([['error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]]);
    const { events } = await run('anthropic', [{ body }]);
    expect(events).toEqual([{ type: 'error', kind: 'server', message: expect.stringContaining('Overloaded') }]);
  });
});

describe('Gemini 어댑터', () => {
  it('그라운딩 메타데이터에서 검색어·출처·검색 제안 HTML을 꺼낸다', async () => {
    const { events, calls } = await run('gemini', [{ body: GEMINI_STREAM }]);
    expect(events).toEqual([
      { type: 'text', delta: '오늘 서울은 ' },
      { type: 'text', delta: '맑습니다.' },
      { type: 'status', text: '웹 검색 중: 서울 날씨' },
      { type: 'done', text: '오늘 서울은 맑습니다.', searchQueries: ['서울 날씨'], searchEntryHtml: '<div>검색 제안</div>',
        citations: [{ url: 'https://vertexaisearch.cloud.google.com/a', title: 'a.example' }] },
    ]);
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/m-1:streamGenerateContent?alt=sse');
    expect(bodyOf(calls[0])).toMatchObject({ systemInstruction: { parts: [{ text: '시스템' }] }, tools: [{ google_search: {} }], contents: [{ role: 'user', parts: [{ text: '서울 날씨?' }] }] });
    expect(calls[0].init.headers).toMatchObject({ 'x-goog-api-key': 'k' });
  });
});

describe('HTTP 오류 분류', () => {
  const cases: [Provider, number, unknown, string][] = [
    ['openai', 401, { error: { message: 'bad key', code: 'invalid_api_key' } }, 'auth'],
    ['openai', 429, { error: { message: 'quota', code: 'insufficient_quota' } }, 'quota'],
    ['openai', 429, { error: { message: 'slow down', code: 'rate_limit_exceeded' } }, 'rate'],
    ['openai', 400, { error: { message: 'bad' } }, 'bad-request'],
    ['openai', 503, { error: { message: 'down' } }, 'server'],
    ['anthropic', 401, { type: 'error', error: { type: 'authentication_error', message: 'x' } }, 'auth'],
    ['anthropic', 403, { type: 'error', error: { type: 'permission_error', message: 'x' } }, 'auth'],
    ['anthropic', 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } }, 'quota'],
    ['anthropic', 429, { type: 'error', error: { type: 'rate_limit_error', message: 'x' } }, 'rate'],
    ['anthropic', 529, { type: 'error', error: { type: 'overloaded_error', message: 'x' } }, 'server'],
    ['gemini', 400, { error: { code: 400, message: 'API key not valid.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }, 'auth'],
    ['gemini', 403, { error: { code: 403, message: 'denied', status: 'PERMISSION_DENIED' } }, 'auth'],
    ['gemini', 429, { error: { code: 429, message: 'Resource exhausted', status: 'RESOURCE_EXHAUSTED' } }, 'rate'],
    ['gemini', 400, { error: { code: 400, message: 'bad model', status: 'INVALID_ARGUMENT' } }, 'bad-request'],
  ];
  it.each(cases)('%s HTTP %i → 분류', async (provider, status, body, kind) => {
    const { events } = await run(provider, [{ status, body: JSON.stringify(body) }]);
    expect(events).toEqual([{ type: 'error', kind, message: expect.any(String) }]);
  });
});

describe('네트워크·중단', () => {
  it('fetch가 TypeError를 던지면 network', async () => {
    const { events } = await run('openai', [new TypeError('fetch failed')]);
    expect(events).toEqual([{ type: 'error', kind: 'network', message: expect.stringContaining('fetch failed') }]);
  });

  it('시작 전에 중단되면 요청 없이 aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const { events, calls } = await run('anthropic', [{ body: ANTHROPIC_FINAL }], true, ctrl.signal);
    expect(events).toEqual([{ type: 'error', kind: 'aborted', message: expect.any(String) }]);
    expect(calls).toHaveLength(0);
  });

  it('스트림 도중 중단되면 받은 글자 뒤에 aborted 하나로 끝난다', async () => {
    const ctrl = new AbortController();
    const fake = fakeFetch([{ body: sse([[null, { candidates: [{ content: { parts: [{ text: '가' }] } }] }]]), hang: true }]);
    const events: ChatEvent[] = [];
    for await (const ev of streamChat({ provider: 'gemini', model: 'm', apiKey: 'k', system: '', turns: [], webSearch: false, signal: ctrl.signal, fetch: fake.fetch })) {
      events.push(ev);
      if (ev.type === 'text') ctrl.abort();
    }
    expect(events).toEqual([{ type: 'text', delta: '가' }, { type: 'error', kind: 'aborted', message: expect.any(String) }]);
  });
});

describe('모델 목록', () => {
  it('OpenAI는 채팅 모델만 남기고 페이지를 넘긴다', async () => {
    const fake = fakeFetch([
      { body: JSON.stringify({ data: [{ id: 'gpt-6.1-sol' }, { id: 'text-embedding-3-large' }, { id: 'gpt-realtime' }], has_more: true, last_id: 'gpt-realtime' }) },
      { body: JSON.stringify({ data: [{ id: 'gpt-image-2' }, { id: 'gpt-6-luna' }, { id: 'whisper-1' }, { id: 'gpt-5-search-api' }], has_more: false }) },
    ]);
    const models = await listModels({ provider: 'openai', apiKey: 'k', fetch: fake.fetch });
    expect(models.map((m) => m.id).sort()).toEqual(['gpt-6-luna', 'gpt-6.1-sol']);
    expect(fake.calls[1].url).toBe('https://api.openai.com/v1/models?after=gpt-realtime');
  });

  it('Anthropic은 활성 모델과 웹 검색 지원 여부를 페이지별로 모은다', async () => {
    const fake = fakeFetch([
      { body: JSON.stringify({ data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', capabilities: { server_tools: { web_search: { supported: true } } } }], has_more: true, last_id: 'claude-sonnet-5-5' }) },
      { body: JSON.stringify({ data: [{ id: 'claude-old', display_name: 'Old', capabilities: { server_tools: { web_search: { supported: false } } } }], has_more: false, last_id: 'claude-old' }) },
    ]);
    const models = await listModels({ provider: 'anthropic', apiKey: 'k', fetch: fake.fetch });
    expect(models).toEqual([
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', webSearch: true },
      { id: 'claude-old', label: 'Old', webSearch: false },
    ]);
    expect(fake.calls[0].url).toContain('lifecycle=active');
    expect(fake.calls[1].url).toContain('after_id=claude-sonnet-5-5');
  });

  it('Gemini는 generateContent 지원 모델만 남기고 models/ 접두어를 뗀다', async () => {
    const fake = fakeFetch([
      { body: JSON.stringify({ models: [
        { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
      ], nextPageToken: 'p2' }) },
      { body: JSON.stringify({ models: [
        { name: 'models/imagen-5', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.8-flash-tts', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', supportedGenerationMethods: ['generateContent'] },
      ] }) },
    ]);
    const models = await listModels({ provider: 'gemini', apiKey: 'k', fetch: fake.fetch });
    expect(models).toEqual([{ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }, { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' }]);
    expect(fake.calls[1].url).toContain('pageToken=p2');
  });

  it('실패하면 kind가 붙은 AiError를 던진다', async () => {
    const fake = fakeFetch([{ status: 401, body: JSON.stringify({ error: { message: 'bad key' } }) }]);
    const err = await listModels({ provider: 'openai', apiKey: 'k', fetch: fake.fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err).toMatchObject({ kind: 'auth' });
  });
});

describe('빈 답·잘린 답 처리', () => {
  it('Gemini가 SAFETY로 빈 답을 내면 bad-request 오류 하나로 끝난다', async () => {
    const body = sse([[null, { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'SAFETY' }] }]]);
    const { events } = await run('gemini', [{ body }]);
    expect(events).toEqual([{ type: 'error', kind: 'bad-request', message: 'AI가 빈 답을 보냈습니다 (사유: SAFETY)' }]);
  });

  it('Gemini가 MAX_TOKENS로 끝나면 done에 잘림 안내를 붙인다', async () => {
    const body = sse([[null, { candidates: [{ content: { role: 'model', parts: [{ text: '부분' }] }, finishReason: 'MAX_TOKENS' }] }]]);
    const { events } = await run('gemini', [{ body }]);
    expect(events.at(-1)).toEqual({ type: 'done', text: '부분', citations: [], notice: '답이 길이 제한에 걸려 잘렸습니다' });
  });

  it('OpenAI response.incomplete는 사유를 안내로 남긴다', async () => {
    const body = sse([
      ['response.output_text.delta', { type: 'response.output_text.delta', delta: '부분' }],
      ['response.incomplete', { type: 'response.incomplete', response: { output: [], incomplete_details: { reason: 'max_output_tokens' } } }],
    ]);
    const { events } = await run('openai', [{ body }]);
    expect(events.at(-1)).toMatchObject({ type: 'done', text: '부분', notice: '답이 길이 제한에 걸려 잘렸습니다' });
  });

  it('OpenAI가 글 없이 끝나면 server 오류다', async () => {
    const body = sse([['response.completed', { type: 'response.completed', response: { output: [] } }]]);
    const { events } = await run('openai', [{ body }]);
    expect(events).toEqual([{ type: 'error', kind: 'server', message: 'AI가 빈 답을 보냈습니다 (사유: completed)' }]);
  });

  it('Claude가 refusal로 빈 답을 내면 bad-request 오류다', async () => {
    const body = sse([['message_delta', { type: 'message_delta', delta: { stop_reason: 'refusal' } }]]);
    const { events } = await run('anthropic', [{ body }]);
    expect(events).toEqual([{ type: 'error', kind: 'bad-request', message: 'AI가 빈 답을 보냈습니다 (사유: refusal)' }]);
  });

  it('Claude max_tokens는 done에 안내를 붙인다', async () => {
    const body = sse([
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '부분' } }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }],
    ]);
    const { events } = await run('anthropic', [{ body }]);
    expect(events.at(-1)).toEqual({ type: 'done', text: '부분', citations: [], notice: '답이 길이 제한에 걸려 잘렸습니다' });
  });

  it('Claude 이어받기 한도에 닿으면 잘림 안내를 붙인다', async () => {
    const paused = sse([
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '가' } }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'pause_turn' } }],
    ]);
    const { events, calls } = await run('anthropic', [{ body: paused }, { body: paused }, { body: paused }, { body: paused }]);
    expect(calls).toHaveLength(4);
    expect(events.at(-1)).toMatchObject({ type: 'done', text: '가가가가', notice: expect.stringContaining('pause_turn') });
  });
});

describe('Claude thinking 서명 보존', () => {
  it('pause_turn 뒤 이어받기 요청에 thinking과 signature를 그대로 되돌려 보낸다', async () => {
    const paused = sse([
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '생각 ' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '중' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'pause_turn' } }],
    ]);
    const { events, calls } = await run('anthropic', [{ body: paused }, { body: ANTHROPIC_FINAL }]);
    expect(events.at(-1)).toMatchObject({ type: 'done', text: '오늘 서울은 맑습니다.' });
    const messages = bodyOf(calls[1]).messages as { role: string; content: unknown }[];
    expect(messages[1]).toEqual({ role: 'assistant', content: [{ type: 'thinking', thinking: '생각 중', signature: 'sig-abc' }] });
  });
});

describe('쓸 수 없는 모델 빼기', () => {
  it('OpenAI instruct 모델을 뺀다', async () => {
    const fake = fakeFetch([{ body: JSON.stringify({ data: [{ id: 'gpt-3.5-turbo-instruct' }, { id: 'gpt-6-luna' }], has_more: false }) }]);
    const models = await listModels({ provider: 'openai', apiKey: 'k', fetch: fake.fetch });
    expect(models.map((m) => m.id)).toEqual(['gpt-6-luna']);
  });
  it('Gemini gemma 모델을 뺀다', async () => {
    const fake = fakeFetch([{ body: JSON.stringify({ models: [
      { name: 'models/gemma-4-27b-it', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent'] },
    ] }) }]);
    const models = await listModels({ provider: 'gemini', apiKey: 'k', fetch: fake.fetch });
    expect(models.map((m) => m.id)).toEqual(['gemini-3.8-flash']);
  });
});
