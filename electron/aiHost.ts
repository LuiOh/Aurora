// AI 채팅 IPC 핸들러 — 키 확인·모델 목록·설정·기록 폴더·스트리밍 요청 추적을 메인 프로세스에서 맡는다
import { app, ipcMain, net, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { AiError, DEFAULT_MODELS, listModels, streamChat, type ChatEvent, type Provider } from './ai';
import {
  createCoalescer, isProvider, KEY_UNDECRYPTABLE_MESSAGE, normalizeAiSettings, sortChatFiles, validateChatRequest,
  type AiChatRequest, type AiModelsResult, type AiSettings, type ChatFileInfo,
} from './aiShared';
import { toSlash } from './paths';
import { deleteKey, KeyDecryptError, keyStatus, loadKey, saveKey } from './secrets';

export interface AiHostDeps {
  readConfig: () => Promise<{ ai?: unknown; notesDir?: string }>;
  patchConfig: (patch: { ai: AiSettings }) => Promise<void>;
}

const NO_KEY_MESSAGE = 'API 키가 없습니다';
const NO_KEY: AiModelsResult = { ok: false, kind: 'auth', message: NO_KEY_MESSAGE };

/** 키를 꺼낸다. 없으면 NO_KEY 문구, 저장돼 있는데 풀지 못하면 키체인 안내 문구를 돌려준다 */
async function keyFor(provider: Provider): Promise<{ ok: true; key: string } | { ok: false; message: string }> {
  try {
    const key = await loadKey(provider);
    return key ? { ok: true, key } : { ok: false, message: NO_KEY_MESSAGE };
  } catch (err) {
    if (err instanceof KeyDecryptError) return { ok: false, message: KEY_UNDECRYPTABLE_MESSAGE };
    throw err;
  }
}

/** Electron net.fetch를 공급자 코드가 받는 fetch 모양으로 감싼다 */
const netFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
  net.fetch(input instanceof URL ? input.toString() : input, init);

const requests = new Map<string, { controller: AbortController; senderId: number }>();
const watchedSenders = new Set<number>();

const assertProvider = (p: unknown): Provider => {
  if (!isProvider(p)) throw new Error('알 수 없는 AI 공급자입니다');
  return p;
};

async function fetchModels(provider: Provider, apiKey: string): Promise<AiModelsResult> {
  try {
    return { ok: true, models: await listModels({ provider, apiKey, fetch: netFetch }) };
  } catch (err) {
    if (err instanceof AiError) return { ok: false, kind: err.kind, message: err.message };
    return { ok: false, kind: 'network', message: err instanceof Error ? err.message : '알 수 없는 오류' };
  }
}

/** 확인에 성공한 키만 저장한다 */
async function verifyAndSave(provider: Provider, rawKey: string): Promise<AiModelsResult> {
  const key = rawKey.trim();
  if (!key) return NO_KEY;
  const res = await fetchModels(provider, key);
  if (!res.ok) return res;
  if (!(await saveKey(provider, key))) {
    return { ok: false, kind: 'bad-request', message: '이 컴퓨터에서 운영체제 암호화를 쓸 수 없어 API 키를 저장하지 않았습니다' };
  }
  return res;
}

/** 기록 폴더 — 설정값, 노트 폴더 안 .aurora/chats, userData/chats 순으로 고른다 */
export function resolveHistoryDir(historyDir: string | null, notesDir: string | undefined, userData: string): string {
  if (historyDir) return toSlash(historyDir);
  if (notesDir) return toSlash(path.join(notesDir, '.aurora', 'chats'));
  return toSlash(path.join(userData, 'chats'));
}

async function listChats(dir: string): Promise<ChatFileInfo[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return []; // 폴더가 아직 없다
  }
  const entries = await Promise.all(names.map(async (name) => {
    try {
      const st = await stat(path.join(dir, name));
      return { name, isFile: st.isFile(), mtime: st.mtimeMs };
    } catch {
      return { name, isFile: false, mtime: 0 }; // 읽는 사이 지워진 파일은 건너뛴다
    }
  }));
  return sortChatFiles(dir, entries);
}

const abortWhere = (pred: (senderId: number) => boolean) => {
  for (const r of requests.values()) if (pred(r.senderId)) r.controller.abort();
};

