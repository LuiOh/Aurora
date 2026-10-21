// 버킷 키 변환, 동기화 대상 판단, 충돌 사본 이름, 대소문자 겹침 찾기를 검사하는 단위 테스트
import { describe, expect, it } from 'vitest';
import { conflictName, findCaseCollisions, isSyncable, normalizePrefix, toKey, toRel } from '../electron/cloud/keys';

const nfd = '메모'.normalize('NFD');

describe('클라우드 키', () => {
  it('접두사를 비우거나 끝에 / 하나로 맞춘다', () => {
    expect(normalizePrefix('')).toBe('');
    expect(normalizePrefix('/')).toBe('');
    expect(normalizePrefix('aurora')).toBe('aurora/');
    expect(normalizePrefix('/a//b/')).toBe('a/b/');
    expect(normalizePrefix('a\\b')).toBe('a/b/');
  });

  it('경로와 키를 오가며 NFC로 맞춘다', () => {
    expect(toKey('aurora', `폴더\\${nfd}.md`)).toBe('aurora/폴더/메모.md');
    expect(toKey('', './a.md')).toBe('a.md');
    expect(toRel('aurora/', `aurora/${nfd}.md`)).toBe('메모.md');
    expect(toRel('aurora', 'other/a.md')).toBeNull();
    expect(toRel('aurora', 'aurora/')).toBeNull();
    expect(toRel('aurora', 'aurora/폴더/')).toBeNull();
    expect(toRel('', 'x/y.txt')).toBe('x/y.txt');
  });

  it('동기화 대상을 고른다', () => {
    for (const rel of ['메모.md', 'a/b.txt', 'x.html', '첨부/그림.png', '회의/첨부/문서.pdf', '.aurora/folders.json', '.aurora/chats/1.json', '.aurora/chats/2026/a.json']) {
      expect(isSyncable(rel), rel).toBe(true);
    }
    for (const rel of ['그림.png', '.git/config', '.obsidian/app.json', '.aurora-probe/x', '.DS_Store', 'a/.DS_Store', 'node_modules/x.md',
      '~$문서.md', '첨부/~$표.xlsx', 'a.tmp', '첨부/b.TMP', '.aurora/settings.json', '.aurora/chats/.tmp/x.json', '.hidden/a.md', '첨부.png', '']) {
      expect(isSyncable(rel), rel).toBe(false);
    }
  });

  it('공백·+·%·&·한글 이름은 받고 제어 문자가 든 이름은 뺀다', () => {
    for (const rel of ['서울 날씨.md', 'a+b.md', '100%.txt', 'R&D/메모.md', `${nfd} 노트.md`]) {
      expect(isSyncable(rel), rel).toBe(true);
      expect(toRel('p', toKey('p', rel)), rel).toBe(rel.normalize('NFC'));
    }
    for (const rel of ['a\u0000.md', 'a\tb.md', '줄\n바꿈.md', 'x\u001f.md', 'd\u007f/a.md', '\r.md']) {
      expect(isSyncable(rel), JSON.stringify(rel)).toBe(false);
    }
  });

  it('충돌 사본 이름은 폴더를 지키고 기기 이름의 금지 문자를 뺀다', () => {
    const d = new Date(2026, 9, 21, 9, 5);
    expect(conflictName('회의/메모.md', '내 맥북', d)).toBe('회의/메모 (충돌 내 맥북 10-21 0905).md');
    expect(conflictName('메모', 'a/b:c*?"<>|\\d', d)).toBe('메모 (충돌 abcd 10-21 0905)');
    expect(conflictName('x.tar.gz', '', d)).toBe('x.tar (충돌 기기 10-21 0905).gz');
    expect(conflictName('.env', 'pc', d)).toBe('.env (충돌 pc 10-21 0905)');
    expect(conflictName(`${nfd}.md`, 'pc', d, 2)).toBe('메모 (충돌 pc 10-21 0905 2).md');
  });

  it('대소문자나 정규화만 다른 경로를 묶는다', () => {
    expect(findCaseCollisions(['A.md', 'a.md', 'b.md', 'a.md'])).toEqual([['A.md', 'a.md']]);
    expect(findCaseCollisions(['메모.md', `${nfd}.md`])).toHaveLength(1);
    expect(findCaseCollisions(['x/a.md', 'y/a.md'])).toEqual([]);
  });
});

describe('클라우드 키: 앱 묶음 제외', () => {
  it('.app·.framework·.bundle·.download·__MACOSX 아래는 대소문자와 상관없이 맞추지 않는다', () => {
    for (const rel of ['Foo.app/Contents/Info.json', 'x/Lib.Framework/a.js', 'a.bundle/b.md', 'f.download/c.txt', '__MACOSX/a.md', 'z/__macosx/b.md', 'My.APP/a.md']) {
      expect(isSyncable(rel)).toBe(false);
    }
    expect(isSyncable('app/a.md')).toBe(true);
    expect(isSyncable('my.apple/a.md')).toBe(true);
  });
});
