// 노트를 이 컴퓨터 폴더에만 둘지 S3 호환 클라우드와 맞출지 고르고 연결을 확인하는 "저장소 설정" 대화상자
import type { CloudSettingsView } from '../../electron/cloud/types';
import {
  PRESETS, guessPreset, presetById, previewLines, regionFromEndpoint, sentence, syncStatusText, testResultText, validateCloudForm,
  type CloudFormField, type CloudFormValues, type Preset,
} from '../lib/cloudForm';
import { askConfirm, openModal } from './modal';
import { skippedLines } from '../lib/diskSync';
import { api } from '../api';

export interface StorageDeps {
  getNotesDir(): string | null;
  /** 노트 폴더 바꾸기 흐름을 돌리고 새 폴더를 돌려준다. 고르지 않으면 null */
  changeNotesDir(): Promise<string | null>;
  /** 처음 실행에서 클라우드를 고른 경우처럼 클라우드 칸을 펼친 채 연다 */
  initialMode?: 'local' | 'cloud';
}

const NO_DIR_TEXT = '먼저 노트 폴더를 고르세요. 다른 PC에서 처음 연결한다면 빈 폴더를 고르면 클라우드의 노트를 받아 옵니다.';
const DISABLE_TEXT = '파일은 이 컴퓨터에 그대로 남고, 클라우드와 맞추는 것만 멈춥니다.';
const HELP_TEXT = 'R2·B2 버킷과 키 만드는 법은 사용설명서의 클라우드 저장소 절을 보세요.';

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

function textInput(type: 'text' | 'password' = 'text'): HTMLInputElement {
  const input = node('input');
  input.type = type;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('autocapitalize', 'off');
  return input;
}

function row(label: string, control: HTMLElement): HTMLLabelElement {
  const el = node('label', 'storage-field');
  el.append(node('span', '', label), control);
  return el;
}

const errorMessage = (e: unknown) => sentence(e instanceof Error ? e.message : String(e));

