// AI 채팅 화면의 순수 로직(오류 문구·턴 정리·요청 조립·모델 선택지) 테스트
import { describe, expect, it } from 'vitest';
import { buildChatRequest, errorText, missingSourcesNotice, modelOptions, modelsResultText, settleTurns } from '../src/lib/aiChat';
import { defaultAiSettings } from '../electron/aiShared';
import type { ChatTurn } from '../electron/ai/types';

const q: ChatTurn[] = [{ role: 'user', text: '안녕' }];

describe('errorText', () => {
  it('종류별 한국어 문구를 돌려준다', () => {
    expect(errorText('auth', 'x')).toContain('API 키');
    expect(errorText('aborted', 'x')).toBe('중지했습니다.');
  });
  it('bad-request·server는 공급자 메시지를 담는다', () => {
    expect(errorText('bad-request', 'model not found')).toContain('model not found');
    expect(errorText('server', '503')).toContain('503');
  });
});

describe('settleTurns', () => {
  it('done이면 출처와 함께 assistant 턴을 붙인다', () => {
    const r = settleTurns(q, { type: 'done', text: '답', citations: [{ url: 'u', title: 't' }] });
    expect(r.turns).toEqual([...q, { role: 'assistant', text: '답', citations: [{ url: 'u', title: 't' }] }]);
    expect(r.restore).toBeNull();
    expect(r.answered).toBe(true);
  });
  it('오류면 사용자 턴을 빼고 입력란에 되돌린다', () => {
    const r = settleTurns(q, { type: 'error', kind: 'network', partial: '반쯤' });
    expect(r.turns).toEqual([]);
    expect(r.restore).toBe('안녕');
    expect(r.answered).toBe(false);
  });
  it('중지했는데 받은 답이 있으면 남긴다', () => {
    const r = settleTurns(q, { type: 'error', kind: 'aborted', partial: '반쯤' });
    expect(r.turns[1]).toEqual({ role: 'assistant', text: '반쯤' });
    expect(r.restore).toBeNull();
  });
  it('중지했는데 받은 답이 없으면 오류처럼 되돌린다', () => {
    const r = settleTurns(q, { type: 'error', kind: 'aborted', partial: '  ' });
    expect(r.turns).toEqual([]);
    expect(r.restore).toBe('안녕');
  });
  it('마지막 턴이 사용자 턴이 아니면 그대로 둔다', () => {
    const turns: ChatTurn[] = [...q, { role: 'assistant', text: '답' }];
    expect(settleTurns(turns, { type: 'done', text: 'x', citations: [] }).turns).toBe(turns);
  });
});

describe('buildChatRequest', () => {
  it('공급자별 저장 모델과 웹 검색 설정을 쓴다', () => {
    const s = { ...defaultAiSettings(), provider: 'gemini' as const, models: { gemini: 'gemini-x' }, webSearch: false };
    expect(buildChatRequest(s, 'sys', q)).toEqual({ provider: 'gemini', model: 'gemini-x', system: 'sys', turns: q, webSearch: false });
  });
  it('저장된 모델이 없으면 빈 모델을 보낸다', () => {
    expect(buildChatRequest(defaultAiSettings(), '', q).model).toBe('');
  });
});

describe('modelOptions', () => {
  const list = [{ id: 'a', label: 'A' }, { id: 'b', label: '' }];
  it('목록이 없으면 저장 모델이나 기본 모델 하나만 둔다', () => {
    expect(modelOptions('m', null)).toEqual([{ id: 'm', label: 'm' }]);
    expect(modelOptions('', null)).toEqual([{ id: '', label: '기본 모델' }]);
  });
  it('목록에 없는 저장 모델은 앞에 붙이고, 이름이 없으면 id를 쓴다', () => {
    expect(modelOptions('z', list)).toEqual([{ id: 'z', label: 'z' }, { id: 'a', label: 'A' }, { id: 'b', label: 'b' }]);
  });
  it('저장 모델이 없으면 기본 모델 선택지를 맨 앞에 둔다', () => {
    expect(modelOptions('', list)[0]).toEqual({ id: '', label: '기본 모델' });
  });
});

describe('modelsResultText', () => {
  it('성공하면 모델 수, 실패하면 이유를 알려준다', () => {
    expect(modelsResultText({ ok: true, models: [{ id: 'a', label: 'A' }] })).toBe('저장했습니다 · 모델 1개');
    expect(modelsResultText({ ok: false, kind: 'auth', message: '' })).toContain('API 키');
  });
});

describe('missingSourcesNotice 출처 없음 안내', () => {
  it('웹 검색을 껐거나 출처가 있으면 아무것도 보이지 않는다', () => {
    expect(missingSourcesNotice(false, [], undefined)).toBe('');
    expect(missingSourcesNotice(true, [{ url: 'https://a.example', title: 'A' }], undefined)).toBe('');
  });

  it('검색어가 없으면 검색하지 않았을 수 있다고 알린다', () => {
    expect(missingSourcesNotice(true, [], undefined)).toBe('검색 출처 없음 · 모델이 웹 검색을 하지 않았을 수 있습니다');
    expect(missingSourcesNotice(true, [], [])).toBe('검색 출처 없음 · 모델이 웹 검색을 하지 않았을 수 있습니다');
  });

  it('검색어가 있으면 검색했지만 인용이 없다고 알린다', () => {
    expect(missingSourcesNotice(true, [], ['서울 날씨'])).toBe('검색했지만 인용한 출처가 없습니다');
  });
});
