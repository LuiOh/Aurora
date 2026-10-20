// 개발 모드 실행 스크립트. Electron 코드를 컴파일하고 Vite 개발 서버를 띄운 뒤 Electron을 연다
import { createServer } from 'vite';
import { spawn, execSync } from 'node:child_process';
import electronPath from 'electron';

execSync('npx tsc -p tsconfig.electron.json', { stdio: 'inherit' });

const server = await createServer();
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`Vite 개발 서버: ${url}`);

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});
child.on('close', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
