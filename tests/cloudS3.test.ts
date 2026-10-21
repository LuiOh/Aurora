// 가짜 fetch로 S3 클라이언트의 주소·메서드·서명·조건 헤더·오류 분류·조건부 쓰기 확인을 검사하는 단위 테스트 (네트워크 없음)
import { describe, expect, it } from 'vitest';
import { createS3Client, objectUrl } from '../electron/cloud/s3';
import { CloudError, type CloudConfig } from '../electron/cloud/types';

const cfg: CloudConfig = {
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'notes',
  prefix: 'aurora',
  accessKeyId: 'AKID',
  secretAccessKey: 'SECRET',
  pathStyle: true,
};

type Reply = { status: number; body?: string; headers?: Record<string, string> };

function fakeFetch(replies: Reply[] | ((req: Request) => Reply)) {
  const calls: Request[] = [];
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    if (!(input instanceof Request)) throw new Error('Request 객체를 기대함');
    calls.push(input);
    const r = typeof replies === 'function' ? replies(input) : replies.shift();
    if (!r) throw new Error('응답이 모자람');
    return new Response(input.method === 'HEAD' || r.status === 204 ? null : (r.body ?? ''), { status: r.status, headers: r.headers });
  };
  return { calls, impl: impl as typeof fetch };
}

const errXml = (code: string) => `<?xml version="1.0"?><Error><Code>${code}</Code><Message>m</Message></Error>`;

