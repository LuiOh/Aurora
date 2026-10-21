// 동기화 계획기가 삭제 없이 올리기·내려받기·기록·충돌 보존을 표대로 정하는지 검사하는 단위 테스트
import { describe, expect, it } from 'vitest';
import { etagHash, planSync } from '../electron/cloud/plan';
import type { LocalFile, RemoteObject, SyncState } from '../electron/cloud/types';

const H1 = '11111111111111111111111111111111';
const H2 = '22222222222222222222222222222222';
const H3 = '33333333333333333333333333333333';
const now = new Date(2026, 9, 21, 14, 30);
const opts = { device: '집 PC', now, conditionalWrites: true };
const L = (rel: string, md5: string): LocalFile => ({ rel, md5, size: 1 });
const R = (key: string, etag: string): RemoteObject => ({ key, etag, size: 1, lastModified: '2026-10-21T00:00:00Z' });
const copy = (rel: string, n = '') => rel.replace(/(\.[^.]+)?$/, (ext) => ` (충돌 집 PC 10-21 1430${n})${ext}`);

describe('동기화 계획', () => {
  it('ETag가 MD5 모양일 때만 내용 해시로 본다', () => {
    expect(etagHash(`"${H1.toUpperCase()}"`)).toBe(H1);
    expect(etagHash(`${H1}-4`)).toBeNull();
    expect(etagHash('abc')).toBeNull();
  });

  describe('표', () => {
    const cases: { name: string; local?: string; remote?: string; state?: { md5: string; etag: string }; want: unknown }[] = [
      { name: '로컬만, 상태 없음 → 새로 올림', local: H1, want: { type: 'upload', rel: 'a.md', ifNoneMatch: '*' } },
      { name: '로컬만, 상태 있음 → 다시 올림(삭제 전파 안 함)', local: H1, state: { md5: H1, etag: H1 }, want: { type: 'upload', rel: 'a.md', ifNoneMatch: '*' } },
      { name: '원격만, 상태 없음 → 내려받음', remote: H1, want: { type: 'download', rel: 'a.md', etag: H1 } },
      { name: '원격만, 상태 있음 → 내려받음(로컬 삭제 전파 안 함)', remote: H1, state: { md5: H1, etag: H1 }, want: { type: 'download', rel: 'a.md', etag: H1 } },
      { name: '첫 동기화, 같은 내용 → 기록', local: H1, remote: `"${H1}"`, want: { type: 'record', rel: 'a.md', md5: H1, etag: H1 } },
      { name: '첫 동기화, 다른 내용 → 충돌', local: H1, remote: H2, want: { type: 'conflict', rel: 'a.md', copyRel: copy('a.md'), etag: H2 } },
      { name: '첫 동기화, 멀티파트 ETag → 충돌', local: H1, remote: `${H1}-2`, want: { type: 'conflict', rel: 'a.md', copyRel: copy('a.md'), etag: `${H1}-2` } },
      { name: '둘 다 그대로 → 할 일 없음', local: H1, remote: H1, state: { md5: H1, etag: `"${H1}"` }, want: undefined },
      { name: '로컬만 바뀜 → If-Match로 올림', local: H2, remote: H1, state: { md5: H1, etag: H1 }, want: { type: 'upload', rel: 'a.md', ifMatch: H1 } },
      { name: '원격만 바뀜 → 내려받음', local: H1, remote: H2, state: { md5: H1, etag: H1 }, want: { type: 'download', rel: 'a.md', etag: H2 } },
      { name: '둘 다 같은 내용으로 바뀜 → 기록', local: H2, remote: H2, state: { md5: H1, etag: H1 }, want: { type: 'record', rel: 'a.md', md5: H2, etag: H2 } },
      { name: '둘 다 다르게 바뀜 → 충돌', local: H2, remote: H3, state: { md5: H1, etag: H1 }, want: { type: 'conflict', rel: 'a.md', copyRel: copy('a.md'), etag: H3 } },
      { name: '멀티파트 원격이 그대로, 로컬 바뀜 → 올림', local: H2, remote: 'x-3', state: { md5: H1, etag: 'x-3' }, want: { type: 'upload', rel: 'a.md', ifMatch: 'x-3' } },
      { name: '멀티파트 원격이 바뀌고 로컬도 바뀜 → 충돌', local: H2, remote: 'y-3', state: { md5: H1, etag: 'x-3' }, want: { type: 'conflict', rel: 'a.md', copyRel: copy('a.md'), etag: 'y-3' } },
    ];
    for (const c of cases) {
      it(c.name, () => {
        const state: SyncState = c.state ? { 'a.md': c.state } : {};
        const actions = planSync(c.local ? [L('a.md', c.local)] : [], c.remote ? [R('a.md', c.remote)] : [], state, opts);
        expect(actions).toEqual(c.want === undefined ? [] : [c.want]);
      });
    }
  });

  it('조건부 쓰기를 못 쓰면 조건 헤더 없이 올린다', () => {
    const o = { ...opts, conditionalWrites: false };
    expect(planSync([L('a.md', H1)], [], {}, o)).toEqual([{ type: 'upload', rel: 'a.md' }]);
    expect(planSync([L('a.md', H2)], [R('a.md', H1)], { 'a.md': { md5: H1, etag: H1 } }, o)).toEqual([{ type: 'upload', rel: 'a.md' }]);
  });

  it('삭제 동작은 절대 만들지 않고 이름 순으로 정렬한다', () => {
    const actions = planSync(
      [L('나.md', H1), L('b.md', H1), L('a/x.txt', H2)],
      [R('가.md', H1), R('b.md', H2), R('z.md', H3)],
      { 'b.md': { md5: H1, etag: H1 }, 'gone.md': { md5: H1, etag: H1 } },
      opts,
    );
    expect(actions.map((a) => [a.type, a.rel])).toEqual([
      ['upload', 'a/x.txt'], ['download', 'b.md'], ['download', 'z.md'], ['download', '가.md'], ['upload', '나.md'],
    ]);
    for (const a of actions) expect(['upload', 'download', 'record', 'conflict', 'skip']).toContain(a.type);
  });

  it('한글 이름과 NFD 원격 키를 NFC로 맞춰 같은 파일로 본다', () => {
    const rel = '회의/메모.md';
    const actions = planSync([L(rel, H1)], [R(rel.normalize('NFD'), H1)], {}, opts);
    expect(actions).toEqual([{ type: 'record', rel, md5: H1, etag: H1 }]);
  });

  it('한쪽에 NFC·NFD 두 파일이 있으면 건너뛴다', () => {
    const rel = '메모.md';
    const actions = planSync([L(rel, H1), L(rel.normalize('NFD'), H2)], [], {}, opts);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'skip', rel });
  });

  it('대소문자만 다른 이름은 묶음 전체를 건너뛴다', () => {
    const actions = planSync([L('Note.md', H1)], [R('note.md', H2), R('other.md', H3)], {}, opts);
    expect(actions.map((a) => [a.type, a.rel])).toEqual([['skip', 'Note.md'], ['skip', 'note.md'], ['download', 'other.md']]);
    expect(actions[0]).toMatchObject({ reason: expect.stringContaining('대소문자') });
  });

  it('충돌 사본 이름이 이미 있으면 번호를 붙인다', () => {
    const rel = '회의/메모.md';
    const taken = copy(rel);
    const actions = planSync([L(rel, H1), L(taken, H3)], [R(rel, H2), R(taken, H3)], {}, opts);
    expect(actions).toContainEqual({ type: 'conflict', rel, copyRel: copy(rel, ' 2'), etag: H2 });
    expect(actions).toContainEqual({ type: 'record', rel: taken, md5: H3, etag: H3 });
  });

  it('한 번에 여러 충돌이 나도 사본 이름이 겹치지 않는다', () => {
    const actions = planSync([L('a.md', H1), L('b.md', H1)], [R('a.md', H2), R('b.md', H2)], {}, opts);
    expect(actions).toEqual([
      { type: 'conflict', rel: 'a.md', copyRel: copy('a.md'), etag: H2 },
      { type: 'conflict', rel: 'b.md', copyRel: copy('b.md'), etag: H2 },
    ]);
  });
});
