// 사이드 창 아래칸의 AI 채팅 화면. 데스크톱에서만 늦게 불러오며, 답변은 marked + DOMPurify로 안전하게 그린다
import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { PROVIDERS, type ChatEvent, type ChatTurn, type Citation, type ModelInfo, type Provider } from '../../electron/ai/types';
import { answerToMarkdown, buildSystemPrompt, dedupeCitations } from '../../electron/ai/context';
import { chatFileName, isSafeRelativePath, numberedFileName, parseChat, serializeChat } from '../../electron/ai/history';
import { isImageModel, type AiSettings } from '../../electron/aiShared';
import {
  PROVIDER_LABELS, answerWithImagesMarkdown, base64ToBytes, buildChatRequest, errorText, isWebUrl, missingSourcesNotice, modelOptions,
  settleTurns,
  type StreamOutcome,
} from '../lib/aiChat';
import { ATTACH_FOLDER, aiImageName, imageExt, uniqueName } from '../lib/attachments';
import { openPicker } from './picker';
import { api } from '../api';
import { contentHash } from '../lib/diskSync';

export interface NoteContext { noteTitle?: string; noteText?: string; selection?: string }

/** 노트에 첨부할 AI 그림. srcPath가 있으면 그 파일을 복사하고, 없으면 blob을 쓴다 */
export interface AiNoteImage { name: string; blob?: Blob; srcPath?: string }

export interface ChatPanelDeps {
  status(msg: string): void;
  getNoteContext(): NoteContext;
  /** '현재 노트 포함' 칩에 띄울, 지금 보낼 노트 설명 */
  describeNoteContext(): string;
  /** images를 첨부로 저장한 뒤 compose가 그 링크 줄로 만든 글을 넣는다 */
  insertIntoNote(compose: (imageLines: string[]) => string, images?: AiNoteImage[]): Promise<void>;
  openSettings(): void;
}

export interface ChatPanel {
  focus(): void;
  /** AI 설정이 바뀐 뒤 키 상태·설정·모델 목록을 다시 읽는다 */
  refresh(): Promise<void>;
}

/** 이번에 받은 그림은 blob, 기록에서 연 그림은 file(절대 경로)을 가진다 */
interface ShownImage { mimeType: string; blob?: Blob; file?: string }

/** unsaved는 아직 기록 폴더에 쓰지 않은 답별 그림이다. diskHash는 이 창이 마지막으로 읽거나 쓴 기록 파일 내용의 해시다 */
interface Chat {
  file: string | null; created: Date; provider: Provider; model: string; turns: ChatTurn[];
  unsaved: Map<ChatTurn, ShownImage[]>; diskHash: string;
}

interface AnswerView { root: HTMLElement; answer: HTMLElement; images: HTMLElement; note: HTMLElement }

/** early는 요청 id를 받기 전에 도착한 이벤트를 잠시 모아 두는 곳이다 */
interface Stream {
  id: string; text: string; view: AnswerView; userEl: HTMLElement; frame: number; abortRequested: boolean;
  early: [string, ChatEvent][] | null; images: ShownImage[]; waitNote: string; webSearch: boolean;
}

const IMAGE_WAIT_NOTE = '이미지를 만드는 중…';

// 저장된 대화의 모델 칸은 비울 수 없으므로 '기본 모델'은 이 값으로 적는다
const DEFAULT_MODEL_MARK = 'default';

// 미리보기용 marked는 [[링크]] 확장이 붙어 있으므로 채팅은 따로 만든 인스턴스를 쓴다
const md = new Marked();

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const dirOf = (p: string): string => p.slice(0, p.lastIndexOf('/'));
const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const MIME_BY_EXT: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const mimeOfPath = (p: string): string => MIME_BY_EXT[(/\.([^./]+)$/.exec(p)?.[1] ?? '').toLowerCase()] ?? 'image/png';

