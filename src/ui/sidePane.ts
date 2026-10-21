// 오른쪽 사이드 창(미리보기 + AI 채팅 자리)의 너비·분할·보기 방식을 다루고 localStorage에 기억하는 화면
export type SidePaneMode = 'split' | 'switch';

export interface SidePaneOptions {
  workspace: HTMLElement;
  pane: HTMLElement;
  preview: HTMLElement;
  chatHost: HTMLElement;
  /** 편집 영역과 사이드 창 사이의 세로 막대 */
  widthHandle: HTMLElement;
  /** 미리보기와 채팅 사이의 가로 막대 */
  splitHandle: HTMLElement;
  fab: HTMLElement;
  /** false면(웹) AI 버튼과 채팅 자리를 아예 보이지 않는다 */
  chatEnabled: boolean;
}

export interface SidePane {
  setVisible(on: boolean): void;
  setMode(mode: SidePaneMode): void;
  getMode(): SidePaneMode;
  toggleChat(): void;
  showChat(on: boolean): void;
  isChatVisible(): boolean;
  readonly chatHost: HTMLElement;
  onChatVisibilityChange(cb: (visible: boolean) => void): () => void;
}

interface Layout {
  sideWidth: number | null;
  chatRatio: number;
  mode: SidePaneMode;
  chatOpen: boolean;
}

const STORAGE_KEY = 'aurora.layout';
const MIN_WIDTH = 260;
const MAX_WIDTH_SHARE = 0.75;
const MIN_PART = 120;
const DEFAULTS: Layout = { sideWidth: null, chatRatio: 0.5, mode: 'split', chatOpen: false };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 저장된 배치를 읽는다. 없거나 깨졌으면 기본값을 쓴다 */
function loadLayout(): Layout {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
    const o = raw as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      sideWidth: num(o.sideWidth),
      chatRatio: clamp(num(o.chatRatio) ?? DEFAULTS.chatRatio, 0.1, 0.9),
      mode: o.mode === 'switch' ? 'switch' : 'split',
      chatOpen: o.chatOpen === true,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** 막대를 끄는 동안 포인터를 잡아 두고, 움직임은 한 프레임에 한 번만 반영한다 */
function makeDraggable(handle: HTMLElement, cursor: string, onMove: (e: PointerEvent) => void, onEnd: () => void) {
  let frame = 0;
  let last: PointerEvent | null = null;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
    document.body.style.cursor = cursor;
  });
  handle.addEventListener('pointermove', (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    last = e;
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      if (last) onMove(last);
    });
  });
  const end = (e: PointerEvent) => {
    if (!handle.classList.contains('dragging')) return;
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    cancelAnimationFrame(frame);
    frame = 0;
    if (last) onMove(last);
    last = null;
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing');
    document.body.style.cursor = '';
    onEnd();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

export function createSidePane(opts: SidePaneOptions): SidePane {
  const { workspace, pane, preview, chatHost, widthHandle, splitHandle, fab, chatEnabled } = opts;
  const layout = loadLayout();
  const listeners = new Set<(visible: boolean) => void>();

  const save = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  const chatShown = () => chatEnabled && layout.chatOpen;

  function applyWidth() {
    if (layout.sideWidth === null) return;
    const max = Math.max(MIN_WIDTH, workspace.clientWidth * MAX_WIDTH_SHARE);
    pane.style.width = `${clamp(layout.sideWidth, MIN_WIDTH, max)}px`;
  }

  function applyParts() {
    const shown = chatShown();
    preview.hidden = shown && layout.mode === 'switch';
    chatHost.hidden = !shown;
    splitHandle.hidden = !(shown && layout.mode === 'split');
    // 보이는 칸들의 flex-grow 합이 1이어야 창을 꽉 채운다 (1보다 작으면 남는 공간이 빈다)
    const share = !shown ? 0 : layout.mode === 'switch' ? 1 : layout.chatRatio;
    pane.style.setProperty('--chat-share', String(share));
    fab.classList.toggle('on', shown);
    fab.setAttribute('aria-pressed', String(shown));
  }

  function showChat(on: boolean) {
    if (!chatEnabled || layout.chatOpen === on) return;
    layout.chatOpen = on;
    applyParts();
    save();
    listeners.forEach((cb) => cb(on));
  }

  makeDraggable(widthHandle, 'col-resize', (e) => {
    layout.sideWidth = pane.getBoundingClientRect().right - e.clientX;
    applyWidth();
  }, save);

  makeDraggable(splitHandle, 'row-resize', (e) => {
    const rect = pane.getBoundingClientRect();
    const avail = rect.height - splitHandle.offsetHeight;
    if (avail < MIN_PART * 2) return;
    const previewH = clamp(e.clientY - rect.top, MIN_PART, avail - MIN_PART);
    layout.chatRatio = 1 - previewH / avail;
    applyParts();
  }, save);

  fab.hidden = !chatEnabled;
  if (chatEnabled) fab.addEventListener('click', () => showChat(!layout.chatOpen));

  window.addEventListener('resize', applyWidth);
  applyWidth();
  applyParts();

  return {
    setVisible(on) {
      pane.hidden = !on;
      if (on) applyWidth();
    },
    setMode(mode) {
      if (layout.mode === mode) return;
      layout.mode = mode;
      applyParts();
      save();
    },
    getMode: () => layout.mode,
    toggleChat: () => showChat(!layout.chatOpen),
    showChat,
    isChatVisible: chatShown,
    chatHost,
    onChatVisibilityChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
