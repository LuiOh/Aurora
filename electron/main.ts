// Electron 메인 프로세스. 창 생성, 네이티브 메뉴, 파일·클립보드 IPC를 담당한다
import {
  app, BrowserWindow, Menu, dialog, ipcMain, clipboard, nativeTheme, shell, systemPreferences, type MenuItemConstructorOptions,
} from 'electron';
import { readFile, writeFile, mkdir, readdir, stat, copyFile, rename } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { registerAiHandlers } from './aiHost';
import { registerCloudHandlers } from './cloudHost';
import { COMMANDS, commandForInput, resolveBindings, type KeyOverrides } from './keybindings';
import { isSkippedEntry, isTextPath, shouldKeepContent, shouldReadFile } from './fileTypes';
import { createSerialQueue } from './serialQueue';
import { createExclusive, writeTextChecked } from './fileWrites';

// 노트 폴더 같은 앱 설정을 저장하는 파일
const configPath = () => path.join(app.getPath('userData'), 'config.json');

// 앱 이름이 Quire나 TextBench였을 때 쓰던 설정을 처음 한 번 옮겨 온다. 최근 이름부터 찾는다
async function migrateOldConfig() {
  try {
    await stat(configPath());
    return;
  } catch {
    // 새 설정이 없을 때만 옮긴다
  }
  for (const oldName of ['Quire', 'TextBench']) {
    try {
      const old = await readFile(path.join(app.getPath('appData'), oldName, 'config.json'), 'utf8');
      await mkdir(path.dirname(configPath()), { recursive: true });
      await writeFile(configPath(), old);
      return;
    } catch {
      // 이 이름의 설정이 없으면 다음 이름을 본다
    }
  }
}

type AppConfig = { notesDir?: string; keybindings?: KeyOverrides; ai?: unknown; storage?: unknown };

async function readConfig(): Promise<AppConfig> {
  try {
    return JSON.parse(await readFile(configPath(), 'utf8'));
  } catch {
    return {};
  }
}

const configWrites = createSerialQueue();

/** 설정 파일을 읽고 합쳐 임시 파일에 쓴 뒤 이름을 바꾼다. 겹쳐 쓰다 값을 잃지 않게 한 줄로 세운다 */
function patchConfig(patch: Partial<AppConfig>): Promise<void> {
  return configWrites.run(async () => {
    const next = JSON.stringify({ ...(await readConfig()), ...patch }, null, 2);
    const tmp = path.join(path.dirname(configPath()), `config.${randomUUID()}.tmp`);
    await writeFile(tmp, next);
    await rename(tmp, configPath());
  });
}

// 화면의 파일 쓰기와 클라우드에서 받은 파일 갈아 끼우기를 한 줄로 세워, 저장과 내려받기가 서로 덮지 않게 한다
const fileWrites = createSerialQueue();

registerAiHandlers({ readConfig, patchConfig });
const cloud = registerCloudHandlers({ readConfig, patchConfig, writeQueue: fileWrites });

let win: BrowserWindow | null = null;
// 단축키 설정 창에서 키를 기다리는 중이면 true. 이때는 메뉴 단축키 대신 렌더러로 키를 넘긴다
let recordingKeys = false;
// 렌더러가 저장 안 된 탭을 확인한 뒤 닫기를 허락하면 true가 된다
let allowClose = false;

function send(command: string) {
  win?.webContents.send('menu', command);
}

// 윈도우의 최소화·최대화·닫기 버튼 영역 색을 화면 테마에 맞춘다
const titleBarOverlay = () => ({
  color: nativeTheme.shouldUseDarkColors ? '#2a2a2c' : '#f3f3f3',
  symbolColor: nativeTheme.shouldUseDarkColors ? '#e5e5e7' : '#1d1d1f',
  height: 38,
});

/** 플랫폼마다 제목 막대를 탭 막대와 합친다. 맥은 신호등 버튼과 반투명 사이드바, 윈도우는 오른쪽 창 버튼을 쓴다 */
function chromeOptions(): Electron.BrowserWindowConstructorOptions {
  if (process.platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 12 },
      vibrancy: 'sidebar',
      visualEffectState: 'active',
      backgroundColor: '#00000000',
    };
  }
  if (process.platform === 'win32') return { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay() };
  return {};
}

