// AI 설정 정규화·키 저장 수준·채팅 파일 정렬·텍스트 조각 묶기 순수 함수 테스트
import { describe, expect, it, vi } from 'vitest';
import type { ChatEvent } from '../electron/ai/types';
import { createCoalescer, defaultAiSettings, keyStorageLevel, normalizeAiSettings, sortChatFiles } from '../electron/aiShared';

describe('normalizeAiSettings 설정 정규화', () => {
  it('객체가 아니면 기본값', () => {
    expect(normalizeAiSettings(null)).toEqual(defaultAiSettings());
    expect(normalizeAiSettings([1])).toEqual(defaultAiSettings());
  });
  it('올바른 값은 유지하고 모델·폴더는 공백을 다듬는다', () => {
    const s = normalizeAiSettings({
      provider: 'gemini', models: { openai: ' gpt-x ', anthropic: '', bogus: 'y', gemini: 3 },
      webSearch: false, includeNote: false, historyDir: ' /tmp/c ',
    });
    expect(s).toEqual({ provider: 'gemini', models: { openai: 'gpt-x' }, webSearch: false, includeNote: false, historyDir: '/tmp/c' });
  });
  it('잘못된 값은 기본값으로 바꾼다', () => {
    const s = normalizeAiSettings({ provider: 'x', models: 'm', webSearch: 'yes', includeNote: 1, historyDir: '  ' });
    expect(s).toEqual(defaultAiSettings());
  });
});

describe('keyStorageLevel 키 저장 수준', () => {
  it('암호화가 없으면 unavailable', () => expect(keyStorageLevel(false, 'darwin', '')).toBe('unavailable'));
  it('리눅스 basic_text는 weak', () => expect(keyStorageLevel(true, 'linux', 'basic_text')).toBe('weak'));
  it('리눅스 키링·맥·윈도우는 os', () => {
    expect(keyStorageLevel(true, 'linux', 'gnome_libsecret')).toBe('os');
    expect(keyStorageLevel(true, 'darwin', '')).toBe('os');
    expect(keyStorageLevel(true, 'win32', 'basic_text')).toBe('os');
  });
});

describe('sortChatFiles 채팅 파일 정렬', () => {
  it('.md 파일만 최근 순, 같으면 이름 순, 경로는 / 구분자', () => {
    const out = sortChatFiles('C:\\chats\\', [
      { name: 'a.md', isFile: true, mtime: 1 },
      { name: 'dir.md', isFile: false, mtime: 9 },
      { name: 'b.txt', isFile: true, mtime: 9 },
      { name: 'C.MD', isFile: true, mtime: 5 },
      { name: 'b.md', isFile: true, mtime: 5 },
    ]);
    expect(out.map((f) => f.path)).toEqual(['C:/chats/b.md', 'C:/chats/C.MD', 'C:/chats/a.md']);
  });
});

describe('createCoalescer 텍스트 조각 묶기', () => {
  const setup = (maxChars?: number) => {
    const out: ChatEvent[] = [];
    return { out, co: createCoalescer((ev) => out.push(ev), 16, maxChars) };
  };

  it('시간 창 안의 조각을 하나로 묶는다', () => {
    vi.useFakeTimers();
    const { out, co } = setup();
    co.push({ type: 'text', delta: 'a' });
    co.push({ type: 'text', delta: 'b' });
    expect(out).toEqual([]);
    vi.advanceTimersByTime(16);
    expect(out).toEqual([{ type: 'text', delta: 'ab' }]);
    vi.useRealTimers();
  });
  it('다른 이벤트 앞에서는 먼저 비운다', () => {
    vi.useFakeTimers();
    const { out, co } = setup();
    co.push({ type: 'text', delta: 'x' });
    co.push({ type: 'status', text: 's' });
    expect(out).toEqual([{ type: 'text', delta: 'x' }, { type: 'status', text: 's' }]);
    vi.advanceTimersByTime(50);
    expect(out).toHaveLength(2);
    vi.useRealTimers();
  });
  it('maxChars에 닿으면 바로 보낸다', () => {
    vi.useFakeTimers();
    const { out, co } = setup(3);
    co.push({ type: 'text', delta: 'abcd' });
    expect(out).toEqual([{ type: 'text', delta: 'abcd' }]);
    vi.useRealTimers();
  });
  it('dispose 뒤에는 타이머가 보내지 않는다', () => {
    vi.useFakeTimers();
    const { out, co } = setup();
    co.push({ type: 'text', delta: 'z' });
    co.dispose();
    vi.advanceTimersByTime(50);
    expect(out).toEqual([]);
    vi.useRealTimers();
  });
});