describe('S3 클라이언트', () => {
  it('경로 방식과 가상 호스트 방식 주소를 만들고 키 조각을 인코딩한다', () => {
    const key = 'aurora/회의/a b+c#?.md';
    expect(objectUrl(cfg, key)).toBe('https://acct.r2.cloudflarestorage.com/notes/aurora/%ED%9A%8C%EC%9D%98/a%20b%2Bc%23%3F.md');
    const nfd = key.normalize('NFD');
    expect(objectUrl(cfg, nfd)).toBe(`https://acct.r2.cloudflarestorage.com/notes/${nfd.split('/').map(encodeURIComponent).join('/')}`);
    expect(objectUrl({ ...cfg, pathStyle: false, endpoint: 'https://s3.us-east-1.amazonaws.com/' }, 'x/y.md'))
      .toBe('https://notes.s3.us-east-1.amazonaws.com/x/y.md');
  });

  it('목록은 쪽을 넘기며 모두 모으고 서명한다', async () => {
    const f = fakeFetch([
      { status: 200, body: '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>T/1=</NextContinuationToken><Contents><Key>aurora/가 나+다.md</Key><ETag>"e1"</ETag><Size>1</Size><LastModified>t</LastModified></Contents></ListBucketResult>' },
      { status: 200, body: '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>aurora/R&amp;D 50%.md</Key><ETag>"e2"</ETag><Size>2</Size><LastModified>t</LastModified></Contents></ListBucketResult>' },
    ]);
    const objs = await createS3Client(cfg, f.impl).list('aurora/');
    expect(objs.map((o) => [o.key, o.etag])).toEqual([['aurora/가 나+다.md', 'e1'], ['aurora/R&D 50%.md', 'e2']]);
    expect(f.calls).toHaveLength(2);
    const u1 = new URL(f.calls[0].url);
    expect(f.calls[0].method).toBe('GET');
    expect(u1.pathname).toBe('/notes/');
    expect(u1.searchParams.get('list-type')).toBe('2');
    expect(u1.searchParams.has('encoding-type')).toBe(false);
    expect(u1.searchParams.get('prefix')).toBe('aurora/');
    expect(u1.searchParams.has('continuation-token')).toBe(false);
    expect(new URL(f.calls[1].url).searchParams.get('continuation-token')).toBe('T/1=');
    expect(f.calls[0].headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request/);
  });

  it('조건부 PUT은 If-Match·If-None-Match를 보내고 412를 바로 precondition으로 알린다', async () => {
    const f = fakeFetch([{ status: 200, headers: { etag: '"new"' } }, { status: 412, body: errXml('PreconditionFailed') }]);
    const s3 = createS3Client(cfg, f.impl);
    await expect(s3.put('aurora/a.md', new TextEncoder().encode('hi'), { ifMatch: 'old', contentType: 'text/markdown' })).resolves.toEqual({ etag: 'new' });
    const put = f.calls[0];
    expect(put.method).toBe('PUT');
    expect(put.url).toBe('https://acct.r2.cloudflarestorage.com/notes/aurora/a.md');
    expect(put.headers.get('if-match')).toBe('"old"');
    expect(put.headers.get('content-type')).toBe('text/markdown');
    expect(new TextDecoder().decode(await put.arrayBuffer())).toBe('hi');
    const err = await s3.put('aurora/a.md', new Uint8Array([1]), { ifNoneMatch: '*' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudError);
    expect((err as CloudError).kind).toBe('precondition');
    expect(f.calls[1].headers.get('if-none-match')).toBe('*');
    expect(f.calls).toHaveLength(2);
  });

  it('get은 내용과 ETag를, head는 404에서 null을 돌려준다', async () => {
    const f = fakeFetch([
      { status: 200, body: '내용', headers: { etag: '"abc"' } },
      { status: 200, headers: { etag: '"abc"', 'content-length': '6' } },
      { status: 404 },
    ]);
    const s3 = createS3Client(cfg, f.impl);
    const got = await s3.get('aurora/x.md');
    expect(new TextDecoder().decode(got.bytes)).toBe('내용');
    expect(got.etag).toBe('abc');
    expect(await s3.head('aurora/x.md')).toEqual({ etag: 'abc', size: 6 });
    expect(await s3.head('aurora/none.md')).toBeNull();
    expect(f.calls.map((c) => c.method)).toEqual(['GET', 'HEAD', 'HEAD']);
  });

  it('상태 코드와 오류 코드를 종류로 나눈다', async () => {
    const table: [Reply, string][] = [
      [{ status: 403, body: errXml('InvalidAccessKeyId') }, 'auth'],
      [{ status: 403, body: errXml('SignatureDoesNotMatch') }, 'auth'],
      [{ status: 401, body: '' }, 'auth'],
      [{ status: 404, body: errXml('NoSuchBucket') }, 'not-found'],
      [{ status: 409, body: errXml('ConditionalRequestConflict') }, 'precondition'],
      [{ status: 400, body: errXml('InvalidArgument') }, 'bad-request'],
      [{ status: 503, body: errXml('SlowDown') }, 'server'],
      [{ status: 429, body: '' }, 'server'],
    ];
    for (const [reply, kind] of table) {
      const s3 = createS3Client(cfg, fakeFetch([reply]).impl);
      const err = await s3.get('k').catch((e: unknown) => e);
      expect(err, `${reply.status}`).toBeInstanceOf(CloudError);
      expect((err as CloudError).kind).toBe(kind);
      expect((err as CloudError).message).toMatch(/[가-힣]/);
    }
    const bucket = await createS3Client(cfg, fakeFetch([{ status: 404, body: errXml('NoSuchBucket') }]).impl).list('').catch((e: unknown) => e);
    expect((bucket as CloudError).message).toContain('버킷');
  });

  it('fetch의 TypeError는 network 오류가 된다', async () => {
    const impl = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    const err = await createS3Client(cfg, impl).head('k').catch((e: unknown) => e);
    expect((err as CloudError).kind).toBe('network');
  });

  it('서버가 응답하지 않으면 시간 제한 뒤 network 오류로 끊는다', async () => {
    let aborted = false;
    const hang = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(init.signal?.reason);
      });
    })) as typeof fetch;
    const s3 = createS3Client(cfg, hang, { baseTimeoutMs: 20 });
    for (const call of [() => s3.list(''), () => s3.get('k'), () => s3.head('k'), () => s3.put('k', new Uint8Array(1)), () => s3.remove('k')]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CloudError);
      expect((err as CloudError).kind).toBe('network');
      expect((err as CloudError).message).toContain('응답하지 않습니다');
    }
    expect(aborted).toBe(true);
  });

  it('signal을 무시하는 fetch도 시간 제한 뒤 끊는다', async () => {
    const never = (() => new Promise<Response>(() => undefined)) as typeof fetch;
    const err = await createS3Client(cfg, never, { baseTimeoutMs: 20 }).list('').catch((e: unknown) => e);
    expect((err as CloudError).kind).toBe('network');
  });

  it('Electron net::ERR_ 오류는 network이고 HTTP 오류 응답은 그대로 분류한다', async () => {
    const refused = (async () => { throw new Error('net::ERR_CONNECTION_REFUSED'); }) as typeof fetch;
    const err = await createS3Client(cfg, refused).list('').catch((e: unknown) => e);
    expect((err as CloudError).kind).toBe('network');
    expect((err as CloudError).message).toContain('net::ERR_CONNECTION_REFUSED');
    const denied = await createS3Client(cfg, fakeFetch([{ status: 403, body: errXml('AccessDenied') }]).impl).list('').catch((e: unknown) => e);
    expect((denied as CloudError).kind).toBe('auth');
  });

  it('읽기·쓰기 시간 제한은 크기에 따라 늘고 최대값을 넘지 않는다', async () => {
    const seen: number[] = [];
    const hang = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const start = Date.now();
      init?.signal?.addEventListener('abort', () => {
        seen.push(Date.now() - start);
        reject(init.signal?.reason);
      });
    })) as typeof fetch;
    const s3 = createS3Client(cfg, hang, { baseTimeoutMs: 10, perMbTimeoutMs: 100, maxTimeoutMs: 400 });
    await s3.get('k', 1024 * 1024).catch(() => undefined);
    await s3.get('k', 100 * 1024 * 1024).catch(() => undefined);
    expect(seen[0]).toBeGreaterThanOrEqual(100);
    expect(seen[0]).toBeLessThan(380);
    expect(seen[1]).toBeGreaterThanOrEqual(380);
  });

  it('조건부 쓰기 확인: If-None-Match와 틀린 If-Match가 모두 412면 true이고 확인용 파일은 지운다', async () => {
    const f = fakeFetch([
      { status: 200, headers: { etag: '"p"' } }, { status: 412, body: errXml('PreconditionFailed') },
      { status: 412, body: errXml('PreconditionFailed') }, { status: 204 },
    ]);
    expect(await createS3Client(cfg, f.impl).probeConditionalWrites()).toBe(true);
    expect(f.calls.map((c) => c.method)).toEqual(['PUT', 'PUT', 'PUT', 'DELETE']);
    const path = new URL(f.calls[0].url).pathname;
    expect(path).toMatch(/^\/notes\/aurora\/\.aurora-probe\/.+/);
    expect(f.calls.every((c) => new URL(c.url).pathname === path)).toBe(true);
    expect(f.calls[0].headers.get('if-none-match')).toBe('*');
    expect(f.calls[1].headers.get('if-none-match')).toBe('*');
    expect(f.calls[2].headers.get('if-match')).toMatch(/^"0{32}"$/);
  });

  it('조건부 쓰기 확인: 두 번째 쓰기도 성공하면 false이고 그래도 지운다', async () => {
    const f = fakeFetch([{ status: 200 }, { status: 200 }, { status: 204 }]);
    expect(await createS3Client(cfg, f.impl).probeConditionalWrites()).toBe(false);
    expect(f.calls.map((c) => c.method)).toEqual(['PUT', 'PUT', 'DELETE']);
  });

  it('조건부 쓰기 확인: If-Match를 무시하거나 501로 답하면 false다', async () => {
    const ignored = fakeFetch([{ status: 200 }, { status: 412, body: errXml('PreconditionFailed') }, { status: 200 }, { status: 204 }]);
    expect(await createS3Client(cfg, ignored.impl).probeConditionalWrites()).toBe(false);
    const unsupported = fakeFetch([{ status: 200 }, { status: 412, body: errXml('PreconditionFailed') }, { status: 501, body: errXml('NotImplemented') }, { status: 204 }]);
    expect(await createS3Client(cfg, unsupported.impl).probeConditionalWrites()).toBe(false);
    const noHeader = fakeFetch([{ status: 400, body: errXml('NotImplemented') }, { status: 200 }, { status: 204 }]);
    expect(await createS3Client(cfg, noHeader.impl).probeConditionalWrites()).toBe(false);
  });

  it('조건부 쓰기 확인: 확인용 파일을 지우지 못해도 결과를 돌려준다', async () => {
    const f = fakeFetch([
      { status: 200 }, { status: 412, body: errXml('PreconditionFailed') },
      { status: 412, body: errXml('PreconditionFailed') }, { status: 403, body: errXml('AccessDenied') },
    ]);
    expect(await createS3Client(cfg, f.impl).probeConditionalWrites()).toBe(true);
  });

  it('get은 content-length나 받은 크기가 한도를 넘으면 거절한다', async () => {
    const f = fakeFetch([{ status: 200, body: 'x'.repeat(50), headers: { 'content-length': '50' } }, { status: 200, body: 'x'.repeat(50) }]);
    const s3 = createS3Client(cfg, f.impl);
    await expect(s3.get('k', undefined, 10)).rejects.toMatchObject({ kind: 'bad-request' });
    await expect(s3.get('k', undefined, 10)).rejects.toMatchObject({ kind: 'bad-request' });
  });

  it('요청 한도를 넘은 403은 인증 오류가 아니라 서버 오류로 본다', async () => {
    const { errorFromResponse } = await import('../electron/cloud/s3');
    const cap = '<Error><Code>AccessDenied</Code><Message>Transaction cap exceeded</Message></Error>';
    expect(errorFromResponse(403, cap).kind).toBe('server');
    expect(errorFromResponse(403, errXml('transaction_cap_exceeded')).kind).toBe('server');
    expect(errorFromResponse(503, errXml('SlowDown')).kind).toBe('server');
    expect(errorFromResponse(403, errXml('AccessDenied')).kind).toBe('auth');
  });
});
