// 윈도우 경로를 / 구분자로 맞추고 file:// URL로 바꾸는 함수를 검사하는 단위 테스트
import { describe, expect, it } from 'vitest';
import { fileUrl, toSlash } from '../electron/paths';

describe('경로 구분자', () => {
  it('윈도우의 \\ 를 / 로 바꾼다', () => {
    expect(toSlash('C:\\Users\\me\\Notes\\daily\\2026-10-19.md')).toBe('C:/Users/me/Notes/daily/2026-10-19.md');
    expect(toSlash('\\\\server\\share\\a.md')).toBe('//server/share/a.md');
  });
  it('맥 경로는 그대로 둔다', () => {
    expect(toSlash('/Users/me/Notes/a.md')).toBe('/Users/me/Notes/a.md');
  });
  it('끝의 구분자는 떼어 폴더 경로를 이어 붙여도 // 가 생기지 않게 한다', () => {
    expect(toSlash('C:\\Notes\\')).toBe('C:/Notes');
    expect(toSlash('/Users/me/Notes/')).toBe('/Users/me/Notes');
    expect(toSlash('/')).toBe('/');
    expect(toSlash('C:\\')).toBe('C:/');
  });
});

describe('file:// URL', () => {
  it('맥·윈도우 경로를 file:// URL로 바꾼다', () => {
    expect(fileUrl('/Users/me/첨부/a b.png')).toBe('file:///Users/me/%EC%B2%A8%EB%B6%80/a%20b.png');
    expect(fileUrl('C:/노트/a#1.png')).toBe('file:///C:/%EB%85%B8%ED%8A%B8/a%231.png');
  });
});
