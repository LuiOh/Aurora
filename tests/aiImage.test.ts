// Gemini 이미지 모델 판별·요청·그림 이벤트·기록 저장 형식과 화면 도우미를 검사하는 단위 테스트
import { describe, expect, it } from 'vitest';
import { listModels, parseChat, serializeChat, streamChat, type ChatEvent, type SavedChat } from '../electron/ai';
import { isSafeRelativePath } from '../electron/ai/history';
import { readSse } from '../electron/ai/sse';
import { createCoalescer, isImageModel, validateChatRequest } from '../electron/aiShared';
import {
  IMAGE_ANSWER_MARK, answerWithImagesMarkdown, base64ToBytes, buildChatRequest, settleTurns,
} from '../src/lib/aiChat';
import { aiImageName, imageExt } from '../src/lib/attachments';
import { defaultAiSettings } from '../electron/aiShared';

const sse = (chunks: unknown[]): string => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('');

function streamOf(text: string, size = 65536): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    },
  });
}

function fakeFetch(bodies: string[]): { fetch: typeof fetch; bodies: unknown[] } {
  const sent: unknown[] = [];
  const impl = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.body) sent.push(JSON.parse(String(init.body)));
    const body = bodies.shift();
    if (body === undefined) throw new Error('예상하지 못한 요청');
    return new Response(streamOf(body, 13), { status: 200 });
  };
  return { fetch: impl, bodies: sent };
}

async function runGemini(model: string, body: string, webSearch = false) {
  const fake = fakeFetch([body]);
  const events: ChatEvent[] = [];
  for await (const ev of streamChat({
    provider: 'gemini', model, apiKey: 'k', system: '시스템', webSearch, signal: new AbortController().signal, fetch: fake.fetch,
    turns: [{ role: 'user', text: '고양이 그려 줘' }],
  })) events.push(ev);
  return { events, sent: fake.bodies[0] as Record<string, unknown> };
}

const PNG = 'iVBORw0KGgo=';

describe('isImageModel 이미지 모델 판별', () => {
  it('Gemini 이미지·나노 바나나 모델을 알아본다', () => {
    for (const id of ['nano-banana-pro-preview', 'gemini-nano-banana-2.1', 'gemini-3-pro-image', 'gemini-3.1-flash-image', 'gemini-2.0-flash-exp']) {
      expect(isImageModel('gemini', id)).toBe(true);
    }
  });

  it('imagen, 글 모델, 다른 회사 모델은 아니다', () => {
    expect(isImageModel('gemini', 'imagen-5')).toBe(false);
    expect(isImageModel('gemini', 'gemini-3.8-flash')).toBe(false);
    expect(isImageModel('openai', 'gpt-image-2')).toBe(false);
  });
});

describe('Gemini 이미지 모델 목록', () => {
  it('이미지 모델은 남기고 (이미지)를 붙이며 imagen은 뺀다', async () => {
    const list = JSON.stringify({ models: [
      { name: 'models/gemini-3-pro-image', displayName: 'Nano Banana Pro', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/imagen-5', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent'] },
    ] });
    const f = (async () => new Response(list, { status: 200 })) as typeof fetch;
    expect(await listModels({ provider: 'gemini', apiKey: 'k', fetch: f })).toEqual([
      { id: 'gemini-3-pro-image', label: 'Nano Banana Pro (이미지)', imageOutput: true },
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    ]);
  });
});

