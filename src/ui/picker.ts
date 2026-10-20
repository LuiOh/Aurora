// 입력하는 대로 목록을 걸러 고르는 대화상자. 노트 빠르게 열기와 노트 전체 검색이 함께 쓴다
import { openModal } from './modal';

export interface PickerItem<T> {
  label: string;
  /** 굵게 표시할 label 안의 [시작, 끝) 위치 */
  matches?: [number, number][];
  sub?: string;
  data: T;
}

export interface PickerOptions<T> {
  title: string;
  placeholder: string;
  help: string;
  initial?: string;
  /** 검색어가 바뀔 때마다 부른다. 노트 수천 개를 훑을 수 있어 입력을 잠깐 모았다가 부른다 */
  search: (query: string) => PickerItem<T>[];
  /** shift는 ⇧Enter로 골랐는지. 목록이 비어 있으면 item 없이 부른다 */
  onPick: (item: PickerItem<T> | null, query: string, shift: boolean) => void;
}

function highlight(el: HTMLElement, text: string, matches: [number, number][] = []) {
  let pos = 0;
  for (const [s, e] of matches) {
    if (s > pos) el.append(text.slice(pos, s));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(s, e);
    el.append(mark);
    pos = e;
  }
  el.append(text.slice(pos));
}

export function openPicker<T>(opts: PickerOptions<T>) {
  openModal((box, close) => {
    box.classList.add('picker');
    box.innerHTML = `<h3></h3><input type="text" /><div class="picker-list"></div><div class="picker-help"></div>`;
    box.querySelector('h3')!.textContent = opts.title;
    box.querySelector('.picker-help')!.textContent = opts.help;
    const input = box.querySelector('input')!;
    const list = box.querySelector<HTMLDivElement>('.picker-list')!;
    input.placeholder = opts.placeholder;
    input.value = opts.initial ?? '';
    let items: PickerItem<T>[] = [];
    let sel = 0;

    const render = () => {
      list.innerHTML = '';
      items.forEach((it, i) => {
        const el = document.createElement('div');
        el.className = 'picker-item' + (i === sel ? ' sel' : '');
        const label = document.createElement('div');
        highlight(label, it.label, it.matches);
        el.append(label);
        if (it.sub) {
          const sub = document.createElement('div');
          sub.className = 'sub';
          sub.textContent = it.sub;
          el.append(sub);
        }
        el.onmousedown = (e) => {
          e.preventDefault();
          pick(i, e.shiftKey);
        };
        list.append(el);
      });
      list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    };
    const pick = (i: number, shift: boolean) => {
      close();
      opts.onPick(items[i] ?? null, input.value, shift);
    };
    let timer: number | undefined;
    const refresh = () => {
      items = opts.search(input.value);
      sel = 0;
      render();
    };
    input.oninput = () => {
      clearTimeout(timer);
      timer = window.setTimeout(refresh, 60);
    };
    input.onkeydown = (e) => {
      // 한글 조합 중 Enter는 글자 확정이므로 고르지 않는다
      if (e.isComposing) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (items.length) sel = (sel + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        render();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(timer);
        // 입력 직후 Enter를 눌러도 최신 검색어로 고르게 한다
        items = opts.search(input.value);
        pick(Math.min(sel, items.length - 1), e.shiftKey);
      }
    };
    refresh();
    setTimeout(() => input.select());
  });
}
