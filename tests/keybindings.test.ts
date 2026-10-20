// 단축키 변환, 표기, 충돌 검사, 사용자 설정 병합을 검사하는 단위 테스트
import { describe, expect, it } from 'vitest';
import {
  COMMANDS, RESERVED, acceleratorLabel, commandForInput, findConflict, inputToAccelerator, resolveBindings, toOverrides,
} from '../electron/keybindings';

const k = (code: string, mods: Partial<{ meta: boolean; control: boolean; alt: boolean; shift: boolean }> = {}) => ({
  code, meta: false, control: false, alt: false, shift: false, ...mods,
});

describe('키 입력 → accelerator', () => {
  it('물리 키와 수정키로 만든다', () => {
    expect(inputToAccelerator(k('KeyC', { meta: true, shift: true }))).toEqual({ accel: 'CmdOrCtrl+Shift+C' });
    expect(inputToAccelerator(k('KeyJ', { meta: true, alt: true }))).toEqual({ accel: 'CmdOrCtrl+Alt+J' });
    expect(inputToAccelerator(k('Digit1', { meta: true }))).toEqual({ accel: 'CmdOrCtrl+1' });
    expect(inputToAccelerator(k('ArrowUp', { control: true }))).toEqual({ accel: 'Ctrl+Up' });
  });
  it('F키와 Esc는 수정키 없이도 된다', () => {
    expect(inputToAccelerator(k('F7'))).toEqual({ accel: 'F7' });
    expect(inputToAccelerator(k('F7', { shift: true }))).toEqual({ accel: 'Shift+F7' });
  });
  it('글자 키만 누르거나 ⇧만 더하면 거부한다', () => {
    expect(inputToAccelerator(k('KeyA'))).toHaveProperty('error');
    expect(inputToAccelerator(k('KeyA', { shift: true }))).toHaveProperty('error');
  });
  it('수정키만 누르면 null', () => {
    expect(inputToAccelerator(k('MetaLeft', { meta: true }))).toBeNull();
  });
  it('윈도우에서는 Ctrl이 CmdOrCtrl이 된다', () => {
    expect(inputToAccelerator(k('KeyS', { control: true }), false)).toEqual({ accel: 'CmdOrCtrl+S' });
  });
});

describe('표기', () => {
  it('맥 기호 순서로 보여준다', () => {
    expect(acceleratorLabel('CmdOrCtrl+Shift+C')).toBe('⇧⌘C');
    expect(acceleratorLabel('CmdOrCtrl+Alt+Shift+Up')).toBe('⌥⇧⌘↑');
    expect(acceleratorLabel('CmdOrCtrl+Enter')).toBe('⌘↩');
    expect(acceleratorLabel('')).toBe('');
  });
  it('윈도우는 Ctrl+Alt+Shift+키 글자로 보여준다', () => {
    expect(acceleratorLabel('CmdOrCtrl+Shift+C', false)).toBe('Ctrl+Shift+C');
    expect(acceleratorLabel('CmdOrCtrl+Alt+Shift+Up', false)).toBe('Ctrl+Alt+Shift+↑');
    expect(acceleratorLabel('CmdOrCtrl+Enter', false)).toBe('Ctrl+Enter');
    expect(acceleratorLabel('Alt+Z', false)).toBe('Alt+Z');
    expect(acceleratorLabel('Shift+F7', false)).toBe('Shift+F7');
    expect(acceleratorLabel('CmdOrCtrl+,', false)).toBe('Ctrl+,');
    expect(acceleratorLabel('', false)).toBe('');
  });
});

describe('설정 병합과 충돌', () => {
  it('바꾼 것만 저장하고 다시 합친다', () => {
    const b = resolveBindings({ 'file:new': 'CmdOrCtrl+Shift+N', 'compare:next': '' });
    expect(b['file:new']).toBe('CmdOrCtrl+Shift+N');
    expect(b['compare:next']).toBe('');
    expect(b['file:open']).toBe('CmdOrCtrl+O');
    expect(toOverrides(b)).toEqual({ 'file:new': 'CmdOrCtrl+Shift+N', 'compare:next': '' });
  });
  it('같은 키를 쓰는 다른 명령을 찾는다', () => {
    const b = resolveBindings({});
    expect(findConflict(b, 'file:new', 'CmdOrCtrl+O')).toBe('file:open');
    expect(findConflict(b, 'file:open', 'CmdOrCtrl+O')).toBeNull();
  });
  it('기본 단축키끼리 겹치지 않는다', () => {
    const keys = COMMANDS.map((c) => c.key).filter(Boolean);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((k) => k in RESERVED)).toEqual([]);
  });
});

describe('키 입력 → 명령', () => {
  const b = resolveBindings({ 'notes:toggle-task': 'CmdOrCtrl+Right' });
  it('묶인 명령을 찾는다 (맥은 ⌘, 윈도우는 Ctrl)', () => {
    expect(commandForInput(b, k('KeyB', { meta: true }))).toBe('view:toggle-sidebar');
    expect(commandForInput(b, k('KeyB', { control: true }), false)).toBe('view:toggle-sidebar');
    expect(commandForInput(b, k('ArrowRight', { meta: true }))).toBe('notes:toggle-task');
    expect(commandForInput(b, k('F7'))).toBe('compare:next');
  });
  it('실행 취소·모두 선택은 편집기에 맡기고, 묶이지 않은 키와 글자 키는 null', () => {
    expect(commandForInput(b, k('KeyZ', { meta: true }))).toBeNull();
    expect(commandForInput(b, k('KeyA', { meta: true }))).toBeNull();
    expect(commandForInput(b, k('KeyB', { meta: true, alt: true, shift: true }))).toBeNull();
    expect(commandForInput(b, k('KeyB'))).toBeNull();
    expect(commandForInput(b, k('MetaLeft', { meta: true }))).toBeNull();
  });
});
