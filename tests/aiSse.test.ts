// SSE 파서의 청크 경계·한글 분할·필드 처리 규칙을 검사하는 단위 테스트
import { describe, expect, it } from 'vitest';
import { createSseParser, readSse, type SseEvent } from '../electron/ai/sse';

const streamOf = (chunks: Uint8Array[]): ReadableStream<Uint8Array> => new ReadableStream({
  start(controller) {
    for (const c of chunks) controller.enqueue(c);
    controller.close();
  },
});

async function collect(chunks: Uint8Array[]): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const ev of readSse(streamOf(chunks))) out.push(ev);
  return out;
}

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('SSE 파서', () => {
  it('줄 중간에서 끊긴 청크를 이어 붙인다', () => {
    const p = createSseParser();
    expect(p.push('event: a\nda')).toEqual([]);
    expect(p.push('ta: {"x":1}\n')).toEqual([]);
    expect(p.push('\n')).toEqual([{ event: 'a', data: '{"x":1}' }]);
  });

  it('여러 data 줄을 개행으로 합치고 주석 줄은 무시한다', () => {
    const p = createSseParser();
    expect(p.push(': keep-alive\ndata: 첫째\ndata:둘째\n\n')).toEqual([{ data: '첫째\n둘째' }]);
  });

  it('\\r\\n과 청크 경계에서 갈린 \\r\\n을 처리한다', () => {
    const p = createSseParser();
    expect(p.push('data: a\r')).toEqual([]);
    expect(p.push('\n\r\ndata: b\r\n\r\n')).toEqual([{ data: 'a' }, { data: 'b' }]);
  });

  it('마지막 빈 줄 없이 끝난 이벤트도 내보내고 [DONE]은 건너뛴다', () => {
    const p = createSseParser();
    expect(p.push('data: [DONE]\n\ndata: 끝')).toEqual([]);
    expect(p.end()).toEqual([{ data: '끝' }]);
  });

  it('한글 멀티바이트 문자가 청크 사이에서 갈려도 깨지지 않는다', async () => {
    const all = bytes('data: {"t":"안녕하세요"}\n\n');
    const cut = all.indexOf(0xec) + 1;
    const events = await collect([all.slice(0, cut), all.slice(cut, cut + 1), all.slice(cut + 1)]);
    expect(events).toEqual([{ data: '{"t":"안녕하세요"}' }]);
  });

  it('바이트 하나씩 들어와도 같은 결과를 낸다', async () => {
    const all = bytes('event: x\r\ndata: 가나\r\n\r\ndata: 다\n');
    const events = await collect(Array.from(all, (b) => new Uint8Array([b])));
    expect(events).toEqual([{ event: 'x', data: '가나' }, { data: '다' }]);
  });
});
