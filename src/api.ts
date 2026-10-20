// 데스크톱이면 Electron preload가 넣어 준 API를, 브라우저면 웹용 API를 쓴다
import { createWebApi } from './web/webApi';

export const api = window.aurora ?? createWebApi();
