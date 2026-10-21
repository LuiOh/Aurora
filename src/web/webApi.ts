// 브라우저에서 데스크톱 preload API와 같은 모양으로 파일·설정·메뉴·단축키를 제공하는 웹 버전 구현
import type { AuroraApi } from '../../electron/preload';
import { commandForInput, resolveBindings, type KeyInput } from '../../electron/keybindings';
import { defaultAiSettings } from '../../electron/aiShared';
import { contentHash } from '../../electron/contentHash';
import { listDaily, readBlob, readText, scanMarkdown, writeText, type DirHandleLike } from './vaultFs';
import { openWebMenu } from '../ui/webMenu';
import { IS_MAC } from '../platform';

/*
 * 경로 규칙. 화면 코드는 데스크톱과 같이 / 경로 문자열만 다룬다.
 * - 노트 폴더 안 파일은 "/폴더이름/상대경로"
 * - 따로 연 파일은 "/~open/번호/파일이름" (핸들이 있으면 덮어쓰기 가능, 없으면 읽기만)
 * - 폴더 접근 기능이 없는 브라우저에서 다른 이름으로 저장하면 "/~download/파일이름" (쓰면 내려받기)
 */

// 브라우저 폴더 접근 기능의 실제 타입 (TypeScript 기본 DOM 타입에 아직 없는 부분)
interface FsWindow {
  showDirectoryPicker?: (opts?: { mode?: 'readwrite'; id?: string }) => Promise<DirHandleLike>;
  showOpenFilePicker?: (opts?: { multiple?: boolean }) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (opts?: { suggestedName?: string }) => Promise<FileSystemFileHandle>;
}
type PermHandle = { queryPermission(o: { mode: string }): Promise<string>; requestPermission(o: { mode: string }): Promise<string> };

const fsWin = window as unknown as FsWindow;
export const canUseFolders = typeof fsWin.showDirectoryPicker === 'function';

// ───────── IndexedDB (노트 폴더 핸들은 localStorage에 넣을 수 없어 여기 둔다) ─────────

function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  return new Promise((resolve) => {
    // 저장소 이름은 예전 이름(quire) 그대로 둔다. 바꾸면 브라우저에 저장된 노트 폴더 권한과 단축키를 잃는다
    const open = indexedDB.open('quire', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => resolve(undefined);
    open.onsuccess = () => {
      const req = fn(open.result.transaction('kv', mode).objectStore('kv'));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => resolve(undefined);
    };
  });
}

function readJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '') as T;
  } catch {
    return fallback;
  }
}

