// 화면이 요청한 파일 쓰기를 하는 도우미: 없을 때만 새로 만들기, 디스크가 기준 해시와 같을 때만 덮어쓰기
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { contentHash, type WriteResult } from './contentHash';

/** 파일이 없을 때만 content로 만든다. 만들었으면 true, 이미 있으면 건드리지 않고 false */
export async function createExclusive(filePath: string, content: string): Promise<boolean> {
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * 텍스트를 쓴다. expectedHash를 주면 파일이 있고 지금 내용의 해시가 그와 다를 때 쓰지 않고 conflict를 돌려준다.
 * 확인과 쓰기 사이에 다른 쓰기가 끼지 않도록 호출하는 쪽이 한 줄로 세운 큐 안에서 부른다
 */
export async function writeTextChecked(filePath: string, content: string, expectedHash?: string): Promise<WriteResult> {
  if (expectedHash !== undefined) {
    const current = await readIfExists(filePath);
    if (current !== null && contentHash(current) !== expectedHash) return { ok: false, conflict: true };
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return { ok: true };
}
