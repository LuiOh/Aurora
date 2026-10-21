// 임시 폴더와 메모리 속 가짜 S3(fetch)로 두 기기의 동기화 엔진이 올리기·내려받기·충돌·중단·경합을 맞추는지 검사하는 통합 테스트
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { testConnection } from '../electron/cloud/check';
import { createSyncEngine, previewSync, type SyncEngine } from '../electron/cloud/engine';
import type { S3ClientOptions } from '../electron/cloud/s3';
import type { CloudConfig, CloudEvent } from '../electron/cloud/types';
import { contentHash } from '../electron/contentHash';
import { writeTextChecked } from '../electron/fileWrites';
import { createSerialQueue, type SerialQueue } from '../electron/serialQueue';

const cfg: CloudConfig = {
  endpoint: 'https://s3.test', region: 'auto', bucket: 'notes', prefix: 'p', accessKeyId: 'AK', secretAccessKey: 'SK', pathStyle: true,
};
const NOW = new Date(2026, 9, 21, 9, 5);
const md5 = (b: Uint8Array): string => createHash('md5').update(b).digest('hex');
const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface FakeOptions { conditional?: boolean; pageSize?: number }

function createFakeS3(opts: FakeOptions = {}) {
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  const log: string[] = [];
  const hooks: { afterList?: () => void; beforeGet?: (key: string) => Promise<void>; beforePut?: (key: string) => void; failPut?: (n: number) => boolean; hang?: boolean } = {};
  let puts = 0;
  const reply = (status: number, body: BodyInit | null, headers: Record<string, string> = {}) => new Response(body, { status, headers });
  const missing = () => reply(404, '<Error><Code>NoSuchKey</Code><Message>없음</Message></Error>');

  function list(u: URL): Response {
    const prefix = u.searchParams.get('prefix') ?? '';
    const start = Number(u.searchParams.get('continuation-token') ?? '0');
    const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const size = opts.pageSize ?? 2;
    const page = keys.slice(start, start + size);
    const more = start + size < keys.length;
    const contents = page.map((k) => `<Contents><Key>${xmlEscape(k)}</Key><ETag>&quot;${objects.get(k)?.etag}&quot;</ETag><Size>${objects.get(k)?.bytes.length}</Size><LastModified>t</LastModified></Contents>`);
    hooks.afterList?.();
    const token = more ? `<NextContinuationToken>${start + size}</NextContinuationToken>` : '';
    return reply(200, `<ListBucketResult><IsTruncated>${more}</IsTruncated>${token}${contents.join('')}</ListBucketResult>`);
  }

  function put(key: string, req: Request, bytes: Uint8Array): Response {
    const cur = objects.get(key);
    if (opts.conditional !== false) {
      const ifMatch = req.headers.get('if-match');
      if (ifMatch !== null && (!cur || ifMatch.replace(/"/g, '') !== cur.etag)) return reply(412, '<Error><Code>PreconditionFailed</Code></Error>');
      if (req.headers.get('if-none-match') === '*' && cur) return reply(412, '<Error><Code>PreconditionFailed</Code></Error>');
    }
    const etag = md5(bytes);
    objects.set(key, { bytes, etag });
    return reply(200, null, { etag: `"${etag}"` });
  }

  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    if (!(input instanceof Request)) throw new Error('Request 객체를 기대함');
    const u = new URL(input.url);
    const key = u.pathname.slice('/notes/'.length).split('/').map(decodeURIComponent).join('/');
    log.push(`${input.method} ${key === '' ? '(list)' : key}`);
    if (hooks.hang) return new Promise<Response>(() => undefined);
    if (input.method === 'GET' && key === '') return list(u);
    if (input.method === 'GET') await hooks.beforeGet?.(key);
    const cur = objects.get(key);
    if (input.method === 'GET') return cur ? reply(200, new Uint8Array(cur.bytes), { etag: `"${cur.etag}"` }) : missing();
    if (input.method === 'HEAD') return cur ? reply(200, null, { etag: `"${cur.etag}"` }) : reply(404, null);
    if (input.method === 'DELETE') {
      objects.delete(key);
      return reply(204, null);
    }
    puts++;
    if (hooks.failPut?.(puts)) throw new TypeError('fetch failed');
    const bytes = new Uint8Array(await input.arrayBuffer());
    hooks.beforePut?.(key);
    return put(key, input, bytes);
  };
  const text = (rel: string): string | undefined => {
    const o = objects.get(`p/${rel}`);
    return o && new TextDecoder().decode(o.bytes);
  };
  const userKeys = () => [...objects.keys()].sort();
  return { fetch: fetchImpl as typeof fetch, objects, log, hooks, text, userKeys };
}

type FakeS3 = ReturnType<typeof createFakeS3>;

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'aurora-cloud-'));
  temps.push(d);
  return d;
}

interface Device { name: string; dir: string; engine: SyncEngine; events: CloudEvent[] }

