// 번호 넣기 옵션, 비교 대상 탭, 새 노트 이름, 노트 저장 위치를 묻는 간단한 모달 대화상자
import { parseNumberingInput, type NumberingOptions } from '../lib/numbering';
import { INVALID_NAME_CHARS, folderFromInput, type NoteFolders } from '../lib/noteKinds';
import { NOTE_FORMATS, splitKnownExtension } from '../../electron/fileTypes';

export function openModal(build:(box: HTMLDivElement, close: () => void) => void) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const box = document.createElement('div');
  box.className = 'modal';
  backdrop.appendChild(box);
  const close = () => backdrop.remove();
  backdrop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
  build(box, close);
  document.body.appendChild(backdrop);
  box.querySelector<HTMLElement>('input, select')?.focus();
}

/** 확인 대화상자. 처음에는 취소 버튼에 포커스를 둬서 Enter로 잘못 고르지 않게 한다 */
export function askConfirm(title: string, message: string, okLabel: string, cancelLabel = '취소'): Promise<boolean> {
  return new Promise((resolve) => {
    openModal((box, close) => {
      box.classList.add('confirm');
      const h = document.createElement('h3');
      h.textContent = title;
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = message;
      const buttons = document.createElement('div');
      buttons.className = 'buttons';
      const cancel = document.createElement('button');
      cancel.textContent = cancelLabel;
      const ok = document.createElement('button');
      ok.className = 'primary';
      ok.textContent = okLabel;
      buttons.append(cancel, ok);
      box.append(h, p, buttons);
      let done = false;
      const finish = (v: boolean) => {
        if (done) return;
        done = true;
        close();
        resolve(v);
      };
      ok.onclick = () => finish(true);
      cancel.onclick = () => finish(false);
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') finish(false);
      });
      queueMicrotask(() => cancel.focus());
    });
  });
}

export function askNumbering(count: number): Promise<NumberingOptions | null> {
  return new Promise((resolve) => {
    openModal((box, close) => {
      box.innerHTML = `
        <h3>번호 넣기 (${count}곳)</h3>
        <label>시작값 <input type="text" name="start" value="1" /></label>
        <label>증가값 <input type="text" name="step" value="1" /></label>
        <label>자릿수 맞춰 0 채우기 <input type="checkbox" name="pad" /></label>
        <div class="error"></div>
        <div class="buttons"><button name="cancel">취소</button><button class="primary" name="ok">넣기</button></div>`;
      const q = (n: string) => box.querySelector(`[name="${n}"]`) as HTMLInputElement;
      const finish = (v: NumberingOptions | null) => { close(); resolve(v); };
      const submit = () => {
        const opts = parseNumberingInput(q('start').value, q('step').value, q('pad').checked);
        if (!opts) {
          box.querySelector('.error')!.textContent = '시작값과 증가값은 정수여야 합니다.';
          return;
        }
        finish(opts);
      };
      q('ok').onclick = submit;
      q('cancel').onclick = () => finish(null);
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
        if (e.key === 'Escape') finish(null);
      });
    });
  });
}

export function askTab(options: { id: number; title: string }[]): Promise<number | null> {
  return new Promise((resolve) => {
    openModal((box, close) => {
      box.innerHTML = `
        <h3>비교할 탭 선택</h3>
        <select name="tab" size="${Math.min(10, Math.max(2, options.length))}"></select>
        <div class="buttons"><button name="cancel">취소</button><button class="primary" name="ok">비교</button></div>`;
      const select = box.querySelector('select')!;
      for (const o of options) select.add(new Option(o.title, String(o.id)));
      select.selectedIndex = 0;
      const finish = (v: number | null) => { close(); resolve(v); };
      const submit = () => finish(select.value ? Number(select.value) : null);
      (box.querySelector('[name="ok"]') as HTMLButtonElement).onclick = submit;
      (box.querySelector('[name="cancel"]') as HTMLButtonElement).onclick = () => finish(null);
      select.ondblclick = submit;
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
        if (e.key === 'Escape') finish(null);
      });
    });
  });
}

