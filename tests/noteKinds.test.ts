// 노트 저장 폴더 설정과 주제·목차 노트의 경로·첫 내용 틀을 검사하는 단위 테스트
import { describe, expect, it } from 'vitest';
import { DEFAULT_FOLDERS, cleanFolder, folderFromInput, kindNoteContent, kindNotePath, parseFolders } from '../src/lib/noteKinds';

describe('주제·목차 노트', () => {
  it('정한 폴더에 만들고, 이름에 폴더가 있으면 그대로 쓴다', () => {
    expect(kindNotePath('주제', '바이닉 문진')).toBe('주제/바이닉 문진.md');
    expect(kindNotePath('목차', '업무 목차.md')).toBe('목차/업무 목차.md');
    expect(kindNotePath('주제', '공부/Electron')).toBe('공부/Electron.md');
  });

  it('제목과 종류 태그를 넣은 틀을 만든다', () => {
    expect(kindNoteContent('topic', 'Electron')).toMatch(/^# Electron\n\n#주제\n\n## 요약/);
    expect(kindNoteContent('moc', '업무 목차')).toBe('# 업무 목차\n\n#목차\n\n## 주제\n- [[]]\n');
  });
});

describe('저장 폴더 설정', () => {
  it('폴더 이름의 앞뒤 공백과 / 를 다듬고, 폴더 밖이나 숨김 폴더는 막는다', () => {
    expect(cleanFolder(' /업무/ 주제 / ')).toBe('업무/주제');
    expect(cleanFolder('')).toBeNull();
    expect(cleanFolder('../밖')).toBeNull();
    expect(cleanFolder('.aurora')).toBeNull();
    expect(cleanFolder('회의: 10월')).toBeNull();
  });

  it('없거나 깨졌거나 잘못된 값은 기본 폴더로 채운다', () => {
    expect(parseFolders(null)).toEqual(DEFAULT_FOLDERS);
    expect(parseFolders('{깨짐')).toEqual(DEFAULT_FOLDERS);
    expect(parseFolders('{"daily":"일지","topic":"..","moc":3}')).toEqual({ daily: '일지', topic: '주제', moc: '목차' });
  });
});

describe('저장 위치 입력', () => {
  const root = '/Users/me/Notes';
  it('노트 폴더 안의 전체 경로와 상대 경로를 노트 폴더 기준 폴더로 바꾼다', () => {
    expect(folderFromInput(root, '/Users/me/Notes/업무/일지/')).toEqual({ folder: '업무/일지' });
    expect(folderFromInput(root, '주제')).toEqual({ folder: '주제' });
    expect(folderFromInput('C:/노트', 'C:\\노트\\목차')).toEqual({ folder: '목차' });
    expect(folderFromInput('C:/Notes', 'c:/notes/Daily')).toEqual({ folder: 'Daily' });
  });

  it('노트 폴더 자신이나 바깥, 이름만 겹치는 옆 폴더는 받지 않는다', () => {
    expect(folderFromInput(root, '/Users/me/Notes')).toHaveProperty('error');
    expect(folderFromInput(root, '/Users/me/Other/주제')).toHaveProperty('error');
    expect(folderFromInput(root, '/Users/me/Notes2/주제')).toHaveProperty('error');
    expect(folderFromInput(root, '../밖')).toHaveProperty('error');
  });
});