/** 파일 선택 창 없이 <input type=file>로 파일을 고른다 (폴더 접근 기능이 없는 브라우저) */
function pickWithInput(multi: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multi;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

function download(name: string, content: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function createWebApi(): AuroraApi {
  let root: DirHandleLike | null = null;
  let nextId = 1;
  // 따로 연 파일: 경로 → 쓸 수 있는 핸들 또는 읽기 전용 File
  const opened = new Map<string, { handle?: FileSystemFileHandle; file?: File }>();
  let overrides: Record<string, string> = readJson('quire.keybindings', {});
  let bindings = resolveBindings(overrides);
  const menuHandlers: ((command: string) => void)[] = [];
  const keyHandlers: ((input: KeyInput) => void)[] = [];
  let recording = false;

  const rootPath = () => (root ? `/${root.name}` : null);
  /** 노트 폴더 안 경로면 상대 경로, 아니면 null */
  const inRoot = (p: string) => {
    const base = rootPath();
    return base && p.startsWith(`${base}/`) ? p.slice(base.length + 1) : null;
  };
  const register = (name: string, entry: { handle?: FileSystemFileHandle; file?: File }) => {
    const p = `/~open/${nextId++}/${name}`;
    opened.set(p, entry);
    return p;
  };

  /** 저장해 둔 노트 폴더 핸들을 되살린다. 권한을 다시 물어야 하면 사용자 동작(키·클릭) 안에서만 된다 */
  async function restoreRoot(): Promise<DirHandleLike | null> {
    if (root) return root;
    const saved = await idb<DirHandleLike>('readonly', (s) => s.get('notesDir'));
    if (!saved) return null;
    const perm = saved as unknown as PermHandle;
    try {
      if ((await perm.queryPermission({ mode: 'readwrite' })) === 'granted' || (await perm.requestPermission({ mode: 'readwrite' })) === 'granted') {
        root = saved;
      }
    } catch {
      // 사용자 동작 밖에서 권한을 물으면 실패한다. 다음에 다시 시도한다
    }
    return root;
  }

  // 브라우저에는 앱 메뉴가 없으므로 단축키를 여기서 직접 명령으로 바꾼다
  window.addEventListener(
    'keydown',
    (e) => {
      const input: KeyInput = { code: e.code, meta: e.metaKey, control: e.ctrlKey, alt: e.altKey, shift: e.shiftKey };
      if (recording) {
        e.preventDefault();
        e.stopPropagation();
        keyHandlers.forEach((h) => h(input));
        return;
      }
      if (e.isComposing) return;
      const command = commandForInput(bindings, input, IS_MAC);
      if (!command) return;
      e.preventDefault();
      e.stopPropagation();
      menuHandlers.forEach((h) => h(command));
    },
    true,
  );

  return {
    platform: 'web',
    getAccentColor: async () => null,

    openFiles: async (multi = true) => {
      if (fsWin.showOpenFilePicker) {
        let handles: FileSystemFileHandle[];
        try {
          handles = await fsWin.showOpenFilePicker({ multiple: multi });
        } catch {
          return [];
        }
        return Promise.all(
          handles.map(async (h) => ({ path: register(h.name, { handle: h }), content: await (await h.getFile()).text() })),
        );
      }
      const files = await pickWithInput(multi);
      return Promise.all(files.map(async (f) => ({ path: register(f.name, { file: f }), content: await f.text() })));
    },

    readFile: async (p) => {
      const rel = inRoot(p);
      if (rel && root) return readText(root, rel);
      const entry = opened.get(p);
      if (entry?.handle) return (await entry.handle.getFile()).text();
      if (entry?.file) return entry.file.text();
      throw new Error(`열 수 없는 파일입니다: ${p}`);
    },

    // expectedHash 비교는 읽은 뒤 쓰는 최선의 확인이다. 웹에는 클라우드 동기화가 없어 끼어드는 쓰기가 드물다
    writeFile: async (p, content, expectedHash) => {
      const rel = inRoot(p);
      if (rel && root) {
        if (expectedHash !== undefined) {
          const current = await readText(root, rel).catch(() => null);
          if (current !== null && contentHash(current) !== expectedHash) return { ok: false, conflict: true };
        }
        await writeText(root, rel, content);
        return { ok: true };
      }
      if (p.startsWith('/~download/')) {
        await download(p.slice('/~download/'.length), content);
        return { ok: true };
      }
      const handle = opened.get(p)?.handle;
      if (!handle) throw new Error('웹에서는 이 파일을 덮어쓸 수 없습니다. 다른 이름으로 저장을 쓰세요.');
      const w = await handle.createWritable();
      await w.write(content);
      await w.close();
      return { ok: true };
    },

    // 웹은 "없을 때만 만들기"가 없어 있는지 먼저 본 뒤 쓴다 (그 사이에 생기는 경우까지는 막지 못한다)
    createFile: async (p, content) => {
      const rel = inRoot(p);
      if (!rel || !root) throw new Error('웹에서는 노트 폴더 안에만 새 파일을 만들 수 있습니다.');
      if (await readBlob(root, rel).then(() => true, () => false)) return false;
      await writeText(root, rel, content);
      return true;
    },

    // 첨부는 노트 폴더 안에만 쓸 수 있다. 브라우저는 끌어다 놓은 파일의 경로를 모르므로 복사 대신 바이트를 쓴다
    writeBinary: async (p, data) => {
      const rel = inRoot(p);
      if (!rel || !root) throw new Error('웹에서는 노트 폴더 안의 노트에만 첨부할 수 있습니다.');
      await writeText(root, rel, data as Uint8Array<ArrayBuffer>);
    },
    copyFile: async () => false,
    exists: async (p) => {
      const rel = inRoot(p);
      if (!rel || !root) return false;
      try {
        await readBlob(root, rel);
        return true;
      } catch {
        return false;
      }
    },
    mediaUrl: async (p) => {
      const rel = inRoot(p);
      if (!rel || !root) throw new Error(`노트 폴더 밖의 파일은 웹에서 보여 줄 수 없습니다: ${p}`);
      return URL.createObjectURL(await readBlob(root, rel));
    },
    openPath: async (p) => {
      const rel = inRoot(p);
      if (rel && root) window.open(URL.createObjectURL(await readBlob(root, rel)), '_blank', 'noopener');
    },

    saveDialog: async (defaultName) => {
      const name = defaultName.split('/').pop() || '제목 없음.txt';
      if (fsWin.showSaveFilePicker) {
        try {
          const h = await fsWin.showSaveFilePicker({ suggestedName: name });
          return register(h.name, { handle: h });
        } catch {
          return null;
        }
      }
      const typed = window.prompt('내려받을 파일 이름', name);
      return typed ? `/~download/${typed}` : null;
    },

    confirmDiscard: async (message) => window.confirm(message),
    readClipboard: async () => {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return '';
      }
    },

    getNotesDir: async () => ((await restoreRoot()) ? rootPath() : null),
    // 브라우저는 고른 폴더의 전체 경로를 알려 주지 않으므로 저장 위치는 직접 입력한다
    chooseFolder: async () => null,
    chooseNotesDir: async () => {
      if (!fsWin.showDirectoryPicker) {
        window.alert('노트 폴더 기능은 크롬과 엣지에서만 쓸 수 있습니다. 이 브라우저에서는 파일을 하나씩 열고 내려받아 저장합니다.');
        return null;
      }
      try {
        root = await fsWin.showDirectoryPicker({ mode: 'readwrite', id: 'quire-notes' });
      } catch {
        return null;
      }
      await idb('readwrite', (s) => s.put(root, 'notesDir'));
      return rootPath();
    },
    listNotes: async (_dir, folder) => (root ? listDaily(root, folder) : []),
    scanVault: async () => (root ? scanMarkdown(root) : []),

    // 끌어다 놓은 파일은 원래 위치를 알 수 없으므로 읽기 전용으로 연다
    pathForFile: (file) => register(file.name, { file }),
    popupMenu: (x, y) => openWebMenu(x, y, bindings, IS_MAC, (id) => menuHandlers.forEach((h) => h(id))),
    onMenu: (handler) => {
      menuHandlers.push(handler);
    },
    // 브라우저 탭 닫기 확인은 화면 코드의 beforeunload가 맡는다
    approveClose: () => {},

    getKeyOverrides: async () => overrides,
    setKeyOverrides: async (next) => {
      overrides = next;
      bindings = resolveBindings(next);
      localStorage.setItem('quire.keybindings', JSON.stringify(next));
    },
    recordKeys: (on) => {
      recording = on;
    },
    onKeyPressed: (handler) => {
      keyHandlers.push(handler);
    },
    // 브라우저에는 운영체제가 파일을 넘겨주는 길이 없다
    onOpenPath: () => {},
    // 웹 버전은 키를 안전하게 둘 곳이 없어 AI 채팅을 끈다
    aiAvailable: false,
    aiKeyStatus: async () => ({ storage: 'unavailable', keys: { openai: false, anthropic: false, gemini: false } }),
    aiSaveKey: async () => WEB_AI_OFF,
    aiDeleteKey: async () => {},
    aiListModels: async () => WEB_AI_OFF,
    getAiSettings: async () => defaultAiSettings(),
    setAiSettings: async () => {},
    aiHistoryDir: async () => '',
    aiListChats: async () => [],
    aiChat: async () => {
      throw new Error(WEB_AI_OFF.message);
    },
    aiAbort: async () => {},
    onAiEvent: () => () => {},
    // 웹 버전은 비밀 키를 안전하게 둘 곳이 없어 클라우드 저장소를 끈다
    cloudAvailable: false,
    getCloudSettings: async () => ({ mode: 'local', cloud: null, hasSecret: false, status: { state: 'off' } }),
    testCloud: async () => WEB_CLOUD_OFF,
    previewCloud: async () => WEB_CLOUD_OFF,
    enableCloud: async () => WEB_CLOUD_OFF,
    disableCloud: async () => {},
    syncNow: async () => {},
    onCloudEvent: () => () => {},
  };
}

const WEB_CLOUD_OFF = { ok: false, kind: 'bad-request', message: '웹 버전에서는 클라우드 저장소를 쓸 수 없습니다' } as const;
const WEB_AI_OFF = { ok: false, kind: 'bad-request', message: '웹 버전에서는 AI 채팅을 쓸 수 없습니다' } as const;