// 파인더 "다음으로 열기"·탐색기 "연결 프로그램"으로 받은 파일. 화면이 준비되기 전에 온 것은 모아 두었다 보낸다
const pendingPaths: string[] = [];
let rendererReady = false;

function openPaths(paths: string[]) {
  pendingPaths.push(...paths);
  if (!win) {
    // 맥은 창을 다 닫아도 앱이 남아 있으므로 창부터 다시 연다
    if (app.isReady() && pendingPaths.length) createWindow();
    return;
  }
  if (!rendererReady || pendingPaths.length === 0) return;
  for (const p of pendingPaths.splice(0)) win.webContents.send('file:open-path', p);
  if (win.isMinimized()) win.restore();
  win.focus();
}

// 윈도우는 열 파일이 실행 인자로 온다. 옵션과 폴더(개발 실행의 .)는 건너뛴다
function filesFromArgv(argv: string[]): string[] {
  return argv.slice(1).filter((a) => {
    if (a.startsWith('-')) return false;
    try {
      return statSync(a).isFile();
    } catch {
      return false;
    }
  });
}

// 맥은 파일을 open-file 이벤트로 넘긴다. 앱이 켜지기 전에도 오므로 맨 위에서 받는다
app.on('open-file', (e, p) => {
  e.preventDefault();
  openPaths([p]);
});

// 윈도우에서 앱이 켜져 있을 때 파일을 열면 새 앱 대신 지금 창으로 넘긴다
if (process.platform !== 'darwin') {
  if (!app.requestSingleInstanceLock()) app.exit(0);
  app.on('second-instance', (_e, argv) => openPaths(filesFromArgv(argv)));
}

function createWindow() {
  rendererReady = false;
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Aurora',
    ...chromeOptions(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(path.join(__dirname, '../dist/index.html'));

  // 미리보기의 웹 링크는 앱 창 대신 기본 브라우저로 연다
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) e.preventDefault();
  });

  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const key = { code: input.code, meta: input.meta, control: input.control, alt: input.alt, shift: input.shift };
    if (recordingKeys) {
      e.preventDefault();
      win?.webContents.send('keys:pressed', key);
      return;
    }
    // 편집기(Monaco)가 ⌘B를 굵게 하기로 먼저 써 버리면 메뉴 단축키가 불리지 않는다.
    // 그래서 메뉴보다 앞에서 명령을 골라 보내고, 메뉴 단축키는 막아 두 번 불리지 않게 한다
    const command = commandForInput(currentBindings, key, process.platform === 'darwin');
    if (!command) return;
    e.preventDefault();
    send(command);
  });

  win.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    send('app:request-close');
  });
  win.webContents.on('did-finish-load', () => {
    rendererReady = true;
    openPaths([]);
  });
  win.on('closed', () => {
    win = null;
    allowClose = false;
  });
}

// 지금 쓰는 단축키. 메뉴를 다시 만들 때마다 바뀐다
let currentBindings: Record<string, string> = resolveBindings({});

