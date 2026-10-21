// 저장소 설정 창의 서비스 기본값·입력 검사·상태 문구 테스트
import { describe, expect, it } from 'vitest';
import {
  bucketError, guessPreset, presetById, previewLines, sizeText, regionFromEndpoint, syncStatusText, testResultText, validateCloudForm, type CloudFormValues,
} from '../src/lib/cloudForm';

const base: CloudFormValues = {
  endpoint: 'https://abc123.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'my-notes',
  prefix: '',
  accessKeyId: 'AKID',
  secret: 'shh',
  device: '  회사 맥  ',
  pathStyle: true,
};

describe('서비스 기본값', () => {
  it('R2는 리전 auto와 path-style을 쓰고 엔드포인트는 예시만 보인다', () => {
    const p = presetById('r2');
    expect(p).toMatchObject({ endpoint: '', region: 'auto', pathStyle: true });
    expect(p.endpointPlaceholder).toBe('https://<계정 ID>.r2.cloudflarestorage.com');
  });
  it('AWS는 서울 리전 주소를 넣고 path-style을 끈다', () => {
    expect(presetById('aws')).toMatchObject({ endpoint: 'https://s3.ap-northeast-2.amazonaws.com', region: 'ap-northeast-2', pathStyle: false });
  });
  it('B2와 기타는 path-style을 켜고 기타 리전은 us-east-1', () => {
    expect(presetById('b2').pathStyle).toBe(true);
    expect(presetById('other')).toMatchObject({ region: 'us-east-1', pathStyle: true });
  });
  it('엔드포인트로 서비스를 짐작한다', () => {
    expect(guessPreset('https://x.r2.cloudflarestorage.com')).toBe('r2');
    expect(guessPreset('https://s3.us-west-004.backblazeb2.com')).toBe('b2');
    expect(guessPreset('https://s3.eu-west-1.amazonaws.com')).toBe('aws');
    expect(guessPreset('http://localhost:9000')).toBe('other');
    expect(guessPreset('잘못된 주소')).toBe('other');
  });
});

describe('regionFromEndpoint', () => {
  it('B2 주소에서 리전을 읽는다', () => {
    expect(regionFromEndpoint('https://s3.us-west-004.backblazeb2.com')).toBe('us-west-004');
  });
  it('AWS 주소에서 리전을 읽고 R2는 auto', () => {
    expect(regionFromEndpoint('https://s3.ap-northeast-2.amazonaws.com')).toBe('ap-northeast-2');
    expect(regionFromEndpoint('https://acc.r2.cloudflarestorage.com')).toBe('auto');
  });
  it('모르는 주소나 틀을 그대로 둔 주소는 null', () => {
    expect(regionFromEndpoint('https://minio.example.com')).toBeNull();
    expect(regionFromEndpoint('https://s3.<region>.backblazeb2.com')).toBeNull();
    expect(regionFromEndpoint('')).toBeNull();
  });
});

describe('bucketError', () => {
  it('규칙에 맞는 이름은 통과한다', () => {
    expect(bucketError('my-notes.2026')).toBeNull();
  });
  it('짧거나 대문자·밑줄·점 연속·IP 모양은 막는다', () => {
    expect(bucketError('ab')).toContain('3~63자');
    expect(bucketError('My-Notes')).toContain('소문자');
    expect(bucketError('my_notes')).toContain('소문자');
    expect(bucketError('-notes')).toContain('시작하고 끝나야');
    expect(bucketError('a..b')).toContain('잇달아');
    expect(bucketError('192.168.0.1')).toContain('IP');
  });
});