/** 새 노트 이름과 형식(확장자)을 묻는다. 이름 끝에 아는 확장자를 치면 형식을 그것으로 바꾸고 이름에서는 뗀다 */
export function askNoteName(
  title = '새 노트',
  example = '주제/바이닉 문진 서비스',
  defaultExt = 'md',
): Promise<{ name: string; ext: string } | null> {
  return new Promise((resolve) => {
    openModal((box, close) => {
      box.innerHTML = `
        <h3>${title}</h3>
        <label>이름 <input type="text" name="name" placeholder="예: ${example}" /></label>
        <label>형식 <select name="ext"></select></label>
        <div class="error"></div>
        <div class="buttons"><button name="cancel">취소</button><button class="primary" name="ok">만들기</button></div>`;
      const input = box.querySelector('[name="name"]') as HTMLInputElement;
      const select = box.querySelector('[name="ext"]') as HTMLSelectElement;
      for (const f of NOTE_FORMATS) select.add(new Option(f.label, f.ext));
      const pick = (ext: string) => {
        if (![...select.options].some((o) => o.value === ext)) select.add(new Option(`.${ext}`, ext));
        select.value = ext;
      };
      pick(defaultExt);
      input.addEventListener('input', () => {
        const { ext } = splitKnownExtension(input.value.trim());
        if (ext) pick(ext);
      });
      const finish = (v: { name: string; ext: string } | null) => { close(); resolve(v); };
      const submit = () => {
        const typed = input.value.trim().replace(/^\/+|\/+$/g, '');
        const { base, ext } = splitKnownExtension(typed);
        if (ext) pick(ext);
        const name = base.trim();
        if (!name) {
          box.querySelector('.error')!.textContent = '이름을 입력하세요. 폴더/이름 형식으로 폴더 안에 만들 수 있습니다.';
          return;
        }
        if (name.split('/').some((p) => INVALID_NAME_CHARS.test(p) || p.trim().startsWith('.') || p.trim() === '')) {
          box.querySelector('.error')!.textContent = '이름에 < > : " | ? * 같은 윈도우에서 못 쓰는 글자나 .으로 시작하는 부분이 있습니다.';
          return;
        }
        finish({ name, ext: select.value });
      };
      (box.querySelector('[name="ok"]') as HTMLButtonElement).onclick = submit;
      (box.querySelector('[name="cancel"]') as HTMLButtonElement).onclick = () => finish(null);
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) submit();
        if (e.key === 'Escape') finish(null);
      });
    });
  });
}

export function askFolders(
  current: NoteFolders,
  root: string,
  chooseFolder: ((defaultPath: string) => Promise<string | null>) | null,
): Promise<NoteFolders | null> {
  return new Promise((resolve) => {
    openModal((box, close) => {
      const keys = ['daily', 'topic', 'moc'] as const;
      const labels = { daily: '날짜 노트', topic: '주제 노트', moc: '목차 노트' };
      box.classList.add('folders');
      box.innerHTML = `
        <h3>노트 저장 위치</h3>
        <p class="hint">노트 폴더 <code></code> 안의 폴더를 전체 경로로 정합니다. 이미 있는 노트는 옮기지 않습니다.</p>
        ${keys.map((k) => `<label>${labels[k]} <span class="path-row"><input type="text" name="${k}" />${chooseFolder ? `<button name="pick-${k}">찾아보기…</button>` : ''}</span></label>`).join('')}
        <div class="error"></div>
        <div class="buttons"><button name="cancel">취소</button><button class="primary" name="ok">저장</button></div>`;
      box.querySelector('.hint code')!.textContent = root;
      const q = (n: string) => box.querySelector(`[name="${n}"]`) as HTMLInputElement;
      for (const k of keys) {
        q(k).value = `${root}/${current[k]}`;
        const pick = box.querySelector(`[name="pick-${k}"]`) as HTMLButtonElement | null;
        if (pick && chooseFolder) {
          pick.onclick = async () => {
            const p = await chooseFolder(q(k).value);
            if (p) q(k).value = p;
          };
        }
      }
      const finish = (v: NoteFolders | null) => { close(); resolve(v); };
      const submit = () => {
        const out = { ...current };
        for (const k of keys) {
          const res = folderFromInput(root, q(k).value);
          if ('error' in res) {
            box.querySelector('.error')!.textContent = `${labels[k]}: ${res.error}`;
            return q(k).focus();
          }
          out[k] = res.folder;
        }
        finish(out);
      };
      (box.querySelector('[name="ok"]') as HTMLButtonElement).onclick = submit;
      (box.querySelector('[name="cancel"]') as HTMLButtonElement).onclick = () => finish(null);
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing && (e.target as HTMLElement).tagName === 'INPUT') submit();
        if (e.key === 'Escape') finish(null);
      });
    });
  });
}
