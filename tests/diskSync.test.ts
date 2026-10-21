// 내용 해시, 저장 전 디스크 변경 판단, 바뀐 파일의 탭 반영 판단, 상태 막대 문구 테스트
import { describe, expect, it } from 'vitest';
import { changedOnDisk, cloudStatusBar, contentHash, normalizePath, skippedLines, splitChangedTabs } from '../src/lib/diskSync';

describe('contentHash', () => {
  it('같은 내용은 같은 값, 다른 내용은 다른 값', () => {
    expect(contentHash('# 노트\n본문')).toBe(contentHash('# 노트\n본문'));
    expect(contentHash('# 노트\n본문')).not.toBe(contentHash('# 노트\n본문 '));
    expect(contentHash('a\r\nb')).not.toBe(contentHash('a\nb'));
  });
  it('빈 글도 해시가 있다', () => {
    expect(contentHash('')).toMatch(/^[0-9a-f]+$/);
  });
});

describe('changedOnDisk', () => {
  const base = contentHash('원래 내용');
  it('디스크 내용이 기준과 다르면 묻는다', () => {
    expect(changedOnDisk('누가 고친 내용', base)).toBe(true);
  });
  it('같거나, 파일이 없거나, 기준이 없으면 묻지 않는다', () => {
    expect(changedOnDisk('원래 내용', base)).toBe(false);
    expect(changedOnDisk(null, base)).toBe(false);
    expect(changedOnDisk('무엇이든', null)).toBe(false);
  });
});

describe('splitChangedTabs', () => {
  const tabs = [
    { id: 1, path: '/n/daily/2026-10-21.md', dirty: false },
    { id: 2, path: '/n/주제/회의.md', dirty: true },
    { id: 3, path: null, dirty: true },
    { id: 4, path: '/n/다른.md', dirty: false },
  ];
  it('깨끗한 탭은 다시 읽고 고친 탭은 그대로 둔다', () => {
    expect(splitChangedTabs(tabs, ['/n/daily/2026-10-21.md', '/n/주제/회의.md'])).toEqual({ reload: [1], keep: [2] });
  });
  it('NFD 이름과 역슬래시 경로도 같은 파일로 본다', () => {
    const nfd = '/n/주제/회의.md'.normalize('NFD');
    expect(splitChangedTabs(tabs, [nfd])).toEqual({ reload: [], keep: [2] });
    expect(normalizePath('C:\\n\\a.md')).toBe('C:/n/a.md');
  });
  it('열린 탭이 아닌 파일은 무시한다', () => {
    expect(splitChangedTabs(tabs, ['/n/없음.md'])).toEqual({ reload: [], keep: [] });
  });
});

describe('cloudStatusBar', () => {
  it('로컬 모드면 숨긴다', () => {
    expect(cloudStatusBar({ state: 'off' }).hidden).toBe(true);
  });
  it('맞춘 시각과 진행 개수를 보인다', () => {
    expect(cloudStatusBar({ state: 'idle', lastSync: new Date(2026, 9, 21, 9, 5).getTime() }).text).toBe('☁ 맞춤 09:05');
    expect(cloudStatusBar({ state: 'syncing', progress: { done: 12, total: 40 } }).text).toBe('☁ 맞추는 중 12/40');
    expect(cloudStatusBar({ state: 'syncing' }).text).toBe('☁ 맞추는 중');
  });
  it('오프라인·오류는 메시지를 툴팁에 담는다', () => {
    expect(cloudStatusBar({ state: 'offline' }).text).toBe('☁ 오프라인');
    expect(cloudStatusBar({ state: 'error', message: '키가 맞지 않습니다' })).toMatchObject({ text: '☁ 오류', title: '키가 맞지 않습니다' });
  });
});

describe('상태 막대: 건너뛴 파일', () => {
  const files = Array.from({ length: 12 }, (_, i) => ({ path: `n${i}.md`, reason: '100MB보다 큼' }));
  it('맞춤 옆에 건너뛴 수를 붙이고 제목에 10개까지 보인다', () => {
    const v = cloudStatusBar({ state: 'idle', skipped: files.slice(0, 3) });
    expect(v.text).toBe('☁ 맞춤 · 3개 건너뜀');
    expect(v.title).toContain('n2.md — 100MB보다 큼');
    const many = cloudStatusBar({ state: 'idle', skipped: files });
    expect(many.title).toContain('n9.md');
    expect(many.title).not.toContain('n10.md');
    expect(many.title).toContain('그 밖에 2개');
  });
  it('건너뛴 파일이 없으면 전처럼 맞춤만 보인다', () => {
    expect(cloudStatusBar({ state: 'idle', skipped: [] }).text).toBe('☁ 맞춤');
  });
  it('줄 목록은 max개까지만 만든다', () => {
    expect(skippedLines(files.slice(0, 2), 10)).toEqual(['n0.md — 100MB보다 큼', 'n1.md — 100MB보다 큼']);
    expect(skippedLines(files, 1)).toEqual(['n0.md — 100MB보다 큼', '그 밖에 11개']);
  });
});