describe('Gemini 그림 응답', () => {
  const imageStream = sse([
    { candidates: [{ content: { role: 'model', parts: [{ text: '생각 중', thought: true }, { inlineData: { mimeType: 'image/png', data: 'AAAA' }, thought: true }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: PNG }, thoughtSignature: 'sig' }] }, finishReason: 'STOP' }] },
  ]);

  it('이미지 모델 요청에 TEXT·IMAGE 출력과 검색 도구를 넣고 온도 값은 넣지 않는다', async () => {
    const { sent } = await runGemini('gemini-3-pro-image', imageStream, true);
    expect(sent.generationConfig).toEqual({ responseModalities: ['TEXT', 'IMAGE'] });
    expect(sent.tools).toEqual([{ google_search: {} }]);
  });

  it('글 모델 요청에는 generationConfig를 넣지 않는다', async () => {
    const { sent } = await runGemini('gemini-3.8-flash', sse([{ candidates: [{ content: { parts: [{ text: '답' }] }, finishReason: 'STOP' }] }]));
    expect(sent.generationConfig).toBeUndefined();
  });

  it('생각 중 그림은 버리고, 그림만 온 답은 글 없이 성공한다', async () => {
    const { events } = await runGemini('gemini-3-pro-image', imageStream);
    expect(events).toEqual([
      { type: 'image', mimeType: 'image/png', data: PNG },
      { type: 'done', text: '', citations: [], imageCount: 1 },
    ]);
  });

  it('글과 그림이 함께 오면 둘 다 내보낸다', async () => {
    const body = sse([{ candidates: [{ content: { parts: [{ text: '여기 있어요' }, { inlineData: { mimeType: 'image/jpeg', data: PNG } }] }, finishReason: 'STOP' }] }]);
    const { events } = await runGemini('gemini-3-pro-image', body);
    expect(events.map((e) => e.type)).toEqual(['text', 'image', 'done']);
    expect(events.at(-1)).toMatchObject({ text: '여기 있어요', imageCount: 1 });
  });

  it('IMAGE_SAFETY로 아무것도 없으면 이유를 붙인 bad-request로 끝난다', async () => {
    const { events } = await runGemini('gemini-3-pro-image', sse([{ candidates: [{ content: { parts: [] }, finishReason: 'IMAGE_SAFETY' }] }]));
    expect(events).toEqual([{ type: 'error', kind: 'bad-request', message: '이미지를 만들지 못했습니다 (사유: IMAGE_SAFETY)' }]);
  });

  it('NO_IMAGE면 모델이 그림을 만들지 않았다고 알린다', async () => {
    const { events } = await runGemini('gemini-3-pro-image', sse([{ candidates: [{ content: { parts: [] }, finishReason: 'NO_IMAGE' }] }]));
    expect(events).toEqual([{ type: 'error', kind: 'bad-request', message: '모델이 이미지를 만들지 않았습니다' }]);
  });

  it('글은 왔지만 IMAGE_OTHER로 끝나면 done에 그림 실패 안내를 붙인다', async () => {
    const { events } = await runGemini('gemini-3-pro-image', sse([{ candidates: [{ content: { parts: [{ text: '설명' }] }, finishReason: 'IMAGE_OTHER' }] }]));
    expect(events.at(-1)).toMatchObject({ type: 'done', text: '설명', notice: '이미지를 만들지 못했습니다 (사유: IMAGE_OTHER)' });
  });
});

describe('큰 그림 SSE', () => {
  it('수 MB짜리 data 한 줄이 여러 청크로 나뉘어 와도 하나로 읽는다', async () => {
    const big = 'A'.repeat(6 * 1024 * 1024);
    const text = `data: {"d":"${big}"}\r\n\r\ndata: 끝\n\n`;
    const out: string[] = [];
    for await (const ev of readSse(streamOf(text, 65537))) out.push(ev.data);
    expect(out).toHaveLength(2);
    expect(out[0].length).toBe(big.length + 8);
    expect(out[1]).toBe('끝');
  });
});

describe('IPC 묶기와 그림', () => {
  it('그림 앞에 모아 둔 글을 먼저 보내고 그림은 그대로 넘긴다', () => {
    const sent: ChatEvent[] = [];
    const co = createCoalescer((ev) => sent.push(ev));
    co.push({ type: 'text', delta: '가' });
    co.push({ type: 'text', delta: '나' });
    co.push({ type: 'image', mimeType: 'image/png', data: PNG });
    co.dispose();
    expect(sent).toEqual([{ type: 'text', delta: '가나' }, { type: 'image', mimeType: 'image/png', data: PNG }]);
  });
});

