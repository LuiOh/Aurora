// fetch 응답 본문(ReadableStream)을 Server-Sent Events 단위로 나누는 파서
export interface SseEvent { event?: string; data: string }

/** 줄 단위 상태 기계 — 청크 경계와 무관하게 이벤트를 조립한다 */
export function createSseParser(): { push(text: string): SseEvent[]; end(): SseEvent[] } {
  let buffer = '';
  let dataLines: string[] = [];
  let eventName: string | undefined;

  const flush = (out: SseEvent[]): void => {
    if (dataLines.length > 0) {
      const data = dataLines.join('\n');
      if (data !== '[DONE]') out.push(eventName === undefined ? { data } : { event: eventName, data });
    }
    dataLines = [];
    eventName = undefined;
  };

  const handleLine = (line: string, out: SseEvent[]): void => {
    if (line === '') return flush(out);
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') eventName = value;
  };

  const drain = (final: boolean): SseEvent[] => {
    const out: SseEvent[] = [];
    let idx: number;
    while ((idx = buffer.search(/\r\n|\r|\n/)) >= 0) {
      // 청크 끝의 단독 \r은 다음 청크의 \n과 짝일 수 있으므로 보류한다
      if (!final && buffer[idx] === '\r' && idx === buffer.length - 1) break;
      const sepLen = buffer.startsWith('\r\n', idx) ? 2 : 1;
      handleLine(buffer.slice(0, idx), out);
      buffer = buffer.slice(idx + sepLen);
    }
    if (final) {
      if (buffer !== '') handleLine(buffer, out);
      buffer = '';
      flush(out);
    }
    return out;
  };

  // 그림이 든 data 줄은 수 MB라, 줄 끝이 없는 조각은 모아 두기만 하고 줄 끝이 왔을 때 한 번만 합쳐 훑는다
  let tail: string[] = [];
  return {
    push(text: string) {
      const last = tail[tail.length - 1] ?? '';
      if (!/[\r\n]/.test(text) && !last.endsWith('\r')) {
        tail.push(text);
        return [];
      }
      buffer = tail.join('') + text;
      tail = [];
      const out = drain(false);
      if (buffer) tail = [buffer];
      buffer = '';
      return out;
    },
    end() {
      buffer = tail.join('');
      tail = [];
      return drain(true);
    },
  };
}

/** 바이트 스트림을 읽어 SSE 이벤트를 차례로 내보낸다 — 한글 멀티바이트 분할은 TextDecoder stream 모드가 처리한다 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const parser = createSseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield* parser.push(decoder.decode(value, { stream: true }));
    }
    yield* parser.push(decoder.decode());
    yield* parser.end();
  } finally {
    reader.releaseLock();
  }
}
