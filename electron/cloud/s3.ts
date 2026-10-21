// aws4fetch로 서명한 요청을 주입된 fetch로 보내는 S3 호환 저장소 클라이언트 (목록·읽기·쓰기·조건부 쓰기 확인)
import { AwsClient } from 'aws4fetch';
import { normalizePrefix } from './keys';
import { parseListObjects, parseS3Error, stripEtag } from './xml';
import { CloudError, type CloudConfig, type RemoteObject } from './types';

export interface PutOptions {
  ifMatch?: string;
  ifNoneMatch?: '*';
  contentType?: string;
}

/** 요청 시간 제한(ms). 읽기·쓰기는 base + 크기(MB)×perMb, 최대 max */
export interface S3ClientOptions {
  baseTimeoutMs?: number;
  perMbTimeoutMs?: number;
  maxTimeoutMs?: number;
}

export interface S3Client {
  list(prefix: string): Promise<RemoteObject[]>;
  /** sizeHint는 목록에서 본 크기로, 내려받기 시간 제한을 늘리는 데 쓴다. maxBytes를 넘는 응답은 bad-request로 거절한다 */
  get(key: string, sizeHint?: number, maxBytes?: number): Promise<{ bytes: Uint8Array; etag: string }>;
  head(key: string): Promise<{ etag: string; size: number } | null>;
  put(key: string, bytes: Uint8Array, opts?: PutOptions): Promise<{ etag: string }>;
  remove(key: string): Promise<void>;
  probeConditionalWrites(): Promise<boolean>;
}

const MAX_LIST_PAGES = 1000;

/** 키를 정규화하지 않고 그대로 인코딩한다 (다른 도구가 만든 NFD 키도 그 이름으로 읽고 쓴다) */
export const encodeKey = (key: string): string => key.split('/').map(encodeURIComponent).join('/');

export function objectUrl(cfg: CloudConfig, key: string): string {
  const base = new URL(cfg.endpoint.trim());
  const path = key === '' ? '' : encodeKey(key);
  if (cfg.pathStyle) {
    const root = base.pathname.replace(/\/+$/, '');
    return `${base.protocol}//${base.host}${root}/${encodeURIComponent(cfg.bucket)}/${path}`;
  }
  return `${base.protocol}//${cfg.bucket}.${base.host}/${path}`;
}

const quoteEtag = (etag: string): string => `"${stripEtag(etag)}"`;

/** B2 transaction_cap_exceeded, 한도 문구가 붙은 AccessDenied, SlowDown 같은 요청 한도 초과 (인증 문제가 아니다) */
const isRateLimit = (code: string, message: string): boolean =>
  /^(SlowDown|TooManyRequests|RequestLimitExceeded|transaction_cap_exceeded)$/i.test(code) ||
  /transaction[ _]cap|cap exceeded|rate limit|too many requests|request limit/i.test(message);

export function errorFromResponse(status: number, body: string): CloudError {
  const parsed = parseS3Error(body);
  const code = parsed?.code ?? '';
  const detail = parsed?.message ? ` (${code}: ${parsed.message})` : code ? ` (${code})` : '';
  const details = { status, code: code || undefined };
  if ((status === 403 || status === 503) && isRateLimit(code, parsed?.message ?? '')) {
    return new CloudError('server', `저장소의 요청 한도를 넘었습니다. 잠시 뒤 다시 맞춥니다${detail}`, details);
  }
  if (status === 401 || status === 403) {
    const why =
      code === 'InvalidAccessKeyId' ? '액세스 키가 없거나 잘못되었습니다'
      : code === 'SignatureDoesNotMatch' ? '비밀 키가 맞지 않습니다'
      : code === 'AccessDenied' ? '이 버킷에 접근할 권한이 없습니다'
      : '인증에 실패했습니다';
    return new CloudError('auth', `${why}${detail}`, details);
  }
  if (status === 404) {
    const what = code === 'NoSuchBucket' ? '버킷을 찾을 수 없습니다' : '파일을 찾을 수 없습니다';
    return new CloudError('not-found', `${what}${detail}`, details);
  }
  if (status === 412 || status === 409) {
    return new CloudError('precondition', `다른 기기가 먼저 이 파일을 바꿨습니다${detail}`, details);
  }
  if (status === 429 || status >= 500) {
    return new CloudError('server', `저장소 서버가 요청을 처리하지 못했습니다 (HTTP ${status})${detail}`, details);
  }
  return new CloudError('bad-request', `저장소가 요청을 거절했습니다 (HTTP ${status})${detail}`, details);
}

