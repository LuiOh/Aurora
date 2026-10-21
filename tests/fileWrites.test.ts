// 화면이 요청한 파일 쓰기 도우미(없을 때만 만들기, 기준 해시를 건 쓰기) 테스트
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contentHash } from '../electron/contentHash';
import { createExclusive, writeTextChecked } from '../electron/fileWrites';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'aurora-writes-'));
  temps.push(d);
  return d;
}

describe('없을 때만 만들기', () => {
  it('없는 파일은 하위 폴더까지 만들고 true를 돌려준다', async () => {
    const dir = await tempDir();
    const p = path.join(dir, '주제', '새 노트.md');
    expect(await createExclusive(p, '# 새 노트\n')).toBe(true);
    expect(await readFile(p, 'utf8')).toBe('# 새 노트\n');
  });

  it('이미 있는 파일(막 내려받은 노트)은 덮지 않고 false를 돌려준다', async () => {
    const dir = await tempDir();
    const p = path.join(dir, '회의.md');
    await writeFile(p, '다른 기기에서 쓴 내용');
    expect(await createExclusive(p, '# 회의\n')).toBe(false);
    expect(await readFile(p, 'utf8')).toBe('다른 기기에서 쓴 내용');
  });
});

describe('기준 해시를 건 쓰기', () => {
  it('디스크 내용이 기준과 같으면 쓴다', async () => {
    const p = path.join(await tempDir(), 'a.md');
    await writeFile(p, '처음');
    expect(await writeTextChecked(p, '고침', contentHash('처음'))).toEqual({ ok: true });
    expect(await readFile(p, 'utf8')).toBe('고침');
  });

  it('디스크 내용이 기준과 다르면 쓰지 않고 충돌을 돌려준다', async () => {
    const p = path.join(await tempDir(), 'a.md');
    await writeFile(p, '다른 기기에서 받은 내용');
    expect(await writeTextChecked(p, '고침', contentHash('처음'))).toEqual({ ok: false, conflict: true });
    expect(await readFile(p, 'utf8')).toBe('다른 기기에서 받은 내용');
  });

  it('파일이 없거나 기준을 주지 않으면 그대로 쓴다', async () => {
    const dir = await tempDir();
    const p = path.join(dir, '새 폴더', 'a.md');
    expect(await writeTextChecked(p, '새 내용', contentHash('처음'))).toEqual({ ok: true });
    expect(await writeTextChecked(p, '덮어씀')).toEqual({ ok: true });
    expect(await readFile(p, 'utf8')).toBe('덮어씀');
  });
});