const renderMarkdown = (text: string): string => DOMPurify.sanitize(md.parse(text, { async: false }), { FORBID_TAGS: ['form', 'style'], FORBID_ATTR: ['style'] });

/** 채팅 안 링크는 앱 화면을 바꾸지 않도록 http(s)만 외부 브라우저로 연다 */
function openLinkFrom(e: Event) {
  const a = (e.target as HTMLElement).closest('a');
  if (!a) return;
  e.preventDefault();
  if (/^https?:/i.test(a.href)) window.open(a.href, '_blank', 'noopener');
}

export async function createChatPanel(host: HTMLElement, deps: ChatPanelDeps): Promise<ChatPanel> {
  let settings: AiSettings = await api.getAiSettings();
  let keys = (await api.aiKeyStatus()).keys;
  const modelCache = new Map<Provider, ModelInfo[] | null>();
  const modelLoading = new Set<Provider>();
  let chat = newChat();
  let stream: Stream | null = null;
  let blobUrls: string[] = [];

  host.replaceChildren();
  host.classList.add('chat-panel');

  const header = el('div', 'chat-header');
  const providerSel = el('select', 'chat-select chat-provider');
  providerSel.title = 'AI 회사';
  const modelSel = el('select', 'chat-select chat-model');
  modelSel.title = '모델';
  const newBtn = el('button', 'chat-icon-btn', '새 대화');
  const historyBtn = el('button', 'chat-icon-btn', '기록 열기');
  const settingsBtn = el('button', 'chat-icon-btn chat-gear', '⚙');
  settingsBtn.title = 'AI 설정';
  header.append(providerSel, modelSel, el('span', 'chat-spacer'), newBtn, historyBtn, settingsBtn);

  const body = el('div', 'chat-body');
  const list = el('div', 'chat-list');
  const empty = el('div', 'chat-empty');
  const emptyText = el('p', '', 'API 키를 넣으면 AI 채팅을 쓸 수 있습니다.');
  const emptyBtn = el('button', 'primary', 'AI 설정 열기');
  empty.append(el('div', 'chat-empty-mark', '✦'), emptyText, emptyBtn);
  const intro = el('div', 'chat-intro', '노트에 대해 묻거나, 글을 다듬거나, 웹에서 찾아보게 하세요.');
  body.append(intro, list, empty);

  const composer = el('div', 'chat-composer');
  const input = el('textarea', 'chat-input');
  input.rows = 1;
  input.placeholder = 'AI에게 물어보기… (Enter 보내기, ⇧Enter 줄바꿈)';
  const row = el('div', 'chat-composer-row');
  const webChip = el('button', 'chat-chip', '웹 검색');
  const noteChip = el('button', 'chat-chip', '현재 노트 포함');
  const sendBtn = el('button', 'primary chat-send', '보내기');
  row.append(webChip, noteChip, el('span', 'chat-spacer'), sendBtn);
  composer.append(input, row);
  host.append(header, body, composer);

  // ───── 설정·공급자·모델 ─────

  const saveSettings = () => void api.setAiSettings(settings);

  function renderProviders() {
    providerSel.replaceChildren(
      ...PROVIDERS.map((p) => new Option(`${PROVIDER_LABELS[p]}${keys[p] ? '' : ' (키 없음)'}`, p, false, p === settings.provider)),
    );
  }

  function renderModels() {
    const p = settings.provider;
    const saved = settings.models[p] ?? '';
    const opts = modelOptions(saved, modelCache.get(p) ?? null);
    modelSel.replaceChildren(...opts.map((o) => new Option(o.label, o.id, false, o.id === saved)));
    modelSel.disabled = modelLoading.has(p);
  }

  function renderChips() {
    webChip.setAttribute('aria-pressed', String(settings.webSearch));
    noteChip.setAttribute('aria-pressed', String(settings.includeNote));
    noteChip.title = deps.describeNoteContext();
  }
  noteChip.addEventListener('mouseenter', () => { noteChip.title = deps.describeNoteContext(); });

  function renderKeyState() {
    const hasKey = keys[settings.provider];
    empty.hidden = hasKey;
    list.hidden = !hasKey;
    intro.hidden = !hasKey || chat.turns.length > 0 || list.childElementCount > 0;
    input.disabled = !hasKey;
    sendBtn.disabled = !hasKey && !stream;
  }

  async function ensureModels(p: Provider) {
    if (!keys[p] || modelCache.has(p) || modelLoading.has(p)) return;
    modelLoading.add(p);
    renderModels();
    const res = await api.aiListModels(p).catch((e: unknown) => ({ ok: false as const, kind: 'network' as const, message: (e as Error).message }));
    modelLoading.delete(p);
    modelCache.set(p, res.ok ? res.models : null);
    if (!res.ok) deps.status(`${PROVIDER_LABELS[p]} 모델 목록을 가져오지 못했습니다: ${errorText(res.kind, res.message)}`);
    if (p === settings.provider) renderModels();
  }

  function renderAll() {
    renderProviders();
    renderModels();
    renderChips();
    renderKeyState();
    void ensureModels(settings.provider);
  }

  providerSel.onchange = () => {
    settings = { ...settings, provider: providerSel.value as Provider };
    saveSettings();
    renderAll();
  };
  modelSel.onchange = () => {
    const models = { ...settings.models };
    if (modelSel.value) models[settings.provider] = modelSel.value;
    else delete models[settings.provider];
    settings = { ...settings, models };
    saveSettings();
  };
  webChip.onclick = () => {
    settings = { ...settings, webSearch: !settings.webSearch };
    saveSettings();
    renderChips();
  };
  noteChip.onclick = () => {
    settings = { ...settings, includeNote: !settings.includeNote };
    saveSettings();
    renderChips();
  };
  settingsBtn.onclick = deps.openSettings;
  emptyBtn.onclick = deps.openSettings;

  // ───── 메시지 그리기 ─────

  const nearBottom = () => body.scrollHeight - body.scrollTop - body.clientHeight < 48;
  const scrollToEnd = () => { body.scrollTop = body.scrollHeight; };

  function appendUser(text: string): HTMLElement {
    const msg = el('div', 'chat-msg chat-user');
    msg.append(el('div', 'chat-bubble', text));
    list.append(msg);
    return msg;
  }

  function appendAnswer(): AnswerView {
    const root = el('div', 'chat-msg chat-ai');
    const answer = el('div', 'chat-answer markdown');
    const images = el('div', 'chat-images');
    const note = el('div', 'chat-note');
    note.hidden = true;
    root.append(answer, images, note);
    list.append(root);
    return { root, answer, images, note };
  }

  function revokeImages() {
    for (const url of blobUrls) URL.revokeObjectURL(url);
    blobUrls = [];
  }

  function noteImage(img: ShownImage): AiNoteImage {
    return img.file ? { name: baseName(img.file), srcPath: img.file } : { name: aiImageName(new Date(), img.mimeType), blob: img.blob };
  }

  async function saveImageAs(img: ShownImage) {
    const dest = await api.saveDialog(noteImage(img).name);
    if (!dest) return;
    try {
      if (img.file) await api.copyFile(img.file, dest);
      else if (img.blob) await api.writeBinary(dest, new Uint8Array(await img.blob.arrayBuffer()));
      deps.status(`그림을 ${dest}에 저장했습니다`);
    } catch (e) {
      deps.status(`그림을 저장하지 못했습니다: ${(e as Error).message}`);
    }
  }

  /** 그림 하나와 그 그림만 다루는 버튼을 답 아래에 붙인다. 주소는 코드로만 넣고 innerHTML은 쓰지 않는다 */
  async function showImage(view: AnswerView, img: ShownImage) {
    const box = el('div', 'chat-image-box');
    view.images.append(box);
    const image = el('img', 'chat-image');
    image.alt = 'AI가 만든 그림';
    const missing = () => box.replaceChildren(el('div', 'chat-image-missing', '이미지를 찾을 수 없습니다'));
    if (img.blob) {
      const url = URL.createObjectURL(img.blob);
      blobUrls.push(url);
      image.src = url;
    } else if (img.file && (await api.exists(img.file).catch(() => false))) {
      image.src = await api.mediaUrl(img.file);
    } else {
      return missing();
    }
    image.addEventListener('error', missing, { once: true });
    const actions = el('div', 'chat-actions');
    const insert = el('button', 'chat-action', '노트에 넣기');
    const save = el('button', 'chat-action', '저장…');
    insert.onclick = () => void deps.insertIntoNote((lines) => lines.join('\n'), [noteImage(img)]);
    save.onclick = () => void saveImageAs(img);
    actions.append(insert, save);
    box.append(image, actions);
  }

  function appendNotice(text: string) {
    list.append(el('div', 'chat-notice', text));
  }

  function setNote(view: AnswerView, text: string) {
    view.note.textContent = text;
    view.note.hidden = !text;
  }

  function sourcesEl(citations: Citation[]): HTMLElement | null {
    const items = dedupeCitations(citations);
    if (items.length === 0) return null;
    const box = el('div', 'chat-sources');
    box.append(el('div', 'chat-sources-label', '출처'));
    const ul = el('ul');
    for (const c of items) {
      const li = el('li');
      if (isWebUrl(c.url)) {
        const a = el('a', '', c.title || c.url);
        a.href = c.url;
        a.title = c.url;
        li.append(a);
      } else {
        li.textContent = c.title || c.url;
      }
      ul.append(li);
    }
    box.append(ul);
    return box;
  }

  /** 구글이 함께 보여 달라는 검색 추천 칩. 페이지 스타일과 섞이지 않게 Shadow DOM에 넣는다 */
  function searchEntryEl(html: string): HTMLElement {
    const box = el('div', 'chat-search-entry');
    const shadow = box.attachShadow({ mode: 'open' });
    shadow.innerHTML = DOMPurify.sanitize(html, { ADD_TAGS: ['style'], FORCE_BODY: true });
    shadow.addEventListener('click', openLinkFrom);
    return box;
  }

  function finalizeAnswer(view: AnswerView, text: string, citations: Citation[], images: ShownImage[], searchEntryHtml?: string) {
    view.answer.innerHTML = renderMarkdown(text);
    view.answer.hidden = !text.trim() && images.length > 0;
    const sources = sourcesEl(citations);
    if (sources) view.root.append(sources);
    if (searchEntryHtml) view.root.append(searchEntryEl(searchEntryHtml));
    const actions = el('div', 'chat-actions');
    const insert = el('button', 'chat-action', '노트에 넣기');
    const copy = el('button', 'chat-action', '복사');
    const markdown = () => answerToMarkdown(text, citations);
    insert.onclick = () => void deps.insertIntoNote((lines) => answerWithImagesMarkdown(text, lines, citations), images.map(noteImage));
    copy.onclick = () => {
      void navigator.clipboard.writeText(markdown()).then(
        () => deps.status('AI 답변을 복사했습니다'),
        () => deps.status('복사하지 못했습니다'),
      );
    };
    actions.append(insert, copy);
    view.root.append(actions);
  }

  function renderTurns(turns: ChatTurn[], dir: string) {
    revokeImages();
    list.replaceChildren();
    for (const t of turns) {
      if (t.role === 'user') {
        appendUser(t.text);
        continue;
      }
      const view = appendAnswer();
      const images = (t.images ?? []).map((rel): ShownImage => ({ mimeType: mimeOfPath(rel), file: isSafeRelativePath(rel) ? `${dir}/${rel}` : '' }));
      for (const img of images) void showImage(view, img);
      finalizeAnswer(view, t.text, t.citations ?? [], images.filter((img) => img.file));
    }
    renderKeyState();
    scrollToEnd();
  }

  // ───── 보내기·스트림 ─────

  function setBusy(busy: boolean) {
    sendBtn.textContent = busy ? '중지' : '보내기';
    sendBtn.classList.toggle('stop', busy);
    host.classList.toggle('streaming', busy);
    renderKeyState();
  }

  function scheduleRender(s: Stream) {
    s.frame ||= requestAnimationFrame(() => {
      s.frame = 0;
      const stick = nearBottom();
      s.view.answer.innerHTML = renderMarkdown(s.text);
      if (stick) scrollToEnd();
    });
  }

  function autoGrow() {
    input.style.height = 'auto';
    const border = input.offsetHeight - input.clientHeight;
    input.style.height = `${Math.min(input.scrollHeight + border, 200)}px`;
  }

  async function send() {
    const text = input.value.trim();
    if (stream || !text || !keys[settings.provider]) return;
    const ctx = settings.includeNote ? deps.getNoteContext() : {};
    if (!chat.file && chat.turns.length === 0) chat.created = new Date();
    chat.provider = settings.provider;
    chat.model = settings.models[settings.provider] ?? '';
    chat.turns = [...chat.turns, { role: 'user', text }];
    list.querySelectorAll('.chat-notice').forEach((n) => n.remove());
    input.value = '';
    autoGrow();
    const userEl = appendUser(text);
    const view = appendAnswer();
    view.root.classList.add('pending');
    const waitNote = isImageModel(chat.provider, chat.model) ? IMAGE_WAIT_NOTE : '';
    setNote(view, waitNote);
    const s: Stream = { id: '', text: '', view, userEl, frame: 0, abortRequested: false, early: [], images: [], waitNote, webSearch: settings.webSearch };
    stream = s;
    setBusy(true);
    scrollToEnd();
    try {
      const id = await api.aiChat(buildChatRequest(settings, buildSystemPrompt({ ...ctx, webSearch: settings.webSearch }), chat.turns));
      s.id = id;
      const queued = s.early ?? [];
      s.early = null;
      if (s.abortRequested || stream !== s) void api.aiAbort(id);
      if (stream === s) for (const [qid, ev] of queued) if (qid === id) onEvent(qid, ev);
    } catch (e) {
      s.early = null;
      if (stream === s) finish({ type: 'error', kind: 'network', partial: '' }, `요청을 보내지 못했습니다: ${(e as Error).message}`);
    }
  }

  function abort() {
    if (!stream) return;
    if (stream.id) void api.aiAbort(stream.id);
    else stream.abortRequested = true;
  }

  /** 다른 대화로 옮길 때 진행 중인 답을 멈추고 화면과 떼어 놓는다 */
  function detach() {
    if (!stream) return;
    abort();
    cancelAnimationFrame(stream.frame);
    stream = null;
    setBusy(false);
  }

  function onEvent(id: string, ev: ChatEvent) {
    const s = stream;
    if (s?.early) {
      s.early.push([id, ev]);
      return;
    }
    if (!s || id !== s.id) return;
    if ((ev.type === 'text' || ev.type === 'image') && s.waitNote) {
      if (s.view.note.textContent === s.waitNote) setNote(s.view, '');
      s.waitNote = '';
    }
    if (ev.type === 'text') {
      s.text += ev.delta;
      s.view.root.classList.remove('pending');
      scheduleRender(s);
    } else if (ev.type === 'image') {
      s.view.root.classList.remove('pending');
      addStreamImage(s, ev.mimeType, ev.data);
    } else if (ev.type === 'status') {
      setNote(s.view, ev.text);
    } else if (ev.type === 'done') {
      finish({ type: 'done', text: ev.text, citations: ev.citations }, ev.notice ?? '', ev.searchEntryHtml, ev.searchQueries);
    } else {
      finish({ type: 'error', kind: ev.kind, partial: s.text, images: s.images.length }, errorText(ev.kind, ev.message));
    }
  }

  function addStreamImage(s: Stream, mimeType: string, data: string) {
    let blob: Blob;
    try {
      blob = new Blob([base64ToBytes(data)], { type: mimeType });
    } catch (e) {
      deps.status(`AI가 보낸 그림을 읽지 못했습니다: ${(e as Error).message}`);
      return;
    }
    const img: ShownImage = { mimeType, blob };
    s.images.push(img);
    const stick = nearBottom();
    void showImage(s.view, img);
    if (stick) scrollToEnd();
  }

  /** 스트림을 끝내고 결과에 따라 답을 남기거나, 실패한 질문을 입력란에 되돌린다 */
  function finish(outcome: StreamOutcome, message: string, searchEntryHtml?: string, searchQueries?: string[]) {
    const s = stream;
    if (!s) return;
    stream = null;
    cancelAnimationFrame(s.frame);
    s.view.root.classList.remove('pending');
    const r = settleTurns(chat.turns, outcome);
    chat.turns = r.turns;
    if (r.answered) {
      const turn = r.turns[r.turns.length - 1];
      if (s.images.length > 0) chat.unsaved.set(turn, s.images);
      setNote(s.view, message);
      finalizeAnswer(s.view, turn.text, turn.citations ?? [], s.images, searchEntryHtml);
      // 화면에만 보이고 기록에는 남기지 않는다
      const missing = outcome.type === 'done' ? missingSourcesNotice(s.webSearch, outcome.citations, searchQueries) : '';
      if (missing) s.view.root.insertBefore(el('div', 'chat-search-note', missing), s.view.root.querySelector(':scope > .chat-actions'));
      void persist(chat);
    } else {
      s.view.root.remove();
      s.userEl.remove();
      appendNotice(message);
      if (r.restore !== null) {
        input.value = input.value ? `${r.restore}\n${input.value}` : r.restore;
        autoGrow();
      }
    }
    setBusy(false);
    scrollToEnd();
  }

  api.onAiEvent(onEvent);

  // ───── 기록 ─────

  function newChat(): Chat {
    return { file: null, created: new Date(), provider: settings.provider, model: '', turns: [], unsaved: new Map(), diskHash: contentHash('') };
  }

  // 저장을 한 줄로 세워, 첫 저장이 고른 파일 이름을 뒤 저장이 그대로 쓰게 한다
  let saving: Promise<void> = Promise.resolve();
  function persist(c: Chat): Promise<void> {
    saving = saving.then(() => save(c));
    return saving;
  }

  /** 이미 있는 파일을 덮지 않도록 ' (2)', ' (3)'… 을 붙여 빈 이름을 찾는다 */
  async function uniqueChatPath(c: Chat): Promise<string> {
    const dir = await api.aiHistoryDir();
    const name = chatFileName(c.created, c.turns.find((t) => t.role === 'user')?.text ?? '');
    for (let n = 1; ; n++) {
      const candidate = `${dir}/${numberedFileName(name, n)}`;
      if (!(await api.exists(candidate))) return candidate;
    }
  }

  /** 아직 쓰지 않은 그림을 기록 폴더의 첨부 폴더에 한 번씩 쓰고, 답에 상대 경로를 적는다 */
  async function saveImages(c: Chat, file: string) {
    const dir = dirOf(file);
    const base = baseName(file).replace(/\.md$/i, '');
    let n = c.turns.reduce((sum, t) => sum + (t.images?.length ?? 0), 0);
    for (const [turn, images] of c.unsaved) {
      const rels: string[] = [];
      for (const img of images) {
        if (!img.blob) continue;
        const name = await uniqueName(`${base} ${++n}.${imageExt(img.mimeType)}`, (x) => api.exists(`${dir}/${ATTACH_FOLDER}/${x}`));
        await api.writeBinary(`${dir}/${ATTACH_FOLDER}/${name}`, new Uint8Array(await img.blob.arrayBuffer()));
        rels.push(`${ATTACH_FOLDER}/${name}`);
      }
      turn.images = [...(turn.images ?? []), ...rels];
      c.unsaved.delete(turn);
    }
  }

  async function save(c: Chat) {
    try {
      c.file ??= await uniqueChatPath(c);
      await saveImages(c, c.file);
      const text = serializeChat({
        provider: c.provider,
        model: c.model || DEFAULT_MODEL_MARK,
        created: c.created.toISOString(),
        updated: new Date().toISOString(),
        turns: c.turns,
      });
      if (!(await api.writeFile(c.file, text, c.diskHash)).ok) {
        // 다른 기기에서 같은 기록에 대화를 더했다. 그쪽을 덮지 않고 이 대화를 새 이름으로 남긴다
        c.file = await uniqueChatPath(c);
        if (!(await api.writeFile(c.file, text, contentHash(''))).ok) throw new Error('새 기록 파일 이름을 고르지 못했습니다');
        deps.status('다른 기기에서 이 대화가 바뀌어 새 파일로 저장했습니다');
      }
      c.diskHash = contentHash(text);
    } catch (e) {
      deps.status(`대화 기록을 저장하지 못했습니다: ${(e as Error).message}`);
    }
  }

  function startNewChat() {
    detach();
    chat = newChat();
    revokeImages();
    list.replaceChildren();
    renderKeyState();
    input.focus();
  }

  async function loadChat(path: string) {
    const raw = await api.readFile(path).catch(() => '');
    const parsed = parseChat(raw);
    if (!parsed) return deps.status('대화 기록을 읽지 못했습니다');
    detach();
    const created = new Date(parsed.created);
    const model = parsed.model === DEFAULT_MODEL_MARK ? '' : parsed.model;
    chat = {
      file: path, created: Number.isNaN(created.getTime()) ? new Date() : created, provider: parsed.provider, model, turns: parsed.turns,
      unsaved: new Map(), diskHash: contentHash(raw),
    };
    const models = { ...settings.models };
    if (model) models[parsed.provider] = model;
    settings = { ...settings, provider: parsed.provider, models };
    saveSettings();
    renderAll();
    renderTurns(chat.turns, dirOf(path));
  }

  async function openHistory() {
    let files: Awaited<ReturnType<typeof api.aiListChats>>;
    try {
      files = await api.aiListChats(await api.aiHistoryDir());
    } catch (e) {
      return deps.status(`대화 기록을 찾지 못했습니다: ${(e as Error).message}`);
    }
    if (files.length === 0) return deps.status('저장된 대화가 없습니다');
    const items = files.map((f) => ({
      label: f.name.replace(/\.md$/i, ''),
      sub: new Date(f.mtime).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }),
      data: f.path,
    }));
    openPicker<string>({
      title: '대화 기록 열기',
      placeholder: '대화 이름 일부를 입력하세요',
      help: '↑↓ 이동 · Enter 열기 · 최근 대화가 위에 있습니다',
      search: (q) => items.filter((i) => i.label.toLowerCase().includes(q.trim().toLowerCase())),
      onPick: (item) => item && void loadChat(item.data),
    });
  }

  newBtn.onclick = startNewChat;
  historyBtn.onclick = () => void openHistory();

  // ───── 입력 ─────

  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    } else if (e.key === 'Escape' && stream) {
      e.preventDefault();
      e.stopPropagation();
      abort();
    }
  });
  sendBtn.onclick = () => (stream ? abort() : void send());
  body.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('a')) openLinkFrom(e);
  });

  renderAll();

  return {
    focus: () => input.focus(),
    async refresh() {
      settings = await api.getAiSettings();
      keys = (await api.aiKeyStatus()).keys;
      modelCache.clear();
      renderAll();
    },
  };
}
