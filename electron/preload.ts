// 렌더러에 파일·클립보드·메뉴 기능만 좁게 열어 주는 preload 스크립트
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { ChatEvent, Provider } from './ai/types';
import type { AiChatRequest, AiKeyStatus, AiModelsResult, AiSettings, ChatFileInfo } from './aiShared';
import type {
  CloudEvent, CloudPreviewResult, CloudResult, CloudSettingsInput, CloudSettingsView, CloudTestResult,
} from './cloud/types';
import type { WriteResult } from './contentHash';
import type { KeyInput } from './keybindings';
import { fileUrl, toSlash } from './paths';

const api = {
  /** process.platform 값. 화면이 플랫폼별 제목 막대 배치를 고르는 데 쓴다 */
  platform: process.platform as string,
  getAccentColor: (): Promise<string | null> => ipcRenderer.invoke('theme:accent'),
  // 메인이 돌려주는 경로는 모두 / 구분자로 바꿔서 넘긴다 (윈도우 대응)
  openFiles: async (multi = true): Promise<{ path: string; content: string }[]> =>
    ((await ipcRenderer.invoke('file:open-dialog', multi)) as { path: string; content: string }[]).map((f) => ({
      ...f,
      path: toSlash(f.path),
    })),
  readFile: (path: string): Promise<string> => ipcRenderer.invoke('file:read', path),
  /** expectedHash를 주면 디스크 내용이 그 해시와 다를 때 쓰지 않고 { ok: false, conflict: true }를 돌려준다 */
  writeFile: (path: string, content: string, expectedHash?: string): Promise<WriteResult> =>
    ipcRenderer.invoke('file:write', path, content, expectedHash),
  /** 파일이 없을 때만 만든다. 만들었으면 true, 이미 있으면 덮지 않고 false */
  createFile: (path: string, content: string): Promise<boolean> => ipcRenderer.invoke('file:create', path, content),
  writeBinary: (path: string, data: Uint8Array): Promise<void> => ipcRenderer.invoke('file:write-binary', path, data),
  /** 끌어다 놓은 파일을 복사한다. from이 없으면(웹) false를 돌려주고 바이트를 쓰게 한다 */
  copyFile: async (from: string, to: string): Promise<boolean> => {
    await ipcRenderer.invoke('file:copy', from, to);
    return true;
  },
  exists: (path: string): Promise<boolean> => ipcRenderer.invoke('file:exists', path),
  /** 미리보기의 img·video가 쓸 주소 */
  mediaUrl: async (path: string): Promise<string> => fileUrl(path),
  openPath: async (path: string): Promise<void> => {
    await ipcRenderer.invoke('shell:open-path', path);
  },
  saveDialog: async (defaultName: string): Promise<string | null> => {
    const p: string | null = await ipcRenderer.invoke('file:save-dialog', defaultName);
    return p && toSlash(p);
  },
  confirmDiscard: (message: string): Promise<boolean> => ipcRenderer.invoke('dialog:confirm-discard', message),
  readClipboard: (): Promise<string> => ipcRenderer.invoke('clipboard:read'),
  getNotesDir: async (): Promise<string | null> => {
    const p: string | null = await ipcRenderer.invoke('notes:get-dir');
    return p && toSlash(p);
  },
  chooseNotesDir: async (): Promise<string | null> => {
    const p: string | null = await ipcRenderer.invoke('notes:choose-dir');
    return p && toSlash(p);
  },
  chooseFolder: async (defaultPath: string): Promise<string | null> => {
    const p: string | null = await ipcRenderer.invoke('dialog:choose-folder', defaultPath);
    return p && toSlash(p);
  },
  listNotes: (notesDir: string, folder: string): Promise<string[]> => ipcRenderer.invoke('notes:list', notesDir, folder),
  /** 노트 폴더의 모든 .md 파일. path는 노트 폴더 기준 상대 경로 */
  scanVault: (notesDir: string): Promise<{ path: string; mtime: number; content: string }[]> =>
    ipcRenderer.invoke('vault:scan', notesDir),
  // 끌어다 놓은 File 객체의 실제 경로를 얻는다 (Electron 32부터 File.path가 없어짐)
  pathForFile: (file: File): string => toSlash(webUtils.getPathForFile(file)),
  /** 앱 메뉴를 마우스 위치에 띄운다. 메뉴 막대가 없는 윈도우에서 쓴다 */
  popupMenu: (x: number, y: number) => ipcRenderer.send('menu:popup', x, y),
  onMenu: (handler: (command: string) => void) => {
    ipcRenderer.on('menu', (_e, command: string) => handler(command));
  },
  /** 파인더 "다음으로 열기"나 탐색기 "연결 프로그램"으로 받은 파일 경로 */
  onOpenPath: (handler: (path: string) => void) => {
    ipcRenderer.on('file:open-path', (_e, p: string) => handler(toSlash(p)));
  },
  approveClose: () => ipcRenderer.send('app:close-approved'),
  getKeyOverrides: (): Promise<Record<string, string>> => ipcRenderer.invoke('keys:get'),
  setKeyOverrides: (overrides: Record<string, string>): Promise<void> => ipcRenderer.invoke('keys:set', overrides),
  /** on이면 메뉴 단축키를 멈추고 누른 키를 onKeyPressed로 받는다 */
  recordKeys: (on: boolean) => ipcRenderer.send('keys:record', on),
  onKeyPressed: (handler: (input: KeyInput) => void) => {
    ipcRenderer.on('keys:pressed', (_e, input: KeyInput) => handler(input));
  },
  // AI 채팅. 키 값은 메인 프로세스에만 있고 화면에는 저장 여부만 알려 준다
  aiAvailable: true as boolean,
  aiKeyStatus: (): Promise<AiKeyStatus> => ipcRenderer.invoke('ai:key-status'),
  /** 키로 모델 목록을 먼저 받아 보고, 성공했을 때만 저장한다 */
  aiSaveKey: (provider: Provider, key: string): Promise<AiModelsResult> => ipcRenderer.invoke('ai:save-key', provider, key),
  aiDeleteKey: (provider: Provider): Promise<void> => ipcRenderer.invoke('ai:delete-key', provider),
  aiListModels: (provider: Provider): Promise<AiModelsResult> => ipcRenderer.invoke('ai:models', provider),
  getAiSettings: (): Promise<AiSettings> => ipcRenderer.invoke('ai:settings-get'),
  setAiSettings: (s: AiSettings): Promise<void> => ipcRenderer.invoke('ai:settings-set', s),
  aiHistoryDir: (): Promise<string> => ipcRenderer.invoke('ai:history-dir'),
  aiListChats: (dir: string): Promise<ChatFileInfo[]> => ipcRenderer.invoke('ai:list-chats', dir),
  /** 요청 id를 바로 돌려준다. 내용은 onAiEvent로 온다 */
  aiChat: (req: AiChatRequest): Promise<string> => ipcRenderer.invoke('ai:chat', req),
  aiAbort: (id: string): Promise<void> => ipcRenderer.invoke('ai:abort', id),
  /** 구독을 끊는 함수를 돌려준다 */
  onAiEvent: (cb: (id: string, ev: ChatEvent) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, id: string, ev: ChatEvent) => cb(id, ev);
    ipcRenderer.on('ai:event', listener);
    return () => {
      ipcRenderer.removeListener('ai:event', listener);
    };
  },
  // 클라우드 저장소. 비밀 키는 메인 프로세스에만 있고 화면에는 저장 여부만 알려 준다
  cloudAvailable: true as boolean,
  getCloudSettings: (): Promise<CloudSettingsView> => ipcRenderer.invoke('cloud:get-settings'),
  /** secret을 빼면 저장된 비밀 키로 확인한다 */
  testCloud: (cfg: CloudSettingsInput, secret?: string): Promise<CloudTestResult> => ipcRenderer.invoke('cloud:test', cfg, secret),
  /** 아무것도 옮기지 않고 첫 동기화에서 올릴·받을 파일 수와 크기를 센다 */
  previewCloud: (cfg: CloudSettingsInput, secret?: string): Promise<CloudPreviewResult> => ipcRenderer.invoke('cloud:preview', cfg, secret),
  /** 확인에 성공하면 설정을 저장하고 클라우드 모드로 바꾼 뒤 첫 동기화를 시작한다. 진행은 onCloudEvent로 온다 */
  enableCloud: (cfg: CloudSettingsInput, secret?: string): Promise<CloudResult> => ipcRenderer.invoke('cloud:enable', cfg, secret),
  disableCloud: (): Promise<void> => ipcRenderer.invoke('cloud:disable'),
  syncNow: (): Promise<void> => ipcRenderer.invoke('cloud:sync-now'),
  onCloudEvent: (cb: (ev: CloudEvent) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: CloudEvent) => cb(ev);
    ipcRenderer.on('cloud:event', listener);
    return () => {
      ipcRenderer.removeListener('cloud:event', listener);
    };
  },
};

export type AuroraApi = typeof api;

contextBridge.exposeInMainWorld('aurora', api);