export async function openStorageSettings(deps: StorageDeps): Promise<void> {
  let view: CloudSettingsView = await api.getCloudSettings();
  let notesDir = deps.getNotesDir();
  let busy = false;
  // 클라우드로 바꾼 직후 첫 동기화 동안은 "올리는 중"으로 보인다
  let firstSync = false;

  openModal((box, close) => {
    box.classList.add('ai-settings', 'storage-settings');
    box.append(node('h3', '', '저장소 설정'));

    // ───── 저장 위치 ─────
    const whereSec = section('저장 위치');
    const radio = (label: string) => {
      const wrap = node('label', 'ai-radio');
      const input = node('input');
      input.type = 'radio';
      input.name = 'storage-mode';
      wrap.append(input, label);
      whereSec.append(wrap);
      return input;
    };
    const localRadio = radio('로컬 폴더');
    const cloudRadio = radio('클라우드 (S3 호환)');
    if ((deps.initialMode ?? view.mode) === 'cloud') cloudRadio.checked = true;
    else localRadio.checked = true;
    const dirPath = node('code', 'ai-dir');
    const noDirHint = node('p', 'hint warn', NO_DIR_TEXT);
    const pickDir = node('button');
    const dirRow = node('div', 'ai-row');
    dirRow.append(pickDir);
    const localNote = node('p', 'hint');
    whereSec.append(node('p', 'hint', '노트 폴더'), dirPath, noDirHint, dirRow, localNote);
    box.append(whereSec);

    // ───── 클라우드 연결 ─────
    const cloudSec = section('클라우드 연결');
    const form = node('fieldset', 'storage-form');
    const presetSel = node('select');
    for (const p of PRESETS) presetSel.add(new Option(p.label, p.id));
    const inputs: Record<CloudFormField | 'device', HTMLInputElement> = {
      endpoint: textInput(),
      region: textInput(),
      bucket: textInput(),
      prefix: textInput(),
      accessKeyId: textInput(),
      secret: textInput('password'),
      device: textInput(),
    };
    inputs.prefix.placeholder = '비우면 버킷 맨 위';
    inputs.device.placeholder = '비우면 이 컴퓨터 이름';
    const pathStyle = node('input');
    pathStyle.type = 'checkbox';
    const pathRow = node('label', 'ai-check');
    pathRow.append(pathStyle, '경로 방식 주소(path-style)');
    form.append(
      row('서비스', presetSel),
      row('엔드포인트', inputs.endpoint),
      row('리전', inputs.region),
      row('버킷', inputs.bucket),
      row('폴더 (선택)', inputs.prefix),
      row('Access Key ID', inputs.accessKeyId),
      row('Secret Access Key', inputs.secret),
      row('기기 이름', inputs.device),
      pathRow,
    );
    const formError = node('div', 'error');
    const testMsg = node('div', 'storage-msg');
    const testBtn = node('button', '', '연결 확인');
    const enableBtn = node('button', 'primary', '클라우드로 바꾸기');
    const cloudButtons = node('div', 'ai-row');
    cloudButtons.append(testBtn, enableBtn);
    const lockedHint = node('p', 'hint', '설정을 바꾸려면 로컬로 바꾼 뒤 다시 클라우드로 바꾸세요.');
    cloudSec.append(form, lockedHint, formError, testMsg, cloudButtons);
    box.append(cloudSec);

    const applyPreset = (p: Preset, keepValues = false) => {
      inputs.endpoint.placeholder = p.endpointPlaceholder;
      inputs.region.placeholder = p.regionPlaceholder;
      if (keepValues) return;
      inputs.endpoint.value = p.endpoint;
      inputs.region.value = p.region;
      pathStyle.checked = p.pathStyle;
    };
    presetSel.onchange = () => {
      const p = PRESETS.find((x) => x.id === presetSel.value);
      if (p) applyPreset(p);
    };
    inputs.endpoint.addEventListener('input', () => {
      const region = regionFromEndpoint(inputs.endpoint.value);
      if (region) inputs.region.value = region;
    });
    const setSecretPlaceholder = () => {
      inputs.secret.placeholder = view.hasSecret ? '저장됨' : '';
    };
    if (view.cloud) {
      const saved = view.cloud;
      const preset = presetById(guessPreset(saved.endpoint));
      presetSel.value = preset.id;
      applyPreset(preset, true);
      inputs.endpoint.value = saved.endpoint;
      inputs.region.value = saved.region;
      inputs.bucket.value = saved.bucket;
      inputs.prefix.value = saved.prefix;
      inputs.accessKeyId.value = saved.accessKeyId;
      inputs.device.value = saved.device;
      pathStyle.checked = saved.pathStyle;
    } else {
      applyPreset(PRESETS[0]);
    }
    setSecretPlaceholder();

    // ───── 동기화 ─────
    const syncSec = section('동기화');
    const statusLine = node('p', 'hint');
    const skippedList = node('ul', 'hint');
    const syncMsg = node('div', 'storage-msg');
    const syncBtn = node('button', '', '지금 맞추기');
    const disableBtn = node('button', '', '로컬로 바꾸기');
    const syncButtons = node('div', 'ai-row');
    syncButtons.append(syncBtn, disableBtn);
    syncSec.append(statusLine, skippedList, syncMsg, syncButtons, node('p', 'hint', DISABLE_TEXT));
    box.append(syncSec);

    box.append(node('p', 'hint', HELP_TEXT));
    const buttons = node('div', 'buttons');
    const done = node('button', 'primary', '닫기');
    buttons.append(done);
    box.append(buttons);

    const render = () => {
      const isCloud = view.mode === 'cloud';
      dirPath.textContent = notesDir ?? '';
      dirPath.hidden = !notesDir;
      noDirHint.hidden = !!notesDir;
      pickDir.textContent = notesDir ? '폴더 바꾸기…' : '폴더 고르기…';
      pickDir.disabled = busy;
      localNote.hidden = cloudRadio.checked;
      localNote.textContent = isCloud
        ? `지금은 클라우드와 맞추고 있습니다. 아래 ‘로컬로 바꾸기’를 누르면 ${DISABLE_TEXT}`
        : '노트를 이 컴퓨터의 폴더에만 저장합니다.';
      cloudSec.hidden = !cloudRadio.checked;
      form.disabled = busy || isCloud;
      lockedHint.hidden = !isCloud;
      testBtn.disabled = busy;
      enableBtn.hidden = isCloud;
      enableBtn.disabled = busy || !notesDir;
      syncSec.hidden = !isCloud;
      const st = view.status;
      statusLine.textContent = syncStatusText(st, firstSync ? '올리는 중' : '맞추는 중');
      statusLine.classList.toggle('warn', st.state === 'error' || st.state === 'offline');
      const skipped = st.state === 'idle' ? st.skipped ?? [] : [];
      skippedList.hidden = skipped.length === 0;
      skippedList.replaceChildren(...skippedLines(skipped, 50).map((t) => node('li', '', t)));
      if (skipped.length) statusLine.textContent += ` · ${skipped.length}개 파일은 맞추지 못했습니다.`;
      syncBtn.disabled = busy || st.state === 'syncing';
      disableBtn.disabled = busy;
    };
    const setBusy = (on: boolean) => {
      busy = on;
      render();
    };
    const say = (el: HTMLElement, text: string, isError = false) => {
      el.textContent = text;
      el.classList.toggle('error', isError);
    };
    localRadio.onchange = render;
    cloudRadio.onchange = render;

    const unsubscribe = api.onCloudEvent((ev) => {
      // 대화상자를 Esc로 닫았으면 다음 소식에서 구독을 끊는다
      if (!box.isConnected) return unsubscribe();
      if (ev.type !== 'status') return;
      view = { ...view, status: ev.status };
      if (ev.status.state !== 'syncing') firstSync = false;
      render();
    });
    done.onclick = () => {
      unsubscribe();
      close();
    };

    pickDir.onclick = async () => {
      setBusy(true);
      try {
        const dir = await deps.changeNotesDir();
        if (dir) notesDir = dir;
        view = await api.getCloudSettings();
        if (view.mode === 'local') localRadio.checked = true;
      } catch (e) {
        say(formError, `노트 폴더를 바꾸지 못했습니다: ${errorMessage(e)}`, true);
      } finally {
        setBusy(false);
      }
    };

    const checkForm = () => {
      const values: CloudFormValues = {
        endpoint: inputs.endpoint.value,
        region: inputs.region.value,
        bucket: inputs.bucket.value,
        prefix: inputs.prefix.value,
        accessKeyId: inputs.accessKeyId.value,
        secret: inputs.secret.value,
        device: inputs.device.value,
        pathStyle: pathStyle.checked,
      };
      const res = validateCloudForm(values, view.hasSecret);
      say(formError, res.ok ? '' : res.message, !res.ok);
      if (!res.ok) inputs[res.field].focus();
      return res.ok ? res : null;
    };

    testBtn.onclick = async () => {
      const res = checkForm();
      if (!res) return;
      setBusy(true);
      say(testMsg, '확인 중…');
      try {
        const r = await api.testCloud(res.input, res.secret);
        say(testMsg, testResultText(r), !r.ok);
      } catch (e) {
        say(testMsg, `연결을 확인하지 못했습니다: ${errorMessage(e)}`, true);
      } finally {
        setBusy(false);
      }
    };

    enableBtn.onclick = async () => {
      if (!notesDir) return say(formError, NO_DIR_TEXT, true);
      const res = checkForm();
      if (!res) return;
      setBusy(true);
      say(testMsg, '확인하는 중…');
      let scope: string;
      try {
        const p = await api.previewCloud(res.input, res.secret);
        if (!p.ok) return say(testMsg, sentence(p.message), true);
        scope = previewLines(p.preview).join(' ');
        say(testMsg, '');
      } catch (e) {
        return say(testMsg, `확인하지 못했습니다: ${errorMessage(e)}`, true);
      } finally {
        setBusy(false);
      }
      const ok = await askConfirm(
        '클라우드로 바꾸기',
        `지금 노트 폴더(${notesDir})를 버킷과 합치고, 앞으로 이 폴더를 클라우드와 맞춥니다. ${scope} 파일을 지우는 일은 하지 않습니다.`,
        '클라우드로 바꾸기',
      );
      if (!ok) return;
      setBusy(true);
      say(testMsg, '연결을 확인하고 있습니다…');
      try {
        const r = await api.enableCloud(res.input, res.secret);
        if (!r.ok) return say(testMsg, sentence(r.message), true);
        firstSync = true;
        inputs.secret.value = '';
        view = await api.getCloudSettings();
        setSecretPlaceholder();
        say(testMsg, '클라우드로 바꿨습니다. 노트 폴더를 버킷에 올리고 있습니다.');
      } catch (e) {
        say(testMsg, `클라우드로 바꾸지 못했습니다: ${errorMessage(e)}`, true);
      } finally {
        setBusy(false);
      }
    };

    syncBtn.onclick = async () => {
      setBusy(true);
      say(syncMsg, '');
      try {
        await api.syncNow();
        view = await api.getCloudSettings();
      } catch (e) {
        say(syncMsg, `맞추지 못했습니다: ${errorMessage(e)}`, true);
      } finally {
        setBusy(false);
      }
    };

    disableBtn.onclick = async () => {
      setBusy(true);
      say(syncMsg, '');
      try {
        await api.disableCloud();
        view = await api.getCloudSettings();
        firstSync = false;
        localRadio.checked = true;
        say(testMsg, '');
      } catch (e) {
        say(syncMsg, `로컬로 바꾸지 못했습니다: ${errorMessage(e)}`, true);
      } finally {
        setBusy(false);
      }
    };

    render();
  });
}

