// 노트 폴더의 링크 파싱·해석, 백링크, 태그, 할 일, 퍼지 검색, 노트 검색, 그래프 로직을 검사하는 단위 테스트
import { describe, expect, it } from 'vitest';
import {
  allTasks, backlinks, buildGraph, buildIndex, buildLookup, fuzzyMatch, notesByFolder, parseNote, parseQuery,
  resolveLink, searchVault, splitLinkText, tagCounts, unlinkedMentions, unresolvedLinks,
} from '../src/lib/vault';

describe('링크 파싱', () => {
  it('대상, 제목, 별칭, 임베드를 나눈다', () => {
    const { links } = parseNote('앞 [[회의록#결정 사항|결정]] 그리고 ![[그림.png]]\n[[노트]]');
    expect(links.map(({ target, subpath, alias, embed, line, col }) => ({ target, subpath, alias, embed, line, col }))).toEqual([
      { target: '회의록', subpath: '#결정 사항', alias: '결정', embed: false, line: 0, col: 2 },
      { target: '그림.png', subpath: '', alias: null, embed: true, line: 0, col: 23 },
      { target: '노트', subpath: '', alias: null, embed: false, line: 1, col: 0 },
    ]);
  });
  it('코드 블록과 인라인 코드 안의 링크는 무시한다', () => {
    const md = '`[[a]]` [[b]]\n```\n[[c]]\n```\n[[d]]';
    expect(parseNote(md).links.map((l) => l.target)).toEqual(['b', 'd']);
  });
  it('끝의 역슬래시를 지우고 블록 참조를 subpath로 둔다', () => {
    expect(splitLinkText('노트#^abc12\\')).toEqual({ target: '노트', subpath: '#^abc12', alias: null });
  });
});

describe('링크 해석', () => {
  const lookup = buildLookup(['a/회의록.md', 'b/회의록.md', 'b/c/회의록.md', '유일.md', 'proj/x/메모.md', '그림.png']);
  it('이름이 하나뿐이면 폴더와 상관없이 찾는다 (대소문자 무시)', () => {
    expect(resolveLink('유일', 'z/어디.md', lookup)).toBe('유일.md');
    expect(resolveLink('그림.png', 'z/어디.md', lookup)).toBe('그림.png');
  });
  it('같은 이름이 여럿이면 링크를 건 노트 폴더 아래, 그다음 짧은 경로를 고른다', () => {
    expect(resolveLink('회의록', 'b/c/오늘.md', lookup)).toBe('b/c/회의록.md');
    expect(resolveLink('회의록', 'b/오늘.md', lookup)).toBe('b/회의록.md');
    expect(resolveLink('회의록', 'z/오늘.md', lookup)).toBe('a/회의록.md');
  });
  it('전체 경로, 경로 끝, 상대 경로를 해석한다', () => {
    expect(resolveLink('b/c/회의록', 'a/x.md', lookup)).toBe('b/c/회의록.md');
    expect(resolveLink('/b/회의록', 'a/x.md', lookup)).toBe('b/회의록.md');
    expect(resolveLink('c/회의록', 'a/x.md', lookup)).toBe('b/c/회의록.md');
    expect(resolveLink('../회의록', 'b/c/x.md', lookup)).toBe('b/회의록.md');
    expect(resolveLink('x/메모', 'a.md', lookup)).toBe('proj/x/메모.md');
  });
  it('없는 노트는 null', () => {
    expect(resolveLink('없음', 'a.md', lookup)).toBeNull();
  });
});

