// 쓰기 충돌 뒤 다시 읽은 내용에 사용자의 변경을 다시 얹는 함수 테스트
import { describe, expect, it } from 'vitest';
import { applyChangedFields, markTaskDone } from '../src/lib/writeRetry';

describe('할 일 끝내기 다시 얹기', () => {
  it('같은 자리의 할 일 줄을 끝낸 일로 바꾼다', () => {
    expect(markTaskDone('# 오늘\n- [ ] 배포\n- [ ] 리뷰', 1, '- [ ] 배포')).toBe('# 오늘\n- [x] 배포\n- [ ] 리뷰');
  });

  it('다른 기기에서 위에 줄이 더해져 자리가 밀리면 같은 내용의 줄을 찾아 고친다', () => {
    expect(markTaskDone('# 오늘\n- [ ] 새 일\n- [ ] 배포', 1, '- [ ] 배포')).toBe('# 오늘\n- [ ] 새 일\n- [x] 배포');
  });

  it('그 줄이 없어졌거나 같은 줄이 여럿이거나 이미 끝냈으면 null', () => {
    expect(markTaskDone('# 오늘\n- [ ] 리뷰', 1, '- [ ] 배포')).toBeNull();
    expect(markTaskDone('- [ ] 배포\n- [ ] 배포\n메모', 2, '- [ ] 배포')).toBeNull();
    expect(markTaskDone('- [x] 배포', 0, '- [x] 배포')).toBeNull();
  });
});

describe('바꾼 칸만 다시 얹기', () => {
  it('사용자가 바꾼 칸만 다시 읽은 값 위에 덮고 나머지는 디스크 값을 둔다', () => {
    const before = { daily: 'daily', topic: '주제', moc: '목차' };
    const after = { daily: 'daily', topic: '공부', moc: '목차' };
    const disk = { daily: '일지', topic: '주제', moc: '지도' };
    expect(applyChangedFields(disk, before, after)).toEqual({ daily: '일지', topic: '공부', moc: '지도' });
  });
});
