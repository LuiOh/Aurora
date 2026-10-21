// Gemini 무료 요금제로 막힌 모델(한도 0)을 요금제 안내로 분류하는지 검사하는 단위 테스트
import { describe, expect, it } from 'vitest';
import { geminiStreamError, httpError } from '../electron/ai/errors';
import { GEMINI_FREE_TIER_MESSAGE } from '../electron/aiShared';
import { errorText } from '../src/lib/aiChat';

const body = (message: string, status = 'RESOURCE_EXHAUSTED') => JSON.stringify({ error: { code: 429, message, status } });

const FREE_TIER_MSG = 'You exceeded your current quota. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3-pro-image';

describe('Gemini 무료 요금제 한도 분류', () => {
  it('limit: 0이나 free_tier가 든 429는 quota와 요금제 안내가 된다', () => {
    const e = httpError('gemini', 429, body(FREE_TIER_MSG));
    expect(e.kind).toBe('quota');
    expect(e.message).toContain(GEMINI_FREE_TIER_MESSAGE);
    expect(e.message).toContain('limit: 0');
    expect(httpError('gemini', 429, body('Quota exceeded: LIMIT:0 for this model')).kind).toBe('quota');
    expect(httpError('gemini', 429, body('metric FREE_TIER_input_tokens exceeded')).kind).toBe('quota');
  });

  it('보통의 429는 그대로 rate다', () => {
    const e = httpError('gemini', 429, body('Resource has been exhausted (e.g. check quota). limit: 10'));
    expect(e.kind).toBe('rate');
    expect(e.message).not.toContain(GEMINI_FREE_TIER_MESSAGE);
  });

  it('다른 공급자나 다른 상태 값은 바꾸지 않는다', () => {
    expect(httpError('openai', 429, body(FREE_TIER_MSG)).kind).toBe('rate');
    expect(httpError('gemini', 429, body(FREE_TIER_MSG, 'UNAVAILABLE')).kind).toBe('rate');
  });

  it('스트림 안의 같은 오류도 quota로 본다', () => {
    expect(geminiStreamError('RESOURCE_EXHAUSTED', FREE_TIER_MSG).kind).toBe('quota');
    expect(geminiStreamError('RESOURCE_EXHAUSTED', 'too many').kind).toBe('rate');
  });

  it('화면에는 요금제 안내를 보여 준다', () => {
    const e = httpError('gemini', 429, body(FREE_TIER_MSG));
    expect(errorText(e.kind, e.message)).toBe(GEMINI_FREE_TIER_MESSAGE);
    expect(errorText('quota', '사용 한도·잔액 부족: HTTP 429 billing')).toBe('사용 한도나 크레딧이 부족합니다.');
  });
});