describe('그림이 든 대화 기록', () => {
  const chat: SavedChat = {
    provider: 'gemini', model: 'gemini-3-pro-image', created: 'c', updated: 'u',
    turns: [
      { role: 'user', text: '고양이' },
      { role: 'assistant', text: '', images: ['첨부/2026-10-21 0834 고양이 그림 1.png'] },
      { role: 'user', text: '하나 더' },
      {
        role: 'assistant', text: '두 장입니다\n### 이미지', images: ['첨부/a <b> 2.jpg', '첨부/한글 이름 3.png'],
        citations: [{ url: 'https://a.example/x', title: '출처' }],
      },
    ],
  };

  it('이미지 칸을 출처 앞에 쓰고 되읽는다', () => {
    const md = serializeChat(chat);
    expect(md).toContain('### 이미지\n\n- ![](<첨부/2026-10-21 0834 고양이 그림 1.png>)');
    expect(md.indexOf('- ![](<첨부/한글')).toBeLessThan(md.indexOf('### 출처'));
    expect(md).not.toMatch(/base64|data:image/);
    expect(parseChat(md)?.turns).toEqual(chat.turns);
  });

  it('그림 없는 답은 images 없이 되읽는다', () => {
    const parsed = parseChat(serializeChat({ ...chat, turns: [{ role: 'user', text: '질문' }, { role: 'assistant', text: '답' }] }));
    expect(parsed?.turns[1]).toEqual({ role: 'assistant', text: '답' });
  });

  it('기록 폴더 밖을 가리키는 경로는 받지 않는다', () => {
    expect(isSafeRelativePath('첨부/a b.png')).toBe(true);
    for (const bad of ['../x.png', '첨부/../../x.png', '/etc/x.png', 'C:/x.png', '\\\\srv\\x.png', '']) expect(isSafeRelativePath(bad)).toBe(false);
  });
});

describe('그림 답과 요청', () => {
  it('글 없는 그림 답은 자리표시 글로 보내고 그림 경로는 보내지 않는다', () => {
    const req = buildChatRequest(defaultAiSettings(), 's', [
      { role: 'user', text: '그려 줘' },
      { role: 'assistant', text: '', images: ['첨부/a.png'] },
      { role: 'user', text: '고마워' },
    ]);
    expect(req.turns[1]).toEqual({ role: 'assistant', text: IMAGE_ANSWER_MARK });
    expect(validateChatRequest({ ...req, turns: [{ role: 'assistant', text: 'x', images: ['a'] }] }).turns).toEqual([{ role: 'assistant', text: 'x' }]);
  });

  it('그림을 받은 뒤 중지하면 글이 없어도 답을 남긴다', () => {
    const r = settleTurns([{ role: 'user', text: '그려 줘' }], { type: 'error', kind: 'aborted', partial: '', images: 1 });
    expect(r.answered).toBe(true);
    expect(r.turns[1]).toEqual({ role: 'assistant', text: '' });
  });

  it('노트에 넣을 글은 글, 그림, 출처 순서다', () => {
    const md = answerWithImagesMarkdown('설명\n', ['![](<첨부/AI 이미지.png>)'], [{ url: 'https://a.example', title: 'A' }]);
    expect(md).toBe('설명\n\n![](<첨부/AI 이미지.png>)\n\n**출처**\n\n- [A](<https://a.example>)\n');
    expect(answerWithImagesMarkdown('', ['![](<첨부/x.png>)'], [])).toBe('![](<첨부/x.png>)');
    expect(answerWithImagesMarkdown('글만\n', [], [])).toBe('글만\n');
  });

  it('그림 이름과 확장자, base64 풀기', () => {
    expect(aiImageName(new Date(2026, 9, 21, 8, 34), 'image/png')).toBe('AI 이미지 2026-10-21 0834.png');
    expect(imageExt('image/jpeg')).toBe('jpg');
    expect(imageExt('image/unknown')).toBe('png');
    expect([...base64ToBytes('AQID')]).toEqual([1, 2, 3]);
  });
});
