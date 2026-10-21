// 클라우드 동기화 IPC와 실행 시점(전체 맞춤은 앱 시작·창 포커스·5분마다·직접 요청, 저장과 종료 직전에는 쓴 파일만 올리기)을 메인 프로세스에 연결한다. 비밀 키는 화면에 보내지 않는다
import { app, BrowserWindow, ipcMain, net } from 'electron';
import { hostname } from 'node:os';
import path from 'node:path';
import { testConnection } from './cloud/check';
import { createSyncEngine, previewSync, type EngineTarget, type SyncEngine } from './cloud/engine';
import { parseCloudInput, readStorage, toClientConfig, type StorageSettings } from './cloud/settings';
import { CloudError, type CloudEvent, type CloudFailure, type CloudPreviewResult, type CloudResult, type CloudSettingsView, type CloudTestResult } from './cloud/types';
import { hasKey, KeyDecryptError, loadKey, saveKey } from './secrets';
import type { SerialQueue } from './serialQueue';

export interface CloudHostDeps {
  readConfig: () => Promise<{ notesDir?: string; storage?: unknown }>;
  patchConfig: (patch: { storage: { mode: 'local' | 'cloud'; cloud?: StorageSettings['cloud'] } }) => Promise<void>;
  /** 화면의 파일 쓰기가 도는 줄. 내려받은 파일을 갈아 끼우는 단계도 여기서 돌린다 */
  writeQueue: SerialQueue;
}

export interface CloudHost {
  start(): void;
  /** 화면이 파일을 쓴 뒤 부른다. 노트 폴더 안이면 모아 두었다가 3초 뒤 쓴 파일만 올린다 */
  noteWritten(filePath: string): void;
  /** 클라우드 모드였으면 새 폴더를 맞추지 않고 로컬로 바꾼다 */
  notesDirChanged(): Promise<void>;
}

const FOCUS_GAP_MS = 30_000;
const WRITE_DEBOUNCE_MS = 3_000;
const INTERVAL_MS = 5 * 60_000;
const QUIT_CAP_MS = 5_000;

const DEVICE = hostname().replace(/\.local$/, '') || '기기';

const netFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
  net.fetch(input instanceof URL ? input.toString() : input, init);

const fail = (kind: CloudFailure['kind'], message: string): CloudFailure => ({ ok: false, kind, message });

/** 저장된 비밀 키. 없으면 null, 풀지 못하면 CloudError('auth') */
async function storedSecret(): Promise<string | null> {
  try {
    return await loadKey('cloud');
  } catch (err) {
    if (err instanceof KeyDecryptError) {
      throw new CloudError('auth', '저장된 비밀 키를 풀지 못했습니다. 클라우드 설정에서 비밀 키를 다시 넣으세요');
    }
    throw err;
  }
}

function broadcast(ev: CloudEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.webContents.isDestroyed()) w.webContents.send('cloud:event', ev);
  }
}

