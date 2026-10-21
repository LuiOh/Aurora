// 웹 버전의 폴더 핸들 읽기·쓰기·훑기를 메모리 속 가짜 폴더로 검사하는 단위 테스트
import { describe, expect, it } from 'vitest';
import { listDaily, readText, scanMarkdown, splitRel, writeText, type DirHandleLike, type FileHandleLike } from '../src/web/vaultFs';

/** 메모리에만 있는 가짜 폴더. 이름 → 내용(문자열) 또는 하위 폴더 */
type Tree = { [name: string]: string | Tree };

function fakeDir(name: string, tree: Tree): DirHandleLike {
  const notFound = () => Object.assign(new Error('없음'), { name: 'NotFoundError' });
  const file = (fname: string): FileHandleLike => ({
    kind: 'file',
    name: fname,
    getFile: async () => ({ text: async () => tree[fname] as string, lastModified: 1000, size: (tree[fname] as string).length }),
    createWritable: async () => {
      let buf = '';
      return { write: async (d: string) => void (buf += d), close: async () => void (tree[fname] = buf) };
    },
  });
  return {
    kind: 'directory',
    name,
    getDirectoryHandle: async (n, opts) => {
      if (!(n in tree)) {
        if (!opts?.create) throw notFound();
        tree[n] = {};
      }
      if (typeof tree[n] === 'string') throw new Error('파일입니다');
      return fakeDir(n, tree[n] as Tree);
    },
    getFileHandle: async (n, opts) => {
      if (!(n in tree)) {
        if (!opts?.create) throw notFound();
        tree[n] = '';
      }
      return file(n);
    },
    values: async function* () {
      for (const [n, v] of Object.entries(tree)) yield typeof v === 'string' ? file(n) : fakeDir(n, v);
    },
  };
}

describe('웹 노트 폴더', () => {
  it('하위 폴더의 파일을 읽고, 없는 폴더는 만들어 쓴다', async () => {
    const tree: Tree = { work: { 'a.md': '가' } };
    const root = fakeDir('notes', tree);
    expect(await readText(root, 'work/a.md')).toBe('가');
    await writeText(root, 'new/deep/b.md', '나');
    expect(tree).toEqual({ work: { 'a.md': '가' }, new: { deep: { 'b.md': '나' } } });
    await expect(readText(root, 'missing.md')).rejects.toThrow();
  });
  it('텍스트 파일은 모으고, 1MB 넘는 파일과 NUL이 든 파일은 마크다운이 아니면 뺀다', async () => {
    const big = 'x'.repeat(1024 * 1024 + 1);
    const root = fakeDir('notes', {
      'a.txt': '글', 'b.html': '<p>', 'c.png': 'x', 'd.txt': big, 'e.md': big, 'f.json': 'a\0b', 'g.md': 'a\0b', '.h': { 'i.txt': 'i' },
    });
    expect((await scanMarkdown(root)).map((f) => f.path)).toEqual(['a.txt', 'b.html', 'e.md', 'g.md']);
  });
  it('.md만 모으고 숨김 폴더와 node_modules는 건너뛴다', async () => {
    const root = fakeDir('notes', {
      'b.md': 'B', 'img.png': 'x', '.obsidian': { 'c.md': 'C' }, node_modules: { 'd.md': 'D' }, sub: { 'A.MD': 'A' },
    });
    expect((await scanMarkdown(root)).map((f) => [f.path, f.content])).toEqual([['b.md', 'B'], ['sub/A.MD', 'A']]);
  });
  it('daily 폴더의 날짜 노트만 고르고, 폴더가 없으면 만든다', async () => {
    const tree: Tree = {};
    expect(await listDaily(fakeDir('notes', tree))).toEqual([]);
    expect(tree).toEqual({ daily: {} });
    (tree.daily as Tree)['2026-10-19.md'] = '';
    (tree.daily as Tree)['2026-10-18.md'] = '';
    (tree.daily as Tree)['memo.md'] = '';
    expect(await listDaily(fakeDir('notes', tree))).toEqual(['2026-10-18', '2026-10-19']);
  });
  it('정한 데일리 폴더가 깊어도 만들고 읽는다', async () => {
    const tree: Tree = {};
    expect(await listDaily(fakeDir('notes', tree), '업무/일지')).toEqual([]);
    expect(tree).toEqual({ 업무: { 일지: {} } });
  });
  it('폴더 밖으로 나가는 경로는 막는다', () => {
    expect(() => splitRel('../x.md')).toThrow();
    expect(() => splitRel('a/./b.md')).toThrow();
    expect(splitRel('/a//b.md')).toEqual(['a', 'b.md']);
  });
});
