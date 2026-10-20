// 데일리 노트 생성, 일감 넘기기, 체크박스 토글 로직을 검사하는 단위 테스트
import { describe, expect, it } from 'vitest';
import { buildDailyNote, dateKey, previousKey, splitTasks, toggleTaskLine } from '../src/lib/daily';

const prev = [
  '# 2026-10-15 (수)',
  '',
  '## 어제 한 일',
  '- 예전 일',
  '',
  '## 오늘 할 일',
  '- [x] 로그인 버그 수정',
  '  - 원인: 토큰 만료',
  '- [ ] 스모크 테스트 재실행',
  '  - [ ] 하위 일감',
  '- [X] 코드 리뷰',
  '',
  '## 이슈',
  '- [ ] 이슈에 적은 체크박스는 넘기지 않는다',
  '',
].join('\n');

describe('날짜', () => {
  it('로컬 날짜를 YYYY-MM-DD로 만든다', () => {
    expect(dateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
  it('가장 최근의 이전 노트를 고른다', () => {
    expect(previousKey(['2026-10-10', '2026-10-15', '2026-10-17'], '2026-10-16')).toBe('2026-10-15');
    expect(previousKey(['2026-10-17'], '2026-10-16')).toBeNull();
  });
});

describe('일감 나누기', () => {
  it('오늘 할 일 칸에서 끝낸 일과 남은 일을 하위 항목과 함께 나눈다', () => {
    const { done, open } = splitTasks(prev);
    expect(done).toEqual([['- [x] 로그인 버그 수정', '  - 원인: 토큰 만료'], ['- [X] 코드 리뷰']]);
    expect(open).toEqual([['- [ ] 스모크 테스트 재실행', '  - [ ] 하위 일감']]);
  });
});

describe('데일리 노트 만들기', () => {
  it('이전 노트가 없으면 빈 스탠드업 템플릿을 만든다', () => {
    const note = buildDailyNote('2026-10-16', null);
    expect(note).toBe(
      ['# 2026-10-16 (금)', '', '## 어제 한 일', '- ', '', '## 오늘 할 일', '- [ ] ', '', '## 이슈', '- ', '', '## 메모', ''].join('\n'),
    );
  });
  it('끝낸 일은 어제 한 일로, 남은 일은 오늘 할 일로 넘긴다', () => {
    const note = buildDailyNote('2026-10-16', { key: '2026-10-15', content: prev });
    expect(note).toContain(['## 어제 한 일 (10/15)', '- 로그인 버그 수정', '  - 원인: 토큰 만료', '- 코드 리뷰'].join('\n'));
    expect(note).toContain(['## 오늘 할 일', '- [ ] 스모크 테스트 재실행', '  - [ ] 하위 일감', ''].join('\n'));
    expect(note).not.toContain('이슈에 적은');
  });
});

describe('체크박스 토글', () => {
  it('[ ]와 [x]를 바꾸고 들여쓰기를 지킨다', () => {
    expect(toggleTaskLine('- [ ] 일')).toBe('- [x] 일');
    expect(toggleTaskLine('  - [x] 일')).toBe('  - [ ] 일');
  });
  it('일반 목록과 일반 줄은 체크박스로 만든다', () => {
    expect(toggleTaskLine('- 일')).toBe('- [ ] 일');
    expect(toggleTaskLine('  일')).toBe('  - [ ] 일');
  });
});
