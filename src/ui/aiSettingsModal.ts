// AI 회사별 API 키, 미리보기·채팅 보기 방식, 대화 기록 폴더, 기본값을 바꾸는 "AI 설정" 대화상자
import { PROVIDERS, type Provider } from '../../electron/ai/types';
import type { AiSettings, KeyStorage } from '../../electron/aiShared';
import { PROVIDER_LABELS, modelsResultText } from '../lib/aiChat';
import { openModal } from './modal';
import type { SidePaneMode } from './sidePane';
import { api } from '../api';

export interface AiSettingsDeps {
  getMode(): SidePaneMode;
  setMode(mode: SidePaneMode): void;
  /** 설정이 바뀔 때마다 부른다. 열린 채팅 화면이 키·설정을 다시 읽게 한다 */
  onChange(): void;
}

const STORAGE_TEXT: Record<KeyStorage, string> = {
  os: '키는 운영체제 키체인에 암호화해 저장합니다.',
  weak: '이 컴퓨터에는 안전한 키 저장소가 없어 키가 약하게 보호됩니다.',
  unavailable: '이 컴퓨터에서는 키를 저장할 수 없습니다.',
};

const MODES: { mode: SidePaneMode; label: string }[] = [
  { mode: 'split', label: '위아래로 나란히 (미리보기와 채팅을 함께, 경계를 끌어 크기 조절)' },
  { mode: 'switch', label: '버튼으로 바꿔 보기 (AI 버튼으로 미리보기와 채팅 전환)' },
];

const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text) n.textContent = text;
  return n;
};

function section(title: string): HTMLElement {
  const sec = node('section', 'ai-section');
  sec.append(node('h4', '', title));
  return sec;
}

export async function openAiSettings(deps: AiSettingsDeps): Promise<void> {
  const keyStatus = await api.aiKeyStatus();
  let settings: AiSettings = await api.getAiSettings();
  let historyDir = await api.aiHistoryDir();

  const save = async (next: AiSettings) => {
    settings = next;
    await api.setAiSettings(next);
    deps.onChange();
  };

  openModal((box, close) => {
    box.classList.add('ai-settings');
    box.append(node('h3', '', 'AI 설정'));

    // ───── 회사(API 키) ─────
    const keysSec = section('회사');
    const storage = node('p', `hint${keyStatus.storage === 'os' ? '' : ' warn'}`, STORAGE_TEXT[keyStatus.storage]);
    keysSec.append(storage);
    for (const p of PROVIDERS) keysSec.append(keyRow(p, keyStatus.keys[p], keyStatus.storage === 'unavailable', deps));
    box.append(keysSec);

    // ───── 보기 방식 ─────
    const modeSec = section('보기 방식');
    for (const { mode, label } of MODES) {
      const row = node('label', 'ai-radio');
      const radio = node('input');
      radio.type = 'radio';
      radio.name = 'ai-mode';
      radio.checked = deps.getMode() === mode;
      radio.onchange = () => radio.checked && deps.setMode(mode);
      row.append(radio, label);
      modeSec.append(row);
    }
    box.append(modeSec);

    // ───── 대화 기록 폴더 ─────
    const dirSec = section('대화 기록 폴더');
    const dirPath = node('code', 'ai-dir', historyDir);
    const dirHint = node('p', 'hint');
    const showDir = async () => {
      historyDir = await api.aiHistoryDir();
      dirPath.textContent = historyDir;
      dirHint.textContent = settings.historyDir ? '직접 고른 폴더입니다.' : '기본 위치: 노트 폴더 안 .aurora/chats';
    };
    const browse = node('button', '', '찾아보기…');
    browse.onclick = async () => {
      const picked = await api.chooseFolder(historyDir);
      if (!picked) return;
      await save({ ...settings, historyDir: picked });
      await showDir();
    };
    const reset = node('button', '', '기본 위치로');
    reset.onclick = async () => {
      await save({ ...settings, historyDir: null });
      await showDir();
    };
    const dirButtons = node('div', 'ai-row');
    dirButtons.append(browse, reset);
    dirSec.append(dirPath, dirHint, dirButtons);
    void showDir();
    box.append(dirSec);

    // ───── 기본값 ─────
    const defSec = section('기본값');
    const toggle = (label: string, key: 'webSearch' | 'includeNote') => {
      const row = node('label', 'ai-check');
      const check = node('input');
      check.type = 'checkbox';
      check.checked = settings[key];
      check.onchange = () => void save({ ...settings, [key]: check.checked });
      row.append(check, label);
      defSec.append(row);
    };
    toggle('웹 검색', 'webSearch');
    toggle('현재 노트 포함', 'includeNote');
    box.append(defSec);

    const buttons = node('div', 'buttons');
    const done = node('button', 'primary', '닫기');
    done.onclick = close;
    buttons.append(done);
    box.append(buttons);
  });
}

/** 회사 한 곳의 키 입력·저장·삭제 줄. 저장된 키 값은 절대 화면에 보이지 않는다 */
function keyRow(p: Provider, hasKey: boolean, disabled: boolean, deps: AiSettingsDeps): HTMLElement {
  const row = node('div', 'ai-key-row');
  const name = node('span', 'ai-key-name', PROVIDER_LABELS[p]);
  const input = node('input');
  input.type = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.disabled = disabled;
  const saveBtn = node('button', '', '저장');
  saveBtn.disabled = disabled;
  const delBtn = node('button', 'ai-delete', '삭제');
  const msg = node('div', 'ai-key-msg');
  const setHasKey = (on: boolean) => {
    input.placeholder = on ? '저장됨' : 'API 키';
    delBtn.hidden = !on;
  };
  setHasKey(hasKey);

  const saveKey = async () => {
    const key = input.value.trim();
    if (!key) return void (msg.textContent = 'API 키를 입력하세요.');
    saveBtn.disabled = true;
    saveBtn.textContent = '확인 중…';
    msg.className = 'ai-key-msg';
    try {
      const res = await api.aiSaveKey(p, key);
      msg.textContent = modelsResultText(res);
      msg.classList.toggle('error', !res.ok);
      if (res.ok) {
        input.value = '';
        setHasKey(true);
      }
    } catch (e) {
      msg.textContent = `저장하지 못했습니다: ${(e as Error).message}`;
      msg.classList.add('error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = '저장';
      deps.onChange();
    }
  };
  saveBtn.onclick = () => void saveKey();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) void saveKey();
  });
  delBtn.onclick = async () => {
    await api.aiDeleteKey(p);
    setHasKey(false);
    msg.className = 'ai-key-msg';
    msg.textContent = '키를 지웠습니다.';
    deps.onChange();
  };

  row.append(name, input, saveBtn, delBtn, msg);
  return row;
}
