// 지금 실행 중인 플랫폼(맥·윈도우·리눅스·웹)을 알려 주는 상수

const native = window.aurora?.platform;

export const PLATFORM: 'mac' | 'win' | 'linux' | 'web' =
  native === 'darwin' ? 'mac' : native === 'win32' ? 'win' : native ? 'linux' : 'web';

/** 단축키를 ⌘ 기호로 보일지. 웹은 브라우저가 돌고 있는 운영체제를 따른다 */
export const IS_MAC = PLATFORM === 'mac' || (PLATFORM === 'web' && /Mac/.test(navigator.userAgent));