function watchSender(sender: WebContents) {
  if (watchedSenders.has(sender.id)) return;
  watchedSenders.add(sender.id);
  const id = sender.id;
  const abortMine = () => abortWhere((s) => s === id);
  sender.once('destroyed', () => {
    watchedSenders.delete(id);
    abortMine();
  });
  // 새로고침·크래시 복구는 같은 WebContents를 다시 쓰므로 이때도 이전 화면의 요청을 끊는다
  sender.on('render-process-gone', abortMine);
  sender.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) abortMine();
  });
}

async function runChat(id: string, req: AiChatRequest, sender: WebContents, controller: AbortController) {
  const send = (ev: ChatEvent) => {
    if (!sender.isDestroyed()) sender.send('ai:event', id, ev);
  };
  const co = createCoalescer(send);
  try {
    const key = await keyFor(req.provider);
    if (!key.ok) {
      send({ type: 'error', kind: 'auth', message: key.message });
      return;
    }
    const stream = streamChat({
      provider: req.provider, model: req.model || DEFAULT_MODELS[req.provider], apiKey: key.key, system: req.system,
      turns: req.turns, webSearch: req.webSearch, signal: controller.signal, fetch: netFetch,
    });
    for await (const ev of stream) co.push(ev);
    co.flush();
  } finally {
    controller.abort(); // 어댑터가 도중에 던졌으면 서버 쪽 생성도 멈춘다. 이미 끝났으면 아무 일도 없다
    co.dispose();
    requests.delete(id);
  }
}

function startChat(e: IpcMainInvokeEvent, raw: unknown): string {
  const req = validateChatRequest(raw);
  const id = randomUUID();
  const controller = new AbortController();
  requests.set(id, { controller, senderId: e.sender.id });
  watchSender(e.sender);
  const sender = e.sender;
  runChat(id, req, sender, controller).catch((err: unknown) => {
    console.error('AI 채팅 처리 실패', err instanceof Error ? err.message : 'unknown');
    if (!sender.isDestroyed()) {
      sender.send('ai:event', id, { type: 'error', kind: 'server', message: 'AI 요청을 처리하지 못했습니다' } satisfies ChatEvent);
    }
  });
  return id;
}

/** AI 관련 IPC 채널을 모두 등록한다. main.ts에서 한 번 부른다 */
export function registerAiHandlers(deps: AiHostDeps): void {
  const getSettings = async () => normalizeAiSettings((await deps.readConfig()).ai);
  ipcMain.handle('ai:key-status', () => keyStatus());
  ipcMain.handle('ai:save-key', (_e, p: unknown, key: unknown) => verifyAndSave(assertProvider(p), typeof key === 'string' ? key : ''));
  ipcMain.handle('ai:delete-key', (_e, p: unknown) => deleteKey(assertProvider(p)));
  ipcMain.handle('ai:models', async (_e, p: unknown) => {
    const provider = assertProvider(p);
    const key = await keyFor(provider);
    return key.ok ? fetchModels(provider, key.key) : { ok: false, kind: 'auth', message: key.message } satisfies AiModelsResult;
  });
  ipcMain.handle('ai:settings-get', getSettings);
  ipcMain.handle('ai:settings-set', (_e, s: unknown) => deps.patchConfig({ ai: normalizeAiSettings(s) }));
  ipcMain.handle('ai:history-dir', async () => {
    const cfg = await deps.readConfig();
    return resolveHistoryDir(normalizeAiSettings(cfg.ai).historyDir, cfg.notesDir, app.getPath('userData'));
  });
  ipcMain.handle('ai:list-chats', (_e, dir: unknown) => (typeof dir === 'string' && dir ? listChats(dir) : []));
  ipcMain.handle('ai:chat', (e, req: unknown) => startChat(e, req));
  ipcMain.handle('ai:abort', (_e, id: unknown) => {
    if (typeof id === 'string') requests.get(id)?.controller.abort();
  });
  // ⌘Q는 저장 안 한 변경 확인에서 취소될 수 있으므로 정말 끝날 때만 요청을 끊는다
  app.on('will-quit', () => abortWhere(() => true));
}