async function device(name: string, s3: FakeS3, s3Options?: S3ClientOptions, extra: { changedFlushMs?: number; concurrency?: number; writeQueue?: SerialQueue } = {}): Promise<Device> {
  const dir = await tempDir();
  const stateDir = await tempDir();
  const events: CloudEvent[] = [];
  const engine = createSyncEngine({
    fetch: s3.fetch, stateDir, now: () => NOW, maxFileBytes: 1024, s3Options, ...extra,
    load: async () => ({ cfg, device: name, notesDir: dir }),
    emit: (ev) => events.push(ev),
  });
  return { name, dir, engine, events };
}

async function put(d: Device, rel: string, content: string): Promise<void> {
  const abs = path.join(d.dir, ...rel.split('/'));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

const read = (d: Device, rel: string): Promise<string> => readFile(path.join(d.dir, ...rel.split('/')), 'utf8');

async function files(dir: string, base = ''): Promise<string[]> {
  const out: string[] = [];
  for (const ent of await readdir(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...(await files(dir, rel)));
    else out.push(rel.normalize('NFC'));
  }
  return out.sort();
}

const lastStatus = (d: Device) => [...d.events].reverse().find((e) => e.type === 'status');

describe('클라우드 동기화 엔진', () => {
  it('클라우드로 바꾸면 동기화 대상만 올리고 숨김·대상 아님·큰 파일은 건너뛴다', async () => {
    const s3 = createFakeS3();
    const a = await device('A', s3);
    await put(a, '메모.md', '# 메모');
    await put(a, '서울 날씨.md', '맑음');
    await put(a, 'R&D <1>/a+b 100%.txt', '특수');
    await put(a, '첨부/그림.png', 'png');
    await put(a, '.aurora/folders.json', '{}');
    await put(a, 'photo.png', 'x');
    await put(a, '.hidden/x.md', 'x');
    await put(a, 'node_modules/y.md', 'y');
    await put(a, 'big.md', 'x'.repeat(2000));
    await a.engine.sync();
    expect(s3.userKeys()).toEqual(['p/.aurora/folders.json', 'p/R&D <1>/a+b 100%.txt', 'p/메모.md', 'p/서울 날씨.md', 'p/첨부/그림.png'].sort());
    expect(s3.log.filter((l) => l.startsWith('DELETE')).every((l) => l.includes('.aurora-probe/'))).toBe(true);
    const st = lastStatus(a);
    expect(st?.type === 'status' && st.status.state).toBe('idle');
    expect(st?.type === 'status' && st.status.message).toContain('1개는 동기화하지 않았습니다');
    expect(st?.type === 'status' && typeof st.status.lastSync).toBe('number');
  });

  it('빈 폴더의 두 번째 기기는 모두 내려받고 바뀐 경로를 알린다', async () => {
    const s3 = createFakeS3();
    const a = await device('A', s3);
    await put(a, '서울 날씨.md', '맑음');
    await put(a, '회의/메모.md', '회의');
    await a.engine.sync();
    const b = await device('B', s3);
    await b.engine.sync();
    expect(await files(b.dir)).toEqual(['서울 날씨.md', '회의/메모.md']);
    expect(await read(b, '회의/메모.md')).toBe('회의');
    const changed = b.events.flatMap((e) => (e.type === 'changed' ? e.paths : []));
    expect(changed.sort()).toEqual([`${b.dir}/서울 날씨.md`, `${b.dir}/회의/메모.md`].map((p) => p.replace(/\\/g, '/')).sort());
  });

  it('A에서 고치면 B가 내려받고, 다시 돌려도 아무것도 올리지 않는다', async () => {
    const s3 = createFakeS3();
    const a = await device('A', s3);
    const b = await device('B', s3);
    await put(a, 'a.md', '하나');
    await a.engine.sync();
    await b.engine.sync();
    await put(a, 'a.md', '하나 고침');
    await a.engine.sync();
    await b.engine.sync();
    expect(await read(b, 'a.md')).toBe('하나 고침');
    const before = s3.log.length;
    await a.engine.sync();
    await b.engine.sync();
    expect(s3.log.slice(before).filter((l) => l.startsWith('PUT') || l.startsWith('GET p/'))).toEqual([]);
  });

  it('양쪽에서 고치면 충돌 사본을 남겨 두 기기 모두 두 내용을 갖는다', async () => {
    const s3 = createFakeS3();
    const a = await device('A', s3);
    const b = await device('B', s3);
    await put(a, 'a.md', '처음');
    await a.engine.sync();
    await b.engine.sync();
    await put(a, 'a.md', 'A가 고침');
    await put(b, 'a.md', 'B가 고친 내용');
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();
    const copy = 'a (충돌 B 10-21 0905).md';
    for (const d of [a, b]) {
      expect(await files(d.dir)).toEqual([copy, 'a.md']);
      expect(await read(d, 'a.md')).toBe('A가 고침');
      expect(await read(d, copy)).toBe('B가 고친 내용');
    }
    expect(b.events).toContainEqual({ type: 'conflict', path: `${b.dir}/a.md`.replace(/\\/g, '/'), copyPath: `${b.dir}/${copy}`.replace(/\\/g, '/') });
  });

  it('원격에서만 지운 파일은 로컬에서 지우지 않고 다시 올린다', async () => {
    const s3 = createFakeS3();
    const a = await device('A', s3);
    await put(a, 'a.md', '남아야 함');
    await a.engine.sync();
    s3.objects.delete('p/a.md');
    await a.engine.sync();
    expect(await read(a, 'a.md')).toBe('남아야 함');
    expect(s3.text('a.md')).toBe('남아야 함');
  });

  it('서버가 응답하지 않으면 실행을 끝내고 offline으로 두며 서버가 돌아오면 다시 맞춘다', async () => {
    const s3 = createFakeS3();
    const a = await device('A', s3, { baseTimeoutMs: 30 });
    await put(a, 'a.md', '가');
    await a.engine.sync();
    await put(a, 'b.md', '나');
    s3.hooks.hang = true;
    await a.engine.sync();
    expect(lastStatus(a)).toMatchObject({ status: { state: 'offline', message: expect.stringContaining('응답하지 않습니다') } });
    expect(a.engine.status().state).toBe('offline');
    s3.hooks.hang = false;
    await a.engine.sync();
    expect(lastStatus(a)).toMatchObject({ status: { state: 'idle' } });
    expect(s3.userKeys()).toEqual(['p/a.md', 'p/b.md']);
  });

  it('도중에 끊긴 실행은 offline이 되고 다시 돌리면 맞춰진다', async () => {
    const s3 = createFakeS3();
    const a = await device('A', s3);
    for (const n of [1, 2, 3, 4, 5, 6]) await put(a, `n${n}.md`, `노트 ${n}`);
    s3.hooks.failPut = (n) => n === 6; // 확인용 PUT 3번 뒤 세 번째 노트에서 끊긴다
    await a.engine.sync();
    expect(lastStatus(a)).toMatchObject({ status: { state: 'offline' } });
    s3.hooks.failPut = undefined;
    await a.engine.sync();
    expect(lastStatus(a)).toMatchObject({ status: { state: 'idle' } });
    expect(s3.userKeys()).toEqual([1, 2, 3, 4, 5, 6].map((n) => `p/n${n}.md`));
    const before = s3.log.length;
    await a.engine.sync();
    expect(s3.log.slice(before).filter((l) => l.startsWith('PUT'))).toEqual([]);
  });

  it('목록을 받은 뒤 다른 기기가 먼저 쓰면 412를 받고 다시 계획해 충돌 사본으로 맞춘다', async () => {
    const s3 = createFakeS3();
    const a = await device('A', s3);
    await put(a, 'a.md', '처음');
    await a.engine.sync();
    await put(a, 'a.md', 'A 고침');
    let raced = false;
    s3.hooks.beforePut = (key) => {
      if (key !== 'p/a.md' || raced) return;
      raced = true;
      const bytes = new TextEncoder().encode('다른 기기 내용');
      s3.objects.set(key, { bytes, etag: md5(bytes) });
    };
    await a.engine.sync();
    expect(raced).toBe(true);
    expect(await read(a, 'a.md')).toBe('다른 기기 내용');
    expect(await read(a, 'a (충돌 A 10-21 0905).md')).toBe('A 고침');
    expect(s3.text('a (충돌 A 10-21 0905).md')).toBe('A 고침');
    expect(s3.text('a.md')).toBe('다른 기기 내용');
  });

  it('NFD 파일 이름과 NFC 키를 같은 파일로 본다', async () => {
    const s3 = createFakeS3();
    const a = await device('A', s3);
    await put(a, '메모.md'.normalize('NFD'), '같은 내용');
    await a.engine.sync();
    expect(s3.userKeys()).toEqual(['p/메모.md']);
    const b = await device('B', s3);
    await put(b, '메모.md'.normalize('NFD'), '같은 내용');
    await b.engine.sync();
    await a.engine.sync();
    expect(await files(a.dir)).toEqual(['메모.md']);
    expect(await files(b.dir)).toEqual(['메모.md']);
    expect(s3.userKeys()).toEqual(['p/메모.md']);
  });

  it('조건부 쓰기를 못 하는 저장소에서도 내려받기와 충돌 사본이 된다', async () => {
    const s3 = createFakeS3({ conditional: false });
    expect(await testConnection(cfg, s3.fetch)).toEqual({ ok: true, conditionalWrites: false, objectCount: 0 });
    const a = await device('A', s3);
    const b = await device('B', s3);
    await put(a, 'a.md', '처음');
    await a.engine.sync();
    await b.engine.sync();
    await put(a, 'a.md', 'A 고침');
    await put(b, 'a.md', 'B 고침!');
    await a.engine.sync();
    await b.engine.sync();
    expect(await read(b, 'a.md')).toBe('A 고침');
    expect(await read(b, 'a (충돌 B 10-21 0905).md')).toBe('B 고침!');
    expect(s3.log.filter((l) => l.startsWith('PUT p/a'))).not.toHaveLength(0);
  });

  it('실행 중에 들어온 요청은 끝난 뒤 한 번만 더 돈다', async () => {
    const s3 = createFakeS3();
    const a = await device('A', s3);
    await put(a, 'a.md', 'x');
    const first = a.engine.sync();
    const second = a.engine.sync();
    const third = a.engine.sync();
    await Promise.all([first, second, third]);
    expect(s3.log.filter((l) => l === 'GET (list)')).toHaveLength(2);
  });

  it('내려받는 도중에도 바뀐 경로를 모아 알리고, 남은 것은 끝날 때 알린다', async () => {
    const s3 = createFakeS3();
    const a = await device('A', s3);
    await put(a, '1.md', '하나');
    await put(a, '2.md', '둘');
    await a.engine.sync();
    const b = await device('B', s3, undefined, { changedFlushMs: 5, concurrency: 1 });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let midRun: string[] = [];
    s3.hooks.beforeGet = async (key) => {
      if (key !== 'p/2.md') return;
      await new Promise((r) => setTimeout(r, 30));
      midRun = b.events.flatMap((e) => (e.type === 'changed' ? e.paths : []));
      release();
    };
    const run = b.engine.sync();
    await gate;
    await run;
    expect(midRun).toEqual([path.join(b.dir, '1.md').replace(/\\/g, '/')]);
    const all = b.events.filter((e) => e.type === 'changed');
    expect(all).toHaveLength(2);
  });

  it('앱 쓰기가 줄을 잡고 있으면 내려받은 파일은 기다렸다가, 그사이 생긴 파일을 덮지 않는다', async () => {
    const s3 = createFakeS3();
    const a = await device('A', s3);
    await put(a, 'x.md', '다른 기기');
    await a.engine.sync();
    const queue = createSerialQueue();
    const b = await device('B', s3, undefined, { writeQueue: queue });
    const target = path.join(b.dir, 'x.md');
    let existedWhileHeld: boolean | null = null;
    let held: Promise<void> = Promise.resolve();
    s3.hooks.beforeGet = async (key) => {
      if (key !== 'p/x.md') return;
      held = queue.run(async () => {
        await new Promise((r) => setTimeout(r, 40));
        existedWhileHeld = await readFile(target, 'utf8').then(() => true, () => false);
        await writeFile(target, '이 기기에서 저장');
      });
    };
    await b.engine.sync();
    await held;
    expect(existedWhileHeld).toBe(false);
    expect(await read(b, 'x.md')).toBe('이 기기에서 저장');
    expect((await files(b.dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(b.events.flatMap((e) => (e.type === 'changed' ? e.paths : []))).toEqual([]);
  });

  it('내려받은 뒤 예전 기준 해시로 저장하면 쓰지 않고 충돌을 알린다', async () => {
    const s3 = createFakeS3();
    const a = await device('A', s3);
    const queue = createSerialQueue();
    const b = await device('B', s3, undefined, { writeQueue: queue });
    await put(a, 'x.md', '처음');
    await a.engine.sync();
    await b.engine.sync();
    const baseline = contentHash(await read(b, 'x.md'));
    await put(a, 'x.md', '다른 기기에서 고침');
    await a.engine.sync();
    await b.engine.sync();
    const target = path.join(b.dir, 'x.md');
    expect(await queue.run(() => writeTextChecked(target, '이 기기 탭 내용', baseline))).toEqual({ ok: false, conflict: true });
    expect(await read(b, 'x.md')).toBe('다른 기기에서 고침');
    expect(await queue.run(() => writeTextChecked(target, '덮어쓰기', contentHash('다른 기기에서 고침')))).toEqual({ ok: true });
    expect(await read(b, 'x.md')).toBe('덮어쓰기');
  });

  it('연결 확인은 객체 수와 조건부 쓰기 지원을 알려 주고 인증 오류는 종류로 돌려준다', async () => {
    const s3 = createFakeS3({ pageSize: 1 });
    s3.objects.set('p/a.md', { bytes: new Uint8Array([1]), etag: 'e' });
    s3.objects.set('other/b.md', { bytes: new Uint8Array([1]), etag: 'e' });
    expect(await testConnection(cfg, s3.fetch)).toEqual({ ok: true, conditionalWrites: true, objectCount: 1 });
    const denied = (async () => new Response('<Error><Code>InvalidAccessKeyId</Code></Error>', { status: 403 })) as typeof fetch;
    expect(await testConnection(cfg, denied)).toMatchObject({ ok: false, kind: 'auth' });
  });
});

describe('클라우드 동기화 엔진: 충돌·임시 파일·원래 키', () => {
  const setObj = (s3: FakeS3, key: string, text: string): void => {
    const bytes = new TextEncoder().encode(text);
    s3.objects.set(key, { bytes, etag: md5(bytes) });
  };
  const copyKeys = (s3: FakeS3) => s3.userKeys().filter((k) => k.includes('충돌'));

  it('원격 원본이 너무 커서 받을 수 없으면 충돌 사본을 만들지 않는다', async () => {
    const s3 = createFakeS3();
    const b = await device('B', s3);
    await put(b, 'a.md', 'B 내용');
    setObj(s3, 'p/a.md', 'x'.repeat(2000));
    await b.engine.sync();
    await b.engine.sync();
    expect(await files(b.dir)).toEqual(['a.md']);
    expect(await read(b, 'a.md')).toBe('B 내용');
    expect(copyKeys(s3)).toEqual([]);
  });

  it('받는 사이 원격이 사라지면 사본 없이 다시 계획해 올린다', async () => {
    const s3 = createFakeS3();
    const b = await device('B', s3);
    await put(b, 'a.md', 'B 내용');
    setObj(s3, 'p/a.md', '원격 내용');
    s3.hooks.beforeGet = async (key) => {
      s3.objects.delete(key);
    };
    await b.engine.sync();
    expect(await files(b.dir)).toEqual(['a.md']);
    expect(copyKeys(s3)).toEqual([]);
    expect(s3.text('a.md')).toBe('B 내용');
  });

  it('원본을 바꾸지 못하면 만든 사본을 걷고 올리지 않는다', async () => {
    const s3 = createFakeS3();
    const b = await device('B', s3);
    await put(b, 'a.md', 'B 내용');
    setObj(s3, 'p/a.md', '원격 내용');
    s3.hooks.beforeGet = async () => {
      s3.hooks.beforeGet = undefined;
      await put(b, 'a.md', 'B가 그사이 또 고침');
    };
    await b.engine.sync();
    expect(await files(b.dir)).toEqual(['a.md']);
    expect(await read(b, 'a.md')).toBe('B가 그사이 또 고침');
    expect(copyKeys(s3)).toEqual([]);
    await b.engine.sync();
    expect(await read(b, 'a.md')).toBe('원격 내용');
    expect(await read(b, 'a (충돌 B 10-21 0905).md')).toBe('B가 그사이 또 고침');
    expect(copyKeys(s3)).toEqual(['p/a (충돌 B 10-21 0905).md']);
  });

  it('훑을 때 한 시간 넘은 우리 임시 파일은 지우고 새 것은 둔다', async () => {
    const { utimes } = await import('node:fs/promises');
    const s3 = createFakeS3();
    const a = await device('A', s3);
    await put(a, '.aurora-sync-old.tmp', '남은 것');
    await put(a, '.aurora-sync-new.tmp', '쓰는 중');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(path.join(a.dir, '.aurora-sync-old.tmp'), old, old);
    await a.engine.sync();
    expect(await files(a.dir)).toEqual(['.aurora-sync-new.tmp']);
    expect(s3.userKeys()).toEqual([]);
  });

  it('갈아 끼우기에 실패하면 임시 파일을 남기지 않는다', async () => {
    const { writeAtomic } = await import('../electron/cloud/localFs');
    const dir = await tempDir();
    await mkdir(path.join(dir, 'busy', 'inner'), { recursive: true });
    await expect(writeAtomic(path.join(dir, 'busy'), new Uint8Array([1]))).rejects.toThrow();
    expect(await files(dir)).toEqual([]);
  });

  it('다른 도구가 만든 NFD 키도 그 키 그대로 읽고 고쳐 올린다', async () => {
    const s3 = createFakeS3();
    const nfd = 'p/메모.md'.normalize('NFD');
    setObj(s3, nfd, '원격');
    const a = await device('A', s3);
    await a.engine.sync();
    expect(await read(a, '메모.md')).toBe('원격');
    await put(a, '메모.md', '고침');
    await a.engine.sync();
    expect(s3.userKeys()).toEqual([nfd]);
    expect(new TextDecoder().decode(s3.objects.get(nfd)?.bytes)).toBe('고침');
    expect(lastStatus(a)).toMatchObject({ status: { state: 'idle' } });
  });

  it('NFC·NFD로만 다른 원격 키가 둘 있으면 둘 다 건너뛰고 알린다', async () => {
    const s3 = createFakeS3();
    setObj(s3, 'p/메모.md', 'NFC');
    setObj(s3, 'p/메모.md'.normalize('NFD'), 'NFD');
    const a = await device('A', s3);
    await a.engine.sync();
    expect(await files(a.dir)).toEqual([]);
    expect(lastStatus(a)).toMatchObject({ status: { state: 'idle', message: expect.stringContaining('정규화') } });
  });

  it('조건부 쓰기가 없는 저장소는 올리기 직전에 확인해 그사이 바뀐 원격을 덮지 않는다', async () => {
    const s3 = createFakeS3({ conditional: false });
    const a = await device('A', s3);
    await put(a, 'a.md', '처음');
    await a.engine.sync();
    await put(a, 'a.md', 'A 고침');
    let raced = false;
    s3.hooks.afterList = () => {
      if (raced) return;
      raced = true;
      setObj(s3, 'p/a.md', '다른 기기 내용');
    };
    await a.engine.sync();
    expect(raced).toBe(true);
    expect(await read(a, 'a.md')).toBe('다른 기기 내용');
    expect(await read(a, 'a (충돌 A 10-21 0905).md')).toBe('A 고침');
    expect(s3.text('a.md')).toBe('다른 기기 내용');
  });

  it('받은 내용의 MD5가 ETag와 다르면 쓰지 않는다', async () => {
    const s3 = createFakeS3();
    s3.objects.set('p/a.md', { bytes: new TextEncoder().encode('깨진 내용'), etag: 'a'.repeat(32) });
    const a = await device('A', s3);
    await a.engine.sync();
    expect(await files(a.dir)).toEqual([]);
    expect(lastStatus(a)).toMatchObject({ status: { state: 'idle', message: expect.stringContaining('MD5') } });
  });

  it('노트 폴더 밖을 가리키는 심볼릭 링크 폴더로는 내려받지 않는다', async () => {
    const { symlink } = await import('node:fs/promises');
    const s3 = createFakeS3();
    const outside = await tempDir();
    setObj(s3, 'p/link/x.md', '밖으로');
    setObj(s3, 'p/ok.md', '안');
    const a = await device('A', s3);
    await symlink(outside, path.join(a.dir, 'link'), 'dir');
    await a.engine.sync();
    expect(await files(outside)).toEqual([]);
    expect(await read(a, 'ok.md')).toBe('안');
    expect(lastStatus(a)).toMatchObject({ status: { state: 'idle', message: expect.stringContaining('심볼릭') } });
  });
});

describe('클라우드 동기화 엔진: 쓴 파일만 올리기·큰 파일·멈춤', () => {
  const setObj = (s3: FakeS3, key: string, text: string): void => {
    const bytes = new TextEncoder().encode(text);
    s3.objects.set(key, { bytes, etag: md5(bytes) });
  };
  const engineFor = (s3: FakeS3, notesDir: string, stateDir: string, events: CloudEvent[] = [], extra: { concurrency?: number; bigFileBytes?: number } = {}) =>
    createSyncEngine({
      fetch: s3.fetch, stateDir, now: () => NOW, maxFileBytes: 1024, ...extra,
      load: async () => ({ cfg, device: 'A', notesDir }), emit: (ev) => events.push(ev),
    });

  it('쓴 파일만 올릴 때는 목록을 받지 않고 지난 ETag를 조건으로 올린다', async () => {
    const s3 = createFakeS3();
    const a = await device('A', s3);
    await put(a, 'a.md', '처음');
    await put(a, 'b.md', '그대로');
    await a.engine.sync();
    await put(a, 'a.md', '고침');
    await put(a, '새 노트.md', '새로');
    await put(a, '.git/x.md', '대상 아님');
    const before = s3.log.length;
    await a.engine.sync({ paths: ['a.md', '새 노트.md', 'b.md', '.git/x.md'].map((r) => path.join(a.dir, r)).concat('/elsewhere/c.md') });
    expect(s3.log.slice(before)).toEqual(['PUT p/a.md', 'PUT p/새 노트.md']);
    expect(s3.text('a.md')).toBe('고침');
    expect(s3.text('새 노트.md')).toBe('새로');
    expect(lastStatus(a)).toMatchObject({ status: { state: 'idle' } });
    const again = s3.log.length;
    await a.engine.sync({ paths: [path.join(a.dir, 'a.md')] });
    expect(s3.log.slice(again)).toEqual([]);
  });

  it('쓴 파일을 올리다 다른 기기가 먼저 바꾼 것을 알면 전체를 맞춰 충돌 사본을 남긴다', async () => {
    const s3 = createFakeS3();
    const a = await device('A', s3);
    await put(a, 'a.md', '처음');
    await a.engine.sync();
    setObj(s3, 'p/a.md', '다른 기기 내용');
    await put(a, 'a.md', 'A 고침');
    await a.engine.sync({ paths: [path.join(a.dir, 'a.md')] });
    expect(await read(a, 'a.md')).toBe('다른 기기 내용');
    expect(await read(a, 'a (충돌 A 10-21 0905).md')).toBe('A 고침');
    expect(s3.text('a.md')).toBe('다른 기기 내용');
  });

  it('조건부 쓰기가 없는 저장소에서도 쓴 파일만 올리기는 HEAD로 확인한다', async () => {
    const s3 = createFakeS3({ conditional: false });
    const a = await device('A', s3);
    await put(a, 'a.md', '처음');
    await a.engine.sync();
    setObj(s3, 'p/a.md', '다른 기기 내용');
    await put(a, 'a.md', 'A 고침');
    await a.engine.sync({ paths: [path.join(a.dir, 'a.md')] });
    expect(s3.text('a.md')).toBe('다른 기기 내용');
    expect(await read(a, 'a (충돌 A 10-21 0905).md')).toBe('A 고침');
  });

  it('큰 파일은 한 번에 하나씩 옮긴다', async () => {
    const s3 = createFakeS3({ pageSize: 100 });
    for (const n of [1, 2, 3]) setObj(s3, `p/big${n}.md`, String(n).repeat(300));
    for (const n of [1, 2, 3]) setObj(s3, `p/s${n}.md`, String(n));
    let inFlight = 0;
    let maxBig = 0;
    let smallSeen = 0;
    s3.hooks.beforeGet = async (key) => {
      if (!key.includes('big')) {
        smallSeen++;
        return;
      }
      inFlight++;
      maxBig = Math.max(maxBig, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
    };
    const dir = await tempDir();
    await engineFor(s3, dir, await tempDir(), [], { bigFileBytes: 100 }).sync();
    expect(maxBig).toBe(1);
    expect(smallSeen).toBe(3);
    expect(await files(dir)).toEqual(['big1.md', 'big2.md', 'big3.md', 's1.md', 's2.md', 's3.md']);
  });

  it('로컬로 바꾸면 도는 실행이 상태를 다시 맞추는 중으로 바꾸지 않는다', async () => {
    const s3 = createFakeS3({ pageSize: 100 });
    for (const n of [1, 2, 3]) setObj(s3, `p/n${n}.md`, `노트 ${n}`);
    const events: CloudEvent[] = [];
    const engine = engineFor(s3, await tempDir(), await tempDir(), events, { concurrency: 1 });
    s3.hooks.beforeGet = async () => {
      s3.hooks.beforeGet = undefined;
      engine.stop();
    };
    await engine.sync();
    const statuses = events.filter((e) => e.type === 'status');
    expect(statuses[statuses.length - 1]).toEqual({ type: 'status', status: { state: 'off' } });
    expect(engine.status().state).toBe('off');
  });

  it('멈춘 뒤 곧바로 다시 켜도 예전 실행은 예전 대상으로 이어 돌지 않는다', async () => {
    const s3 = createFakeS3({ pageSize: 100 });
    for (const n of [1, 2, 3]) setObj(s3, `p/n${n}.md`, `노트 ${n}`);
    const oldDir = await tempDir();
    const newDir = await tempDir();
    let target = oldDir;
    const engine = createSyncEngine({
      fetch: s3.fetch, stateDir: await tempDir(), now: () => NOW, maxFileBytes: 1024, concurrency: 1,
      load: async () => ({ cfg, device: 'A', notesDir: target }), emit: () => undefined,
    });
    let restarted: Promise<void> | null = null;
    s3.hooks.beforeGet = async () => {
      s3.hooks.beforeGet = undefined;
      engine.stop();
      target = newDir;
      restarted = engine.sync();
    };
    await engine.sync();
    await restarted;
    expect((await files(oldDir)).length).toBeLessThanOrEqual(1);
    expect(await files(newDir)).toEqual(['n1.md', 'n2.md', 'n3.md']);
  });

  it('같은 폴더를 다른 경로(심볼릭 링크)로 열어도 지난 상태를 이어 쓴다', async () => {
    const { rename: mv, symlink } = await import('node:fs/promises');
    const { stateFileName } = await import('../electron/cloud/settings');
    const s3 = createFakeS3();
    const stateDir = await tempDir();
    const real = await tempDir();
    const link = path.join(await tempDir(), 'link');
    await symlink(real, link, 'dir');
    await writeFile(path.join(real, 'a.md'), '처음');
    await engineFor(s3, real, stateDir).sync();
    // 예전 방식(경로 그대로)으로 저장된 상태 파일을 흉내 낸다
    const { realpath } = await import('node:fs/promises');
    await mv(path.join(stateDir, stateFileName(cfg, await realpath(real))), path.join(stateDir, stateFileName(cfg, link)));
    setObj(s3, 'p/a.md', '다른 기기 1');
    await engineFor(s3, link, stateDir).sync();
    expect(await readFile(path.join(real, 'a.md'), 'utf8')).toBe('다른 기기 1');
    setObj(s3, 'p/a.md', '다른 기기 2');
    await engineFor(s3, real, stateDir).sync();
    expect(await readFile(path.join(real, 'a.md'), 'utf8')).toBe('다른 기기 2');
    expect(await files(real)).toEqual(['a.md']);
  });
});


describe('클라우드 동기화 엔진: 바꾸기 전 미리 보기', () => {
  it('아무것도 옮기지 않고 올릴·받을 파일 수와 크기, 충돌, 많이 올라가는 폴더를 센다', async () => {
    const s3 = createFakeS3();
    const dir = await tempDir();
    const stateDir = await tempDir();
    const write = async (rel: string, text: string) => {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), text);
    };
    await write('첨부/a.png', 'aaa');
    await write('첨부/b.png', 'bb');
    await write('daily/1.md', 'd');
    await write('top.md', '12345');
    await write('같음.md', '원격과 다름');
    await write('Foo.app/Contents/x.json', '{}');
    await write('big.md', 'x'.repeat(2000));
    s3.objects.set('p/원격.md', { bytes: new TextEncoder().encode('원격뿐'), etag: md5(new TextEncoder().encode('원격뿐')) });
    const remoteOther = new TextEncoder().encode('다른 내용');
    s3.objects.set('p/같음.md', { bytes: remoteOther, etag: md5(remoteOther) });
    const before = s3.log.length;
    const p = await previewSync({ cfg, device: 'A', notesDir: dir }, { fetch: s3.fetch, stateDir, now: () => NOW, maxFileBytes: 1024 });
    expect(p.upload).toEqual({ count: 4, bytes: 3 + 2 + 1 + 5 });
    expect(p.download).toEqual({ count: 1, bytes: new TextEncoder().encode('원격뿐').length });
    expect(p.conflicts).toBe(1);
    expect(p.topFolders).toEqual([{ name: '첨부', count: 2 }, { name: 'daily', count: 1 }]);
    expect(p.skipped).toBe(1);
    expect(s3.log.slice(before).every((l) => l.startsWith('GET (list)'))).toBe(true);
    expect(await readdir(stateDir)).toEqual([]);
    expect(await files(dir)).not.toContain('원격.md');
  });

  it('앱 묶음 폴더 안으로는 들어가지 않아 올리지 않는다', async () => {
    const s3 = createFakeS3();
    const a = await device('A', s3);
    await put(a, '메모.md', '메모');
    await put(a, 'Tool.APP/Contents/Resources/a.json', '{}');
    await put(a, '__MACOSX/메모.md', 'x');
    await a.engine.sync();
    expect(s3.userKeys()).toEqual(['p/메모.md']);
  });
});

describe('클라우드 동기화 엔진: 건너뛴 파일 알리기', () => {
  const skippedOf = (d: Device) => {
    const st = lastStatus(d);
    return st?.type === 'status' ? st.status.skipped ?? [] : [];
  };

  it('대소문자만 다른 이름과 너무 큰 파일을 까닭과 함께 상태에 남긴다', async () => {
    const s3 = createFakeS3();
    const a = await device('A', s3);
    await put(a, '메모.md', '메모');
    await put(a, 'big.md', 'x'.repeat(2000));
    const bytes = new TextEncoder().encode('원격');
    s3.objects.set('p/메모.MD', { bytes, etag: md5(bytes) });
    await a.engine.sync();
    const skipped = skippedOf(a);
    expect(skipped).toContainEqual({ path: 'big.md', reason: expect.stringContaining('MB보다 큼') });
    expect(skipped.filter((f) => f.reason.startsWith('대소문자만 다른 이름이 있음')).map((f) => f.path).sort()).toEqual(['메모.MD', '메모.md']);
    expect(lastStatus(a)).toMatchObject({ status: { state: 'idle' } });
  });

  it('쓴 파일만 올릴 때는 지난 목록을 남기고, 다음 전체 맞춤에서 새로 채운다', async () => {
    const s3 = createFakeS3();
    const a = await device('A', s3);
    await put(a, 'big.md', 'x'.repeat(2000));
    await a.engine.sync();
    expect(skippedOf(a).map((f) => f.path)).toEqual(['big.md']);
    await put(a, 'a.md', '새 글');
    await a.engine.sync({ paths: [path.join(a.dir, 'a.md')] });
    expect(skippedOf(a).map((f) => f.path)).toEqual(['big.md']);
    await rm(path.join(a.dir, 'big.md'));
    await a.engine.sync();
    expect(skippedOf(a)).toEqual([]);
  });

  it('다른 기기가 계속 먼저 바꿔 다시 시도해도 맞추지 못하면 그 파일을 알린다', async () => {
    const s3 = createFakeS3();
    const a = await device('A', s3);
    await put(a, 'a.md', '로컬');
    let n = 0;
    s3.hooks.beforePut = (key) => {
      if (key !== 'p/a.md') return;
      const bytes = new TextEncoder().encode(`다른 기기 ${n++}`);
      s3.objects.set(key, { bytes, etag: md5(bytes) });
    };
    // 받으려 하면 그사이 사라진다. 올리려 하면 그사이 생긴다
    s3.hooks.beforeGet = async (key) => {
      s3.objects.delete(key);
    };
    await a.engine.sync();
    expect(skippedOf(a)).toContainEqual({ path: 'a.md', reason: '다시 시도해도 맞추지 못함' });
  });
});
