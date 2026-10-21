// 텍스트 파일 확장자 판단, 훑기 필터, 미리보기 방식 고르기를 검사하는 단위 테스트
import { describe, expect, it } from 'vitest';
import {
  MAX_TEXT_FILE_BYTES, NOTE_FORMATS, TEXT_EXTENSIONS, isMarkdownPath, isSkippedEntry, isTextPath, previewMode,
  shouldKeepContent, shouldReadFile, splitKnownExtension,
} from '../electron/fileTypes';

describe('파일 형식', () => {
  it('형식 목록은 md가 맨 앞이고 모두 읽는 확장자에 든다', () => {
    expect(NOTE_FORMATS[0].ext).toBe('md');
    for (const f of NOTE_FORMATS) expect(TEXT_EXTENSIONS.has(f.ext)).toBe(true);
    for (const ext of ['markdown', 'htm', 'ts', 'yml', 'log']) expect(TEXT_EXTENSIONS.has(ext)).toBe(true);
  });
  it('아는 확장자만 떼어 낸다 (대소문자 무시)', () => {
    expect(splitKnownExtension('회의.TXT')).toEqual({ base: '회의', ext: 'txt' });
    expect(splitKnownExtension('폴더/a.b.html')).toEqual({ base: '폴더/a.b', ext: 'html' });
    expect(splitKnownExtension('그림.png')).toEqual({ base: '그림.png', ext: null });
    expect(splitKnownExtension('메모')).toEqual({ base: '메모', ext: null });
    expect(splitKnownExtension('.txt')).toEqual({ base: '.txt', ext: null });
  });
  it('마크다운과 텍스트 경로를 가린다', () => {
    expect(isMarkdownPath('a/b.MD')).toBe(true);
    expect(isMarkdownPath('b.markdown')).toBe(true);
    expect(isMarkdownPath('b.txt')).toBe(false);
    expect(isTextPath('a/b.csv')).toBe(true);
    expect(isTextPath('a/b.pdf')).toBe(false);
    expect(isTextPath('Makefile')).toBe(false);
  });
});

describe('노트 폴더 훑기 필터', () => {
  it('숨김 항목과 node_modules는 건너뛴다', () => {
    expect(isSkippedEntry('.git')).toBe(true);
    expect(isSkippedEntry('node_modules')).toBe(true);
    expect(isSkippedEntry('주제')).toBe(false);
  });
  it('마크다운이 아니면 1MB 넘는 파일은 읽지 않는다', () => {
    expect(shouldReadFile('a.txt', MAX_TEXT_FILE_BYTES)).toBe(true);
    expect(shouldReadFile('a.txt', MAX_TEXT_FILE_BYTES + 1)).toBe(false);
    expect(shouldReadFile('a.md', MAX_TEXT_FILE_BYTES * 5)).toBe(true);
    expect(shouldReadFile('a.zip', 10)).toBe(false);
  });
  it('마크다운이 아니면 NUL 글자가 든 내용은 뺀다', () => {
    expect(shouldKeepContent('a.txt', 'a\0b')).toBe(false);
    expect(shouldKeepContent('a.txt', 'ab')).toBe(true);
    expect(shouldKeepContent('a.md', 'a\0b')).toBe(true);
  });
});

describe('미리보기 방식', () => {
  it('경로 없는 탭과 마크다운은 마크다운, html은 HTML, 나머지는 글자 그대로', () => {
    expect(previewMode(null)).toBe('markdown');
    expect(previewMode('/n/a.md')).toBe('markdown');
    expect(previewMode('/n/a.HTML')).toBe('html');
    expect(previewMode('/n/a.htm')).toBe('html');
    expect(previewMode('/n/a.css')).toBe('plain');
    expect(previewMode('/n/README')).toBe('plain');
  });
});
