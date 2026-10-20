// 브라우저에는 앱 메뉴가 없으므로 ☰ 버튼을 누르면 띄우는 HTML 메뉴 (웹 버전용)
import { COMMANDS, acceleratorLabel } from '../../electron/keybindings';

const GROUP_ORDER = ['File', 'Edit', 'View', 'Compare', 'Tools', 'Notes', 'Aurora'];

export function openWebMenu(x: number, y: number, bindings: Record<string, string>, isMac: boolean, onPick: (id: string) => void) {
  document.querySelector('.web-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'web-menu';
  for (const group of GROUP_ORDER) {
    const items = COMMANDS.filter((c) => c.group === group);
    if (items.length === 0) continue;
    const head = document.createElement('div');
    head.className = 'web-menu-group';
    head.textContent = group === 'Aurora' ? '설정' : group;
    menu.append(head);
    for (const c of items) {
      const row = document.createElement('div');
      row.className = 'web-menu-item';
      row.innerHTML = '<span></span><span class="key"></span>';
      row.children[0].textContent = c.label;
      row.children[1].textContent = acceleratorLabel(bindings[c.id] ?? '', isMac);
      row.onclick = () => {
        close();
        onPick(c.id);
      };
      menu.append(row);
    }
  }
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.append(menu);
  // 화면 아래로 넘치면 높이를 줄여 스크롤하게 한다
  menu.style.maxHeight = `${window.innerHeight - y - 12}px`;

  const onDown = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  function close() {
    menu.remove();
    window.removeEventListener('mousedown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
  }
  setTimeout(() => {
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
  });
}