function buildMenu(bindings: Record<string, string>) {
  currentBindings = bindings;
  const labels = Object.fromEntries(COMMANDS.map((c) => [c.id, c.label]));
  const item = (command: string): MenuItemConstructorOptions => ({
    label: labels[command],
    accelerator: bindings[command] || undefined,
    click: () => send(command),
  });
  const sep: MenuItemConstructorOptions = { type: 'separator' };
  const isMac = process.platform === 'darwin';
  // 맥만 앱 이름 메뉴를 둔다. 윈도우·리눅스는 단축키 설정과 끝내기를 File 메뉴 아래에 둔다
  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: app.name,
          submenu: [
            { role: 'about' },
            sep,
            item('app:keybindings'),
            sep,
            { role: 'services' },
            sep,
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            sep,
            { role: 'quit' },
          ],
        },
      ]
    : [];
  const fileTail: MenuItemConstructorOptions[] = isMac ? [] : [sep, item('app:keybindings'), sep, { role: 'quit', label: '끝내기' }];
  const template: MenuItemConstructorOptions[] = [
    ...appMenu,
    {
      label: 'File',
      submenu: [
        item('file:new'), item('file:open'), sep, item('file:save'), item('file:save-as'), sep, item('file:close-tab'), ...fileTail,
      ],
    },
    {
      label: 'Edit',
      submenu: [
        item('edit:undo'),
        item('edit:redo'),
        sep,
        { role: 'cut', label: '잘라내기' },
        { role: 'copy', label: '복사' },
        { role: 'paste', label: '붙여넣기' },
        item('edit:select-all'),
        sep,
        item('edit:find'),
        item('edit:replace'),
        sep,
        item('edit:insert-numbers'),
      ],
    },
    {
      label: 'View',
      submenu: [
        item('view:toggle-wrap'),
        item('view:toggle-whitespace'),
        sep,
        { role: 'zoomIn', label: '확대' },
        { role: 'zoomOut', label: '축소' },
        { role: 'resetZoom', label: '원래 크기' },
        sep,
        { role: 'toggleDevTools', label: '개발자 도구' },
      ],
    },
    {
      label: 'Compare',
      submenu: [
        item('compare:tabs'),
        item('compare:clipboard'),
        item('compare:files'),
        sep,
        item('compare:mark'),
        item('compare:with-marked'),
        sep,
        item('compare:next'),
        item('compare:prev'),
        sep,
        item('compare:toggle-whitespace'),
        item('compare:toggle-case'),
        sep,
        item('compare:close'),
      ],
    },
    {
      label: 'Tools',
      submenu: [item('tools:json-format'), item('tools:json-minify'), sep, item('tools:xml-format'), item('tools:xml-minify')],
    },
    {
      label: 'Notes',
      submenu: [
        item('notes:today'),
        item('notes:toggle-task'),
        sep,
        item('view:toggle-sidebar'),
        item('view:toggle-preview'),
        sep,
        item('notes:quick-open'),
        item('notes:search'),
        item('notes:follow-link'),
        item('notes:graph'),
        sep,
        item('notes:choose-dir'),
        item('notes:folders'),
        item('notes:storage'),
        sep,
        item('notes:ai-chat'),
        item('notes:ai-settings'),
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('file:open-dialog', async (_e, multi: boolean) => {
  const res = await dialog.showOpenDialog(win!, {
    properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
  });
  if (res.canceled) return [];
  return Promise.all(res.filePaths.map(async (p) => ({ path: p, content: await readFile(p, 'utf8') })));
});

ipcMain.handle('file:read', async (_e, filePath: string) => readFile(filePath, 'utf8'));

// 첨부: 붙여 넣은 이미지 바이트를 쓰거나, 끌어다 놓은 파일을 복사한다. 폴더가 없으면 만든다
ipcMain.handle('file:write-binary', async (_e, filePath: string, data: Uint8Array) => {
  await fileWrites.run(async () => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
  });
  cloud.noteWritten(filePath);
});
ipcMain.handle('file:copy', async (_e, from: string, to: string) => {
  await fileWrites.run(async () => {
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
  });
  cloud.noteWritten(to);
});
ipcMain.handle('file:exists', async (_e, filePath: string) => {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
});
// 첨부 파일을 운영체제 기본 앱으로 연다
ipcMain.handle('shell:open-path', (_e, filePath: string) => shell.openPath(filePath));

// expectedHash를 주면 디스크 내용이 그 해시와 다를 때(다른 기기에서 받은 변경 등) 쓰지 않고 conflict를 돌려준다
ipcMain.handle('file:write', async (_e, filePath: string, content: string, expectedHash?: string) => {
  const res = await fileWrites.run(() => writeTextChecked(filePath, content, expectedHash));
  if (res.ok) cloud.noteWritten(filePath);
  return res;
});

// 새 노트·파일 만들기. 그사이 다른 기기에서 받은 같은 이름의 파일이 있으면 덮지 않고 false를 돌려준다
ipcMain.handle('file:create', async (_e, filePath: string, content: string) => {
  const created = await fileWrites.run(() => createExclusive(filePath, content));
  if (created) cloud.noteWritten(filePath);
  return created;
});

ipcMain.handle('file:save-dialog', async (_e, defaultName: string) => {
  // 화면은 / 경로를 넘기므로 플랫폼 구분자로 되돌린다
  const res = await dialog.showSaveDialog(win!, { defaultPath: path.normalize(defaultName) });
  return res.canceled ? null : res.filePath;
});

ipcMain.handle('dialog:confirm-discard', async (_e, message: string) => {
  const res = await dialog.showMessageBox(win!, {
    type: 'warning',
    buttons: ['저장 안 함', '취소'],
    defaultId: 1,
    cancelId: 1,
    message,
  });
  return res.response === 0;
});

ipcMain.handle('clipboard:read', () => clipboard.readText());

ipcMain.handle('notes:get-dir', async () => (await readConfig()).notesDir ?? null);

// 폴더를 하나 고른다. 설정에는 저장하지 않는다
ipcMain.handle('dialog:choose-folder', async (_e, defaultPath: string) => {
  const res = await dialog.showOpenDialog(win!, { defaultPath, properties: ['openDirectory', 'createDirectory'] });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('notes:choose-dir', async () => {
  const res = await dialog.showOpenDialog(win!, {
    title: '업무 노트를 저장할 폴더를 고르세요',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled) return null;
  const notesDir = res.filePaths[0];
  await patchConfig({ notesDir });
  await cloud.notesDirChanged();
  return notesDir;
});

// 노트 폴더의 데일리 노트 폴더(기본 daily/) 아래 YYYY-MM-DD.md 파일 날짜 목록
ipcMain.handle('notes:list', async (_e, notesDir: string, folder: string) => {
  const dailyDir = path.join(notesDir, folder);
  await mkdir(dailyDir, { recursive: true });
  return (await readdir(dailyDir))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .map((f) => f.slice(0, 10))
    .sort();
});

// 노트 폴더 아래 .md와 txt·html 같은 텍스트 파일을 읽는다. .obsidian·.git 같은 숨김 폴더와 node_modules는 건너뛴다
ipcMain.handle('vault:scan', async (_e, notesDir: string) => {
  const out: { path: string; mtime: number; content: string }[] = [];
  const walk = async (dir: string) => {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      if (isSkippedEntry(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(full);
      else if (ent.isFile() && isTextPath(ent.name)) {
        const st = await stat(full);
        if (!shouldReadFile(ent.name, st.size)) continue;
        const content = await readFile(full, 'utf8');
        if (!shouldKeepContent(ent.name, content)) continue;
        out.push({ path: path.relative(notesDir, full).split(path.sep).join('/'), mtime: st.mtimeMs, content });
      }
    }
  };
  await walk(notesDir);
  return out;
});

// 시스템 강조색 (RRGGBB). 맥과 윈도우만 알려 준다
ipcMain.handle('theme:accent', () => {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return null;
  return systemPreferences.getAccentColor().slice(0, 6);
});

ipcMain.handle('keys:get', async () => (await readConfig()).keybindings ?? {});

ipcMain.handle('keys:set', async (_e, overrides: KeyOverrides) => {
  await patchConfig({ keybindings: overrides });
  buildMenu(resolveBindings(overrides));
});

ipcMain.on('keys:record', (_e, on: boolean) => {
  recordingKeys = on;
});

// 메뉴 막대가 없는 윈도우에서 탭 막대의 메뉴 버튼을 누르면 앱 메뉴를 띄운다
ipcMain.on('menu:popup', (_e, x: number, y: number) => {
  if (win) Menu.getApplicationMenu()?.popup({ window: win, x: Math.round(x), y: Math.round(y) });
});

// ⌘Q로 끝낼 때 창 닫기를 한 번 막고 저장을 확인하므로, 확인이 끝나면 종료를 다시 이어 간다
let quitting = false;
app.on('before-quit', () => {
  quitting = true;
});

ipcMain.on('app:close-approved', () => {
  allowClose = true;
  win?.close();
  if (quitting) app.quit();
});

app.whenReady().then(async () => {
  await migrateOldConfig();
  nativeTheme.on('updated', () => {
    if (process.platform === 'win32') win?.setTitleBarOverlay(titleBarOverlay());
  });
  buildMenu(resolveBindings((await readConfig()).keybindings ?? {}));
  createWindow();
  cloud.start();
  if (process.platform !== 'darwin') openPaths(filesFromArgv(process.argv));
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
