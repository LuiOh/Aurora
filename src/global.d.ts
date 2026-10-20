// preload가 window에 노출한 aurora API의 타입 선언
import type { AuroraApi } from '../electron/preload';

declare global {
  interface Window {
    /** 데스크톱 앱에서만 있다. 브라우저에서는 src/api.ts가 웹용 API로 대신한다 */
    aurora?: AuroraApi;
  }
}

export {};