const isNotImplemented = (err: unknown): boolean =>
  err instanceof CloudError && (err.status === 501 || err.code === 'NotImplemented');

const networkError = (err: unknown): CloudError =>
  new CloudError('network', `저장소에 연결하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);

const looksLikeNetworkError = (err: unknown): boolean =>
  err instanceof TypeError ||
  (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError' || err.message.includes('net::ERR_')));

/** signal이 끊기면 work가 끝나지 않아도 곧바로 실패한다 (signal을 무시하는 fetch 대비) */
function withDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export function createS3Client(cfg: CloudConfig, fetchImpl: typeof fetch, opts: S3ClientOptions = {}): S3Client {
  const aws = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: 's3',
    region: cfg.region || 'auto',
    retries: 0,
  });
  const baseMs = opts.baseTimeoutMs ?? 30_000;
  const perMbMs = opts.perMbTimeoutMs ?? 10_000;
  const maxMs = opts.maxTimeoutMs ?? 15 * 60_000;
  const timeoutFor = (bytes = 0): number => Math.min(maxMs, baseMs + Math.ceil((bytes / (1024 * 1024)) * perMbMs));

  /** 요청을 보내고 read로 응답 본문까지 읽는다. 시간 제한은 본문 읽기까지 걸린다 */
  async function request<T>(
    method: string, url: string, headers: Record<string, string>, timeoutMs: number,
    read: (res: Response) => Promise<T>, body?: Uint8Array,
  ): Promise<T> {
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      // 큰 파일을 한 번 더 복사하지 않도록 버퍼 전체를 쓰는 배열이면 그대로 넘긴다
      const whole = body.buffer instanceof ArrayBuffer && body.byteOffset === 0 && body.byteLength === body.buffer.byteLength;
      init.body = whole ? body.buffer : new Uint8Array(body).buffer;
    }
    const signed = await aws.sign(url, init);
    const signal = AbortSignal.timeout(timeoutMs);
    const run = async (): Promise<T> => {
      const res = await fetchImpl(signed, { signal }).catch((err: unknown) => {
        throw signal.aborted ? err : networkError(err);
      });
      return read(res);
    };
    try {
      return await withDeadline(run(), signal);
    } catch (err) {
      if (signal.aborted) {
        throw new CloudError('network', `클라우드 서버가 응답하지 않습니다 (${Math.ceil(timeoutMs / 1000)}초 넘게 기다림)`);
      }
      if (err instanceof CloudError) throw err;
      if (looksLikeNetworkError(err)) throw networkError(err);
      throw err;
    }
  }

  async function fail(res: Response): Promise<never> {
    throw errorFromResponse(res.status, await res.text());
  }

  async function list(prefix: string): Promise<RemoteObject[]> {
    const out: RemoteObject[] = [];
    let token: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const u = new URL(objectUrl(cfg, ''));
      u.searchParams.set('list-type', '2');
      const p = prefix.normalize('NFC');
      if (p !== '') u.searchParams.set('prefix', p);
      if (token !== null) u.searchParams.set('continuation-token', token);
      const parsed = await request('GET', u.toString(), {}, timeoutFor(), async (res) =>
        res.ok ? parseListObjects(await res.text()) : fail(res));
      out.push(...parsed.objects.map((o) => ({ ...o, key: o.key.normalize('NFC'), rawKey: o.key })));
      if (!parsed.isTruncated) return out;
      if (parsed.nextContinuationToken === null) {
        throw new CloudError('server', '저장소 목록이 잘렸는데 다음 쪽 표시가 없습니다');
      }
      token = parsed.nextContinuationToken;
    }
    throw new CloudError('server', `저장소 목록이 ${MAX_LIST_PAGES}쪽을 넘어 멈췄습니다`);
  }

  function get(key: string, sizeHint?: number, maxBytes = Infinity): Promise<{ bytes: Uint8Array; etag: string }> {
    const tooBig = (): CloudError => new CloudError('bad-request', `파일이 너무 커서 내려받지 않았습니다 (${Math.round(maxBytes / 1024 / 1024)}MB 초과)`);
    return request('GET', objectUrl(cfg, key), {}, timeoutFor(sizeHint), async (res) => {
      if (!res.ok) return fail(res);
      if (Number(res.headers.get('content-length') ?? '0') > maxBytes) {
        await res.body?.cancel();
        throw tooBig();
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > maxBytes) throw tooBig();
      return { bytes, etag: stripEtag(res.headers.get('etag') ?? '') };
    });
  }

  function head(key: string): Promise<{ etag: string; size: number } | null> {
    return request('HEAD', objectUrl(cfg, key), {}, timeoutFor(), async (res) => {
      if (res.status === 404) return null;
      if (!res.ok) return fail(res);
      return { etag: stripEtag(res.headers.get('etag') ?? ''), size: Number(res.headers.get('content-length') ?? '0') };
    });
  }

  async function put(key: string, bytes: Uint8Array, opts: PutOptions = {}): Promise<{ etag: string }> {
    const headers: Record<string, string> = { 'content-type': opts.contentType ?? 'application/octet-stream' };
    if (opts.ifMatch !== undefined) headers['if-match'] = quoteEtag(opts.ifMatch);
    if (opts.ifNoneMatch !== undefined) headers['if-none-match'] = opts.ifNoneMatch;
    return request('PUT', objectUrl(cfg, key), headers, timeoutFor(bytes.length), async (res) => {
      if (!res.ok) return fail(res);
      return { etag: stripEtag(res.headers.get('etag') ?? '') };
    }, bytes);
  }

  function remove(key: string): Promise<void> {
    return request('DELETE', objectUrl(cfg, key), {}, timeoutFor(), async (res) => {
      if (!res.ok && res.status !== 404) await fail(res);
    });
  }

  /**
   * 조건 헤더를 정말 지키는지 확인한다. 있는 객체에 If-None-Match: * 와 틀린 If-Match를 보내 둘 다 412여야 지원한다고 본다.
   * 조건을 무시하고 써 버리거나 501·NotImplemented로 답하면 지원하지 않는다. 확인용 객체를 못 지워도 실패로 보지 않는다
   */
  async function probeConditionalWrites(): Promise<boolean> {
    const id = `${Date.now().toString(36)}-${crypto.randomUUID()}`;
    const key = `${normalizePrefix(cfg.prefix)}.aurora-probe/${id}`;
    const bytes = new TextEncoder().encode('aurora probe');
    const opts = { contentType: 'text/plain' };
    /** true: 412로 거절함, false: 조건을 모르거나 무시함 */
    const refused = async (cond: PutOptions): Promise<boolean> => {
      try {
        await put(key, bytes, { ...opts, ...cond });
        return false;
      } catch (err) {
        if (err instanceof CloudError && err.kind === 'precondition') return true;
        if (isNotImplemented(err)) return false;
        throw err;
      }
    };
    try {
      try {
        await put(key, bytes, { ...opts, ifNoneMatch: '*' });
      } catch (err) {
        if (!isNotImplemented(err)) throw err;
        await put(key, bytes, opts);
        return false;
      }
      if (!(await refused({ ifNoneMatch: '*' }))) return false;
      return await refused({ ifMatch: '0'.repeat(32) });
    } finally {
      await remove(key).catch((err: unknown) => {
        console.warn('조건부 쓰기 확인용 파일을 지우지 못함', err instanceof Error ? err.message : String(err));
      });
    }
  }

  return { list, get, head, put, remove, probeConditionalWrites };
}
