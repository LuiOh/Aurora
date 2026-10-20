// 메뉴 명령마다 단축키를 바꾸고, 지우고, 기본값으로 되돌리는 단축키 설정 대화상자
import {
  COMMANDS, RESERVED, acceleratorLabel, findConflict, inputToAccelerator, resolveBindings, toOverrides,
  type KeyInput,
} from '../../electron/keybindings';
import { IS_MAC } from '../platform';
import { api } from '../api';

const labelOf = (id: string) => COMMANDS.find((c) => c.id === id)?.label ?? id;

// 메인 프로세스가 넘겨주는 키 입력을 지금 키를 기다리는 항목에 전달한다
let onKey: ((input: KeyInput) => void) | null = null;
api.onKeyPressed((input) => onKey?.(input));

/** 대화상자를 열고, 저장하면 새 단축키 전체를 돌려준다. 취소하면 null */
export async function openKeybindings(): Promise<Record<string, string> | null> {
  const working = resolveBindings(await api.getKeyOverrides());
  let recordingId: string | null = null;

  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const box = document.createElement('div');
    box.className = 'modal keybindings';
    backdrop.appendChild(box);
    box.innerHTML = `
      <h3>단축키 설정</h3>
      <div class="kb-help">키 칸을 누른 뒤 원하는 키 조합을 누르세요. Esc를 누르면 입력을 취소합니다.</div>
      <div class="kb-list"></div>
      <div class="kb-msg"></div>
      <div class="buttons">
        <button name="reset-all">모두 기본값</button>
        <span style="flex:1"></span>
        <button name="cancel">취소</button>
        <button class="primary" name="save">저장</button>
      </div>`;
    const list = box.querySelector('.kb-list')!;
    const msg = (text: string, error = false) => {
      const el = box.querySelector('.kb-msg') as HTMLElement;
      el.textContent = text;
      el.classList.toggle('error', error);
    };

    const stopRecording = () => {
      recordingId = null;
      onKey = null;
      api.recordKeys(false);
    };

    const render = () => {
      list.innerHTML = '';
      let group = '';
      for (const c of COMMANDS) {
        if (c.group !== group) {
          group = c.group;
          const h = document.createElement('div');
          h.className = 'kb-group';
          h.textContent = group;
          list.appendChild(h);
        }
        const row = document.createElement('div');
        row.className = 'kb-row';
        const changed = working[c.id] !== c.key;
        row.innerHTML = `
          <span class="kb-label"></span>
          <button class="kb-key${recordingId === c.id ? ' recording' : ''}${changed ? ' changed' : ''}"></button>
          <button class="kb-small" name="clear" title="단축키 지우기">지우기</button>
          <button class="kb-small" name="reset" title="기본값 ${acceleratorLabel(c.key, IS_MAC) || '없음'}" ${changed ? '' : 'disabled'}>기본값</button>`;
        row.querySelector('.kb-label')!.textContent = c.label;
        const keyBtn = row.querySelector('.kb-key') as HTMLButtonElement;
        keyBtn.textContent = recordingId === c.id ? '키를 누르세요…' : acceleratorLabel(working[c.id], IS_MAC) || '없음';
        keyBtn.onclick = () => startRecording(c.id);
        (row.querySelector('[name="clear"]') as HTMLButtonElement).onclick = () => {
          stopRecording();
          working[c.id] = '';
          render();
        };
        (row.querySelector('[name="reset"]') as HTMLButtonElement).onclick = () => {
          stopRecording();
          assign(c.id, c.key);
        };
        list.appendChild(row);
      }
    };

    /** 키를 주고, 같은 키를 쓰던 다른 명령에서는 뺀다 */
    const assign = (id: string, accel: string) => {
      const other = findConflict(working, id, accel);
      if (other) working[other] = '';
      working[id] = accel;
      msg(other ? `"${labelOf(other)}"에 쓰던 ${acceleratorLabel(accel, IS_MAC)}를 "${labelOf(id)}"로 옮겼습니다.` : '');
      render();
    };

    const startRecording = (id: string) => {
      recordingId = id;
      msg(`"${labelOf(id)}"에 쓸 키를 누르세요.`);
      render();
      api.recordKeys(true);
      onKey = (input) => {
        const plainEsc = input.code === 'Escape' && !input.meta && !input.control && !input.alt && !input.shift;
        if (plainEsc) {
          stopRecording();
          msg('');
          return render();
        }
        const res = inputToAccelerator(input, IS_MAC);
        if (!res) return; // 수정키만 누른 상태
        if ('error' in res) return msg(res.error, true);
        if (RESERVED[res.accel]) return msg(`${acceleratorLabel(res.accel, IS_MAC)}는 "${RESERVED[res.accel]}"가 쓰는 키라 바꿀 수 없습니다.`, true);
        stopRecording();
        assign(id, res.accel);
      };
    };

    const finish = async (save: boolean) => {
      stopRecording();
      if (save) await api.setKeyOverrides(toOverrides(working));
      backdrop.remove();
      resolve(save ? working : null);
    };

    (box.querySelector('[name="save"]') as HTMLButtonElement).onclick = () => void finish(true);
    (box.querySelector('[name="cancel"]') as HTMLButtonElement).onclick = () => void finish(false);
    (box.querySelector('[name="reset-all"]') as HTMLButtonElement).onclick = () => {
      stopRecording();
      for (const c of COMMANDS) working[c.id] = c.key;
      msg('모든 단축키를 기본값으로 되돌렸습니다. 저장을 눌러야 적용됩니다.');
      render();
    };
    backdrop.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !recordingId) void finish(false);
    });

    render();
    document.body.appendChild(backdrop);
    (box.querySelector('[name="save"]') as HTMLButtonElement).focus();
  });
}
