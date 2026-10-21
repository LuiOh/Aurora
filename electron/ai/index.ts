// AI 채팅 코어 진입점 — 공급자 어댑터를 골라 ChatEvent 스트림과 모델 목록을 제공한다
import { listAnthropicModels, streamAnthropic } from './anthropic';
import { dedupeCitations } from './context';
import { makeError, toAiError } from './errors';
import { listGeminiModels, streamGemini } from './gemini';
import { listOpenAIModels, streamOpenAI } from './openai';
import type { AdapterEvent, ChatEvent, Citation, ListModelsOptions, ModelInfo, Provider, StreamOptions } from './types';

export * from './types';
export { answerToMarkdown, buildSystemPrompt, DEFAULT_BUDGET_CHARS } from './context';
export { chatFileName, parseChat, serializeChat, type SavedChat } from './history';

/** 2026-10-20 기준 각 공급자 모델 문서의 권장(균형형) 모델 — 목록 조회 실패 시 대체값 */
export const DEFAULT_MODELS: Record<Provider, string> = {
  openai: 'gpt-6.1-sol',
  anthropic: 'claude-sonnet-5-5',
  gemini: 'gemini-3.8-flash',
};

const ADAPTERS: Record<Provider, (opts: StreamOptions) => AsyncGenerator<AdapterEvent>> = {
  openai: streamOpenAI,
  anthropic: streamAnthropic,
  gemini: streamGemini,
};

const LISTERS: Record<Provider, (apiKey: string, f: typeof fetch) => Promise<ModelInfo[]>> = {
  openai: listOpenAIModels,
  anthropic: listAnthropicModels,
  gemini: listGeminiModels,
};

const checkAbort = (signal: AbortSignal): void => {
  if (signal.aborted) throw makeError('aborted', '');
};

const BLOCKED_REASON = /safety|refusal|recitation|blocklist|prohibited|spii|content_filter|image_other|no_image/i;
const LENGTH_REASON = /max_tokens|max_output_tokens/i;
const IMAGE_REASON = /^(image_\w+|no_image)$/i;

/** 그림을 만들지 못한 이유를 사람이 읽을 문구로 바꾼다. 그림과 관계없는 이유면 null */
function imageFailureText(reason: string): string | null {
  if (/^no_image$/i.test(reason)) return '모델이 이미지를 만들지 않았습니다';
  return IMAGE_REASON.test(reason) ? `이미지를 만들지 못했습니다 (사유: ${reason})` : null;
}

/** 빈 답을 오류 하나로 바꾼다. 차단·거절이면 bad-request, 그 밖에는 server로 본다 */
export function emptyAnswerError(reason: string): ChatEvent {
  const kind = BLOCKED_REASON.test(reason) ? 'bad-request' : 'server';
  return { type: 'error', kind, message: imageFailureText(reason) ?? `AI가 빈 답을 보냈습니다 (사유: ${reason || '알 수 없음'})` };
}

export function truncationNotice(reason: string): string {
  if (LENGTH_REASON.test(reason)) return '답이 길이 제한에 걸려 잘렸습니다';
  return imageFailureText(reason) ?? `답이 끝까지 오지 않았을 수 있습니다 (사유: ${reason})`;
}

/** 절대 throw하지 않는다 — 성공은 done 하나, 실패(빈 답 포함)는 error 하나로 끝난다 */
export async function* streamChat(opts: StreamOptions): AsyncGenerator<ChatEvent> {
  let text = '';
  let imageCount = 0;
  let citations: Citation[] = [];
  const queries: string[] = [];
  let entryHtml = '';
  let finish: { reason: string; truncated: boolean } = { reason: '', truncated: false };
  try {
    checkAbort(opts.signal);
    for await (const ev of ADAPTERS[opts.provider](opts)) {
      checkAbort(opts.signal);
      if (ev.type === 'citations') citations = dedupeCitations([...citations, ...ev.citations]);
      else if (ev.type === 'finish') finish = { reason: ev.reason, truncated: ev.truncated };
      else if (ev.type === 'search') {
        for (const q of ev.queries ?? []) if (!queries.includes(q)) queries.push(q);
        if (ev.entryHtml) entryHtml = ev.entryHtml;
      } else {
        if (ev.type === 'text') text += ev.delta;
        else if (ev.type === 'image') imageCount++;
        yield ev;
      }
    }
    checkAbort(opts.signal);
  } catch (err) {
    const e = toAiError(err, opts.signal);
    yield { type: 'error', kind: e.kind, message: e.message };
    return;
  }
  if (!text.trim() && imageCount === 0) {
    yield emptyAnswerError(finish.reason);
    return;
  }
  yield {
    type: 'done', text: text.trim() ? text : '', citations,
    ...(imageCount > 0 ? { imageCount } : {}),
    ...(finish.truncated ? { notice: truncationNotice(finish.reason) } : {}),
    ...(queries.length > 0 ? { searchQueries: queries } : {}),
    ...(entryHtml ? { searchEntryHtml: entryHtml } : {}),
  };
}

/** 실패하면 kind가 붙은 AiError를 던진다 */
export async function listModels(opts: ListModelsOptions): Promise<ModelInfo[]> {
  try {
    return await LISTERS[opts.provider](opts.apiKey, opts.fetch);
  } catch (err) {
    throw toAiError(err);
  }
}
