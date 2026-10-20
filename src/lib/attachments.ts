// 노트에 붙여 넣거나 끌어다 놓은 이미지·영상·파일 첨부의 이름, 종류, 링크 문법을 다루는 순수 함수 모음

export type AttachmentKind = 'image' | 'video' | 'audio' | 'file';

const KINDS: Record<string, AttachmentKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image', avif: 'image',
  mp4: 'video', mov: 'video', webm: 'video', m4v: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio', flac: 'audio',
};

/** 끌어다 놓으면 탭으로 여는 대신 첨부하는 문서 형식 */
const DOCS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'hwp', 'hwpx', 'zip']);

const extOf = (name: string) => (/\.([^./]+)$/.exec(name)?.[1] ?? '').toLowerCase();

export function attachmentKind(name: string): AttachmentKind {
  return KINDS[extOf(name)] ?? 'file';
}

/** 노트에 끌어다 놓았을 때 탭으로 열지 않고 첨부할 파일인가 */
export function isAttachableFile(name: string): boolean {
  const ext = extOf(name);
  return ext in KINDS || DOCS.has(ext);
}

/** [[링크]] 대상이 노트가 아닌 첨부 파일인가 (확장자가 있고 .md가 아니면 첨부로 본다) */
export function isAttachmentTarget(target: string): boolean {
  const ext = extOf(target);
  return ext !== '' && ext !== 'md';
}

/** 이름 없는 클립보드 이미지에 붙일 이름. 옵시디언과 같은 "Pasted image 20261020081530.png" 형식 */
export function pastedImageName(d: Date, mime: string): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const ext = { 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[mime] ?? 'png';
  return `Pasted image ${stamp}.${ext}`;
}

/** taken에 이미 있는 이름이면 "이름 1.확장자", "이름 2.확장자"처럼 비는 이름을 고른다 */
export async function uniqueName(name: string, taken: (n: string) => boolean | Promise<boolean>): Promise<string> {
  if (!(await taken(name))) return name;
  const dot = name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 1; ; i++) {
    const n = `${base} ${i}${ext}`;
    if (!(await taken(n))) return n;
  }
}

/** 첨부를 저장하는 폴더. 노트 파일과 같은 폴더 안에 만들어서, 노트와 함께 옮기면 첨부도 따라간다 */
export const ATTACH_FOLDER = '첨부';

/** 첨부를 가리키는 마크다운. 노트 기준 상대 경로라 다른 마크다운 앱(옵시디언, 타이포라, 깃허브)에서도 보인다 */
export function attachmentMarkdown(name: string): string {
  const rel = `${ATTACH_FOLDER}/${name}`;
  return attachmentKind(name) === 'file' ? `[${name}](<${rel}>)` : `![](<${rel}>)`;
}