describe('태그와 할 일', () => {
  it('공백 뒤 #태그만 읽고, 숫자뿐인 태그와 제목·링크 안 #은 뺀다', () => {
    const md = '# 제목\n회의 #업무/회의 #버그_수정 이슈#123 #123 [[노트#제목]]\n#한글태그.';
    expect(parseNote(md).tags.map((t) => t.tag)).toEqual(['업무/회의', '버그_수정', '한글태그']);
  });
  it('프런트매터 tags를 읽는다', () => {
    expect(parseNote('---\ntags: [a, "b"]\n---\n본문').tags.map((t) => t.tag)).toEqual(['a', 'b']);
    expect(parseNote('---\ntags:\n  - x\n  - y/z\n---\n').tags.map((t) => t.tag)).toEqual(['x', 'y/z']);
  });
  it('[ ] 안이 공백이 아니면 모두 끝낸 일로 본다', () => {
    const tasks = parseNote('- [ ] 할 일\n  - [x] 끝\n* [/] 진행 중\n1. [ ] 번호 목록').tasks;
    expect(tasks.map((t) => [t.status, t.done, t.text])).toEqual([
      [' ', false, '할 일'], ['x', true, '끝'], ['/', true, '진행 중'], [' ', false, '번호 목록'],
    ]);
  });
});

describe('색인', () => {
  const index = buildIndex([
    { path: 'daily/2026-10-19.md', content: '# 오늘\n- [ ] [[프로젝트 A]] 회의 #업무\n- [x] 리뷰 #업무/리뷰' },
    { path: '프로젝트 A.md', content: '[[daily/2026-10-19]] 참고\n[[없는 노트]]\n#업무' },
    { path: 'memo.md', content: '프로젝트 a 얘기만 적음\n[[프로젝트 A|별칭]] 두 번째\n`프로젝트 A`' },
  ]);
  it('백링크를 줄 단위로 모은다', () => {
    expect(backlinks(index, '프로젝트 A.md')).toEqual([
      { source: 'daily/2026-10-19.md', line: 1, text: '- [ ] [[프로젝트 A]] 회의 #업무' },
      { source: 'memo.md', line: 1, text: '[[프로젝트 A|별칭]] 두 번째' },
    ]);
  });
  it('링크 없이 이름만 적은 곳을 찾는다', () => {
    expect(unlinkedMentions(index, '프로젝트 A.md').map((m) => [m.source, m.line])).toEqual([['memo.md', 0]]);
  });
  it('못 찾은 링크를 모은다', () => {
    expect([...unresolvedLinks(index)]).toEqual([['없는 노트', new Set(['프로젝트 A.md'])]]);
  });
  it('태그 수는 노트 단위로 세고 상위 태그에도 더한다', () => {
    expect(tagCounts(index)).toEqual([
      { tag: '업무', count: 2 },
      { tag: '업무/리뷰', count: 1 },
    ]);
  });
  it('할 일은 안 한 일 먼저', () => {
    expect(allTasks(index).map((t) => t.done)).toEqual([false, true]);
  });
  it('그래프는 링크를 간선으로, 옵션에 따라 태그·못 찾은 링크를 노드로 넣는다', () => {
    const g = buildGraph(index, { tags: false, unresolved: false });
    expect(g.nodes.map((n) => n.label)).toEqual(['2026-10-19', '프로젝트 A', 'memo']);
    expect(g.edges).toEqual([[0, 1], [2, 1]]);
    const withTags = buildGraph(index, { tags: true, unresolved: true });
    expect(withTags.nodes.filter((n) => n.kind !== 'note').map((n) => n.label)).toEqual(['#업무', '#업무/리뷰', '없는 노트']);
  });
  it('현재 노트 주변 그래프는 depth 단계까지만 남긴다', () => {
    const g = buildGraph(index, { tags: false, unresolved: false, focus: 'memo.md', depth: 1 });
    expect(g.nodes.map((n) => n.label)).toEqual(['memo', '프로젝트 A']);
    expect(g.edges).toEqual([[0, 1]]);
  });
});

