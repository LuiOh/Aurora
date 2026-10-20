// 첨부 파일의 종류 판단, 이름 짓기, 마크다운 문법을 검사하는 단위 테스트
import { describe, expect, it } from 'vitest';
import {
  attachmentKind, attachmentMarkdown, isAttachableFile, isAttachmentTarget, pastedImageName, uniqueName,
} from '../src/lib/attachments';

describe('첨부 종류', () => {
  it('확장자로 이미지·영상·오디오·그 밖의 파일을 나눈다', () => {
    expect(attachmentKind('a.PNG')).toBe('image');
    expect(attachmentKind('회의.mov')).toBe('video');
    expect(attachmentKind('녹음.m4a')).toBe('audio');
    expect(attachmentKind('보고서.pdf')).toBe('file');
  });

  it('끌어다 놓은 파일 중 미디어와 문서만 첨부하고, 글 파일은 탭으로 연다', () => {
    expect(isAttachableFile('a.mp4')).toBe(true);
    expect(isAttachableFile('a.xlsx')).toBe(true);
    expect(isAttachableFile('a.md')).toBe(false);
    expect(isAttachableFile('a.json')).toBe(false);
  });

  it('확장자가 있고 .md가 아닌 링크 대상을 첨부로 본다', () => {
    expect(isAttachmentTarget('첨부/a.png')).toBe(true);
    expect(isAttachmentTarget('노트')).toBe(false);
    expect(isAttachmentTarget('노트.md')).toBe(false);
  });
});

describe('첨부 이름과 문법', () => {
  it('클립보드 이미지에 시각을 넣은 이름을 붙인다', () => {
    expect(pastedImageName(new Date(2026, 9, 20, 8, 5, 3), 'image/png')).toBe('Pasted image 20261020080503.png');
    expect(pastedImageName(new Date(2026, 0, 2, 3, 4, 5), 'image/jpeg')).toBe('Pasted image 20260102030405.jpg');
  });

  it('이미 있는 이름이면 번호를 붙인다', async () => {
    const taken = new Set(['a.png', 'a 1.png', 'README']);
    expect(await uniqueName('a.png', (n) => taken.has(n))).toBe('a 2.png');
    expect(await uniqueName('b.png', async (n) => taken.has(n))).toBe('b.png');
    expect(await uniqueName('README', (n) => taken.has(n))).toBe('README 1');
  });

  it('노트 옆 첨부 폴더를 가리키는 상대 경로 링크를 쓴다', () => {
    expect(attachmentMarkdown('a b.png')).toBe('![](<첨부/a b.png>)');
    expect(attachmentMarkdown('회의.mp4')).toBe('![](<첨부/회의.mp4>)');
    expect(attachmentMarkdown('보고서.pdf')).toBe('[보고서.pdf](<첨부/보고서.pdf>)');
  });
});
