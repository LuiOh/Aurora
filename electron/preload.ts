// 렌더러에 파일·클립보드·메뉴 기능만 좁게 열어 주는 preload 스크립트
import { contextBridge, ipcRenderer, webUtils } from 'electron';
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
  writeFile: (path: string, content: string): Promise<void> => ipcRenderer.invoke('file:write', path, content),
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
};

export type AuroraApi = typeof api;

contextBridge.exposeInMainWorld('aurora', api);
