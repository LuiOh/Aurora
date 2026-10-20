// 브라우저 폴더 접근 기능(File System Access API)의 폴더 핸들로 노트 파일을 읽고 쓰는 함수 모음 (웹 버전용)

/** 테스트에서 가짜로 바꿀 수 있게 필요한 부분만 적은 핸들 타입 */
export interface FileHandleLike {
  kind: 'file';
  name: string;
  getFile(): Promise<{ text(): Promise<string>; lastModified: number }>;
  createWritable(): Promise<{ write(data: string | Uint8Array<ArrayBuffer>): Promise<void>; close(): Promise<void> }>;
}

export interface DirHandleLike {
  kind: 'directory';
  name: string;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandleLike>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandleLike>;
  values(): AsyncIterable<FileHandleLike | DirHandleLike>;
}

/** 폴더 기준 상대 경로를 조각으로 나눈다. 빈 조각, ., .. 은 받지 않는다 */
export function splitRel(rel: string): string[] {
  const parts = rel.split('/').filter((p) => p !== '');
  if (parts.length === 0 || parts.some((p) => p === '.' || p === '..')) throw new Error(`잘못된 경로: ${rel}`);
  return parts;
}

async function parentDir(root: DirHandleLike, parts: string[], create: boolean): Promise<DirHandleLike> {
  let dir = root;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create });
  return dir;
}

/** 첨부 파일을 미리보기에 띄우려고 파일 객체 그대로 읽는다 */
export async function readBlob(root: DirHandleLike, rel: string): Promise<Blob> {
  const parts = splitRel(rel);
  const dir = await parentDir(root, parts, false);
  return (await (await dir.getFileHandle(parts[parts.length - 1])).getFile()) as unknown as Blob;
}

export async function readText(root: DirHandleLike, rel: string): Promise<string> {
  const parts = splitRel(rel);
  const dir = await parentDir(root, parts, false);
  return (await (await dir.getFileHandle(parts[parts.length - 1])).getFile()).text();
}

/** 파일을 쓴다(첨부는 바이트). 중간 폴더가 없으면 만든다 */
export async function writeText(root: DirHandleLike, rel: string, content: string | Uint8Array<ArrayBuffer>): Promise<void> {
  const parts = splitRel(rel);
  const dir = await parentDir(root, parts, true);
  const w = await (await dir.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
  await w.write(content);
  await w.close();
}

/** 모든 .md 파일. 데스크톱 앱과 같이 .으로 시작하는 폴더와 node_modules는 건너뛴다 */
export async function scanMarkdown(root: DirHandleLike): Promise<{ path: string; mtime: number; content: string }[]> {
  const out: { path: string; mtime: number; content: string }[] = [];
  const walk = async (dir: DirHandleLike, prefix: string) => {
    for await (const ent of dir.values()) {
      if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
      if (ent.kind === 'directory') await walk(ent, `${prefix}${ent.name}/`);
      else if (ent.name.toLowerCase().endsWith('.md')) {
        const file = await ent.getFile();
        out.push({ path: `${prefix}${ent.name}`, mtime: file.lastModified, content: await file.text() });
      }
    }
  };
  await walk(root, '');
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** daily/ 아래 YYYY-MM-DD.md 날짜 목록. 폴더가 없으면 만든다 */
export async function listDaily(root: DirHandleLike, folder = 'daily'): Promise<string[]> {
  let daily = root;
  for (const p of splitRel(folder)) daily = await daily.getDirectoryHandle(p, { create: true });
  const keys: string[] = [];
  for await (const ent of daily.values()) {
    if (ent.kind === 'file' && /^\d{4}-\d{2}-\d{2}\.md$/.test(ent.name)) keys.push(ent.name.slice(0, 10));
  }
  return keys.sort();
}