describe('퍼지 검색', () => {
  it('단어 조각이 맞으면 글자 단위보다 점수가 높다', () => {
    const word = fuzzyMatch('daily note', 'daily/note.md')!;
    const chars = fuzzyMatch('dn', 'daily/note.md')!;
    expect(word.matches).toEqual([[0, 5], [6, 10]]);
    expect(word.score).toBeGreaterThan(chars.score - 1);
    expect(chars.matches).toEqual([[0, 1], [6, 7]]);
  });
  it('앞쪽에서 연속으로 맞을수록 점수가 높다', () => {
    const a = fuzzyMatch('회의', '회의록.md')!.score;
    const b = fuzzyMatch('회의', '주간 회의록.md')!.score;
    const c = fuzzyMatch('회의', '회사 의견.md')!.score;
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });
  it('camelCase 경계도 단어 시작으로 본다', () => {
    expect(fuzzyMatch('teb', 'TextBench')!.score).toBeGreaterThan(fuzzyMatch('teb', 'Textbench')!.score);
  });
  it('순서대로 찾을 수 없으면 null', () => {
    expect(fuzzyMatch('xyz', 'abc')).toBeNull();
  });
});

describe('노트 검색', () => {
  const index = buildIndex([
    { path: 'daily/2026-10-19.md', content: '회의 준비\n- [ ] 배포 확인 #업무\n- [x] 배포 리뷰' },
    { path: 'work/배포 절차.md', content: '1단계 빌드\n2단계 배포' },
  ]);
  it('연산자와 따옴표, 제외, 정규식을 나눈다', () => {
    expect(parseQuery('tag:#업무 "배포 확인" -리뷰 /\\d단계/').map((t) => [t.op, t.value, t.negate, !!t.regex])).toEqual([
      ['tag', '#업무', false, false], ['', '배포 확인', false, false], ['', '리뷰', true, false], ['', '\\d단계', false, true],
    ]);
  });
  it('모든 조건이 맞는 노트와 맞은 줄을 돌려준다', () => {
    expect(searchVault(index, '배포').map((h) => [h.path, h.lines.map((l) => l.line)])).toEqual([
      ['daily/2026-10-19.md', [1, 2]],
      ['work/배포 절차.md', [1]],
    ]);
    expect(searchVault(index, '배포 -리뷰').map((h) => h.path)).toEqual(['work/배포 절차.md']);
    expect(searchVault(index, 'path:work').map((h) => h.path)).toEqual(['work/배포 절차.md']);
    expect(searchVault(index, 'tag:업무').map((h) => h.path)).toEqual(['daily/2026-10-19.md']);
    expect(searchVault(index, 'task-todo:배포')[0].lines).toEqual([{ line: 1, text: '- [ ] 배포 확인 #업무' }]);
    expect(searchVault(index, 'task-done:확인')).toEqual([]);
    expect(searchVault(index, '/\\d단계/')[0].lines.map((l) => l.line)).toEqual([0, 1]);
  });
});

describe('폴더별 노트 목록', () => {
  it('맨 위 폴더부터 이름순(한글 먼저)으로 묶고, 뺄 폴더와 그 아래는 뺀다', () => {
    const paths = ['주제/통합.md', '주제/바이닉.md', '메모.md', 'daily/2026-10-20.md', 'daily/옛/a.md', 'dailyx/b.md'];
    expect(notesByFolder(paths, ['daily'])).toEqual([
      { folder: '', notes: ['메모.md'] },
      { folder: '주제', notes: ['주제/바이닉.md', '주제/통합.md'] },
      { folder: 'dailyx', notes: ['dailyx/b.md'] },
    ]);
  });
});

describe('첨부 링크', () => {
  it('![[첨부]]는 못 찾은 링크나 그래프의 빈 노드로 치지 않는다', () => {
    const index = buildIndex([{ path: '노트.md', content: '![[첨부/a.png]] [[없는 노트]]' }]);
    expect([...unresolvedLinks(index).keys()]).toEqual(['없는 노트']);
    expect(buildGraph(index, { tags: false, unresolved: true }).nodes.map((n) => n.label)).toEqual(['노트', '없는 노트']);
  });
});