describe('validateCloudForm', () => {
  it('맞는 입력은 다듬어서 돌려준다', () => {
    const res = validateCloudForm({ ...base, endpoint: 'https://abc123.r2.cloudflarestorage.com/', prefix: '/aurora/notes/' }, false);
    expect(res).toEqual({
      ok: true,
      input: { endpoint: 'https://abc123.r2.cloudflarestorage.com', region: 'auto', bucket: 'my-notes', prefix: 'aurora/notes', accessKeyId: 'AKID', pathStyle: true, device: '회사 맥' },
      secret: 'shh',
    });
  });
  it('https가 아니면 localhost만 http를 허용한다', () => {
    expect(validateCloudForm({ ...base, endpoint: 'http://minio.example.com' }, false)).toMatchObject({ ok: false, field: 'endpoint' });
    expect(validateCloudForm({ ...base, endpoint: 'http://localhost:9000' }, false).ok).toBe(true);
  });
  it('예시의 <…>를 그대로 두면 알려 준다', () => {
    const res = validateCloudForm({ ...base, endpoint: 'https://<계정 ID>.r2.cloudflarestorage.com' }, false);
    expect(res).toMatchObject({ ok: false, field: 'endpoint' });
    expect(!res.ok && res.message).toContain('<…>');
  });
  it('필수 칸이 비면 그 칸을 짚는다', () => {
    expect(validateCloudForm({ ...base, region: ' ' }, false)).toMatchObject({ ok: false, field: 'region' });
    expect(validateCloudForm({ ...base, bucket: '' }, false)).toMatchObject({ ok: false, field: 'bucket' });
    expect(validateCloudForm({ ...base, accessKeyId: '' }, false)).toMatchObject({ ok: false, field: 'accessKeyId' });
    expect(validateCloudForm({ ...base, prefix: 'a/../b' }, false)).toMatchObject({ ok: false, field: 'prefix' });
  });
  it('비밀 키는 저장돼 있으면 비워도 되고 그때는 보내지 않는다', () => {
    expect(validateCloudForm({ ...base, secret: '' }, false)).toMatchObject({ ok: false, field: 'secret' });
    const res = validateCloudForm({ ...base, secret: '' }, true);
    expect(res.ok && res.secret).toBeUndefined();
  });
  it('오류 문구는 마침표로 끝난다', () => {
    const res = validateCloudForm({ ...base, bucket: '' }, false);
    expect(!res.ok && res.message.endsWith('.')).toBe(true);
  });
});

describe('상태 문구', () => {
  it('연결 확인 결과를 보여 준다', () => {
    expect(testResultText({ ok: true, conditionalWrites: true, objectCount: 3 })).toBe('연결됨 · 객체 3개 · 동시 저장 보호 지원');
    expect(testResultText({ ok: true, conditionalWrites: false, objectCount: 0 })).toContain('미지원 (두 기기가');
    expect(testResultText({ ok: false, kind: 'auth', message: '키가 맞지 않습니다' })).toBe('키가 맞지 않습니다.');
  });
  it('진행 중이면 개수를, 첫 동기화는 올리는 중으로 보인다', () => {
    expect(syncStatusText({ state: 'syncing', progress: { done: 12, total: 40 } }, '올리는 중')).toBe('올리는 중 12/40');
    expect(syncStatusText({ state: 'syncing' })).toBe('맞추는 중…');
  });
  it('마지막으로 맞춘 때를 오늘·날짜로 나눠 쓴다', () => {
    const now = new Date(2026, 9, 21, 10, 0).getTime();
    expect(syncStatusText({ state: 'idle', lastSync: new Date(2026, 9, 21, 9, 5).getTime() }, '맞추는 중', now)).toContain('오늘 09:05');
    expect(syncStatusText({ state: 'idle', lastSync: new Date(2026, 9, 20, 23, 1).getTime() }, '맞추는 중', now)).toContain('10월 20일 23:01');
  });
  it('오류는 메시지를 담는다', () => {
    expect(syncStatusText({ state: 'error', message: '버킷이 없습니다' })).toBe('오류: 버킷이 없습니다.');
  });
});

describe('클라우드로 바꾸기 전 미리 보기 문구', () => {
  const base = { upload: { count: 128, bytes: 34 * 1024 * 1024 }, download: { count: 0, bytes: 0 }, conflicts: 0, topFolders: [], skipped: 0 };
  it('올릴·받을 파일과 충돌 사본 수를 보인다', () => {
    expect(previewLines(base)).toEqual(['올릴 파일 128개 (34 MB) · 받을 파일 0개 · 충돌 사본 0개.']);
  });
  it('많이 올라가는 폴더와 건너뛸 파일을 덧붙인다', () => {
    const lines = previewLines({ ...base, topFolders: [{ name: '첨부', count: 40 }, { name: 'daily', count: 30 }], skipped: 2 });
    expect(lines[1]).toBe('많이 올라가는 폴더: 첨부 (40), daily (30).');
    expect(lines[2]).toBe('2개 파일은 건너뜁니다.');
  });
  it('500개나 200MB를 넘으면 폴더를 다시 확인하라고 한다', () => {
    expect(previewLines({ ...base, upload: { count: 501, bytes: 1 } }).at(-1)).toBe('노트 폴더가 맞는지 한 번 더 확인하세요.');
    expect(previewLines({ ...base, upload: { count: 1, bytes: 201 * 1024 * 1024 } }).at(-1)).toBe('노트 폴더가 맞는지 한 번 더 확인하세요.');
    expect(previewLines(base)).not.toContain('노트 폴더가 맞는지 한 번 더 확인하세요.');
  });
  it('크기를 읽기 쉽게 적는다', () => {
    expect(sizeText(120)).toBe('120 B');
    expect(sizeText(2048)).toBe('2 KB');
    expect(sizeText(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
  });
});