/** 처음 실행할 때 노트를 이 컴퓨터 폴더에 둘지 클라우드와 맞출지 묻는다. 닫으면 null */
export function askStorageKind(): Promise<'local' | 'cloud' | null> {
  return new Promise((resolve) => {
    openModal((box, close) => {
      box.classList.add('storage-choice');
      box.append(node('h3', '', '노트를 어디에 둘까요?'));
      let done = false;
      const finish = (v: 'local' | 'cloud' | null) => {
        if (done) return;
        done = true;
        close();
        resolve(v);
      };
      const option = (title: string, desc: string, value: 'local' | 'cloud') => {
        const b = node('button', 'storage-option');
        b.append(node('strong', '', title), node('span', '', desc));
        b.onclick = () => finish(value);
        box.append(b);
        return b;
      };
      const first = option('이 컴퓨터의 폴더 (로컬)', '고른 폴더에만 저장합니다. 나중에 저장소 설정에서 클라우드로 바꿀 수 있습니다.', 'local');
      option(
        '클라우드 (S3 호환)',
        'R2·B2 같은 버킷을 거쳐 여러 기기에서 노트를 맞춥니다. 먼저 작업 사본을 둘 폴더를 고릅니다. 다른 PC에서 처음 연결한다면 빈 폴더를 고르세요.',
        'cloud',
      );
      const buttons = node('div', 'buttons');
      const cancel = node('button', '', '취소');
      cancel.onclick = () => finish(null);
      buttons.append(cancel);
      box.append(buttons);
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') finish(null);
      });
      queueMicrotask(() => first.focus());
    });
  });
}