const isInside = (dir: string, file: string): boolean => {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

export function registerCloudHandlers(deps: CloudHostDeps): CloudHost {
  let mode: 'local' | 'cloud' = 'local';
  let paused = false;
  let lastFocusRun = 0;
  let writeTimer: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let engineRef: SyncEngine | null = null;
  let quitHandled = false;
  // 저장할 때마다 전체를 맞추면 목록 요청이 쌓여 무료 요청 한도를 넘기 쉽다. 쓴 파일만 모아 올린다
  const writtenPaths = new Set<string>();

  const storage = async (): Promise<StorageSettings> => readStorage((await deps.readConfig()).storage, DEVICE);

  async function loadTarget(): Promise<EngineTarget | null> {
    const cfg = await deps.readConfig();
    const s = readStorage(cfg.storage, DEVICE);
    if (s.mode !== 'cloud' || !s.cloud || !cfg.notesDir) return null;
    const secret = await storedSecret();
    if (!secret) throw new CloudError('auth', '저장된 비밀 키가 없습니다. 클라우드 설정에서 비밀 키를 넣으세요');
    return { cfg: toClientConfig(s.cloud, secret), device: s.cloud.device, notesDir: cfg.notesDir };
  }

  const engine = (): SyncEngine => {
    engineRef ??= createSyncEngine({
      fetch: netFetch,
      stateDir: path.join(app.getPath('userData'), 'cloud'),
      load: loadTarget,
      writeQueue: deps.writeQueue,
      emit: (ev) => {
        // 인증·버킷 오류는 설정을 고칠 때까지 자동 실행을 멈춘다. 오프라인은 다음 시점에 다시 해 본다
        if (ev.type === 'status' && ev.status.state === 'error') paused = true;
        if (ev.type === 'status' && ev.status.state === 'idle') paused = false;
        broadcast(ev);
      },
    });
    return engineRef;
  };

  const autoAllowed = (): boolean => mode === 'cloud' && !paused;
  const runInBackground = (): void => {
    engine().sync().catch((err: unknown) => console.error('클라우드 동기화 실패', err instanceof Error ? err.message : 'unknown'));
  };
  const uploadWritten = (): Promise<void> => {
    const paths = [...writtenPaths];
    writtenPaths.clear();
    return paths.length > 0 ? engine().sync({ paths }) : Promise.resolve();
  };

  function startTimers(): void {
    if (interval) return;
    interval = setInterval(() => {
      if (autoAllowed()) runInBackground();
    }, INTERVAL_MS);
  }

  function stopTimers(): void {
    if (interval) clearInterval(interval);
    if (writeTimer) clearTimeout(writeTimer);
    interval = null;
    writeTimer = null;
  }

  async function view(): Promise<CloudSettingsView> {
    const s = await storage();
    return { mode: s.mode, cloud: s.cloud, hasSecret: await hasKey('cloud'), status: s.mode === 'cloud' ? engine().status() : { state: 'off' } };
  }

  async function secretFor(raw: unknown): Promise<string | null> {
    return typeof raw === 'string' && raw.trim() ? raw.trim() : storedSecret();
  }

  async function test(rawCfg: unknown, rawSecret: unknown): Promise<CloudTestResult> {
    const parsed = parseCloudInput(rawCfg, DEVICE);
    if (!parsed.ok) return fail('bad-request', parsed.message);
    try {
      const secret = await secretFor(rawSecret);
      if (!secret) return fail('auth', '비밀 키를 넣으세요');
      return await testConnection(toClientConfig(parsed.cfg, secret), netFetch);
    } catch (err) {
      if (err instanceof CloudError) return fail(err.kind, err.message);
      throw err;
    }
  }

  async function preview(rawCfg: unknown, rawSecret: unknown): Promise<CloudPreviewResult> {
    const parsed = parseCloudInput(rawCfg, DEVICE);
    if (!parsed.ok) return fail('bad-request', parsed.message);
    const notesDir = (await deps.readConfig()).notesDir;
    if (!notesDir) return fail('bad-request', '먼저 노트 폴더를 고르세요');
    try {
      const secret = await secretFor(rawSecret);
      if (!secret) return fail('auth', '비밀 키를 넣으세요');
      const target = { cfg: toClientConfig(parsed.cfg, secret), device: parsed.cfg.device, notesDir };
      return { ok: true, preview: await previewSync(target, { fetch: netFetch, stateDir: path.join(app.getPath('userData'), 'cloud') }) };
    } catch (err) {
      if (err instanceof CloudError) return fail(err.kind, err.message);
      throw err;
    }
  }

  async function enable(rawCfg: unknown, rawSecret: unknown): Promise<CloudResult> {
    const parsed = parseCloudInput(rawCfg, DEVICE);
    if (!parsed.ok) return fail('bad-request', parsed.message);
    if (!(await deps.readConfig()).notesDir) return fail('bad-request', '먼저 노트 폴더를 고르세요');
    const tested = await test(rawCfg, rawSecret);
    if (!tested.ok) return tested;
    if (typeof rawSecret === 'string' && rawSecret.trim() && !(await saveKey('cloud', rawSecret.trim()))) {
      return fail('bad-request', '이 컴퓨터에서 운영체제 암호화를 쓸 수 없어 비밀 키를 저장하지 않았습니다');
    }
    await deps.patchConfig({ storage: { mode: 'cloud', cloud: parsed.cfg } });
    const secret = await storedSecret();
    if (secret) engine().rememberConditionalWrites(toClientConfig(parsed.cfg, secret), tested.conditionalWrites);
    mode = 'cloud';
    paused = false;
    startTimers();
    runInBackground();
    return { ok: true };
  }

  async function disable(): Promise<void> {
    const s = await storage();
    await deps.patchConfig({ storage: { mode: 'local', cloud: s.cloud } });
    mode = 'local';
    stopTimers();
    writtenPaths.clear();
    engineRef?.stop();
    await engineRef?.flush();
  }

  ipcMain.handle('cloud:get-settings', () => view());
  ipcMain.handle('cloud:test', (_e, cfg: unknown, secret: unknown) => test(cfg, secret));
  ipcMain.handle('cloud:preview', (_e, cfg: unknown, secret: unknown) => preview(cfg, secret));
  ipcMain.handle('cloud:enable', (_e, cfg: unknown, secret: unknown) => enable(cfg, secret));
  ipcMain.handle('cloud:disable', () => disable());
  ipcMain.handle('cloud:sync-now', async () => {
    if (mode === 'cloud') await engine().sync();
  });

  app.on('browser-window-focus', () => {
    if (!autoAllowed() || Date.now() - lastFocusRun < FOCUS_GAP_MS) return;
    lastFocusRun = Date.now();
    runInBackground();
  });

  // 창을 다 닫은 뒤 끝나기 직전에 쓴 파일만 올린다. 5초를 넘기면 기다리지 않는다
  app.on('will-quit', (e) => {
    if (quitHandled || mode !== 'cloud' || !engineRef) return;
    quitHandled = true;
    e.preventDefault();
    stopTimers();
    const eng = engineRef;
    const cap = new Promise<void>((resolve) => setTimeout(resolve, QUIT_CAP_MS));
    void Promise.race([paused ? Promise.resolve() : uploadWritten(), cap])
      .then(async () => {
        eng.stop();
        await eng.flush();
      })
      .catch((err: unknown) => console.error('종료 전 클라우드 동기화 실패', err instanceof Error ? err.message : 'unknown'))
      .finally(() => app.quit());
  });

  return {
    start() {
      storage()
        .then((s) => {
          mode = s.mode;
          if (mode !== 'cloud') return;
          startTimers();
          runInBackground();
        })
        .catch((err: unknown) => console.error('클라우드 설정 읽기 실패', err instanceof Error ? err.message : 'unknown'));
    },
    noteWritten(filePath) {
      if (!autoAllowed()) return;
      void deps.readConfig().then((cfg) => {
        if (!cfg.notesDir || !isInside(cfg.notesDir, filePath)) return;
        writtenPaths.add(filePath);
        if (writeTimer) clearTimeout(writeTimer);
        writeTimer = setTimeout(() => {
          writeTimer = null;
          if (!autoAllowed()) return;
          uploadWritten().catch((err: unknown) => console.error('클라우드 올리기 실패', err instanceof Error ? err.message : 'unknown'));
        }, WRITE_DEBOUNCE_MS);
      }).catch((err: unknown) => console.error('클라우드 설정 읽기 실패', err instanceof Error ? err.message : 'unknown'));
    },
    async notesDirChanged() {
      if (mode === 'cloud') await disable();
    },
  };
}
