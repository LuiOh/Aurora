// AI API 키와 클라우드 저장소 비밀 키를 운영체제 암호화(safeStorage)로 감싸 userData/secrets.json에 저장·조회하는 모듈
import { app, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PROVIDERS, type Provider } from './ai/types';
import { isProvider, keyStorageLevel, type AiKeyStatus, type KeyStorage } from './aiShared';
import { createSerialQueue } from './serialQueue';

/** AI 공급자 키와 클라우드(S3) 비밀 키 */
export type SecretName = Provider | 'cloud';
type SecretFile = Partial<Record<SecretName, string>>;

const isSecretName = (k: string): k is SecretName => k === 'cloud' || isProvider(k);

const secretsPath = () => path.join(app.getPath('userData'), 'secrets.json');

async function readSecrets(): Promise<SecretFile> {
  let raw: string;
  try {
    raw = await readFile(secretsPath(), 'utf8');
  } catch {
    return {}; // 아직 저장한 키가 없다
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return {}; // 깨진 파일은 빈 것으로 본다
  }
  const out: SecretFile = {};
  if (typeof json === 'object' && json !== null) {
    for (const [k, v] of Object.entries(json)) if (isSecretName(k) && typeof v === 'string') out[k] = v;
  }
  return out;
}

/** 임시 파일에 쓴 뒤 이름을 바꿔 한 번에 갈아 끼운다 */
async function writeSecrets(data: SecretFile): Promise<void> {
  const tmp = path.join(app.getPath('userData'), `secrets.${randomUUID()}.tmp`);
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(tmp, secretsPath());
}

export async function storageLevel(): Promise<KeyStorage> {
  const available = await safeStorage.isAsyncEncryptionAvailable();
  const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : '';
  return keyStorageLevel(available, process.platform, backend);
}

export async function keyStatus(): Promise<AiKeyStatus> {
  const data = await readSecrets();
  const keys = Object.fromEntries(PROVIDERS.map((p) => [p, Boolean(data[p])])) as Record<Provider, boolean>;
  return { storage: await storageLevel(), keys };
}

export async function hasKey(name: SecretName): Promise<boolean> {
  return Boolean((await readSecrets())[name]);
}

// secrets.json을 읽고 고쳐 쓰는 작업은 겹치면 한쪽 키가 사라지므로 한 줄로 세운다
const writes = createSerialQueue();

/** 암호화를 쓸 수 없으면 false를 돌려주고 저장하지 않는다 */
export async function saveKey(provider: SecretName, key: string): Promise<boolean> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
  const enc = await safeStorage.encryptStringAsync(key);
  await writes.run(async () => writeSecrets({ ...(await readSecrets()), [provider]: enc.toString('base64') }));
  return true;
}

export function deleteKey(provider: SecretName): Promise<void> {
  return writes.run(async () => {
    const data = await readSecrets();
    if (!(provider in data)) return;
    delete data[provider];
    await writeSecrets(data);
  });
}

/** 키는 저장돼 있지만 키체인 거부 등으로 풀지 못했을 때 loadKey가 던진다 */
export class KeyDecryptError extends Error {
  constructor() {
    super('저장된 키를 풀지 못했습니다');
    this.name = 'KeyDecryptError';
  }
}

/** 저장된 키를 풀어 돌려준다. 없으면 null, 있는데 풀 수 없으면 KeyDecryptError. 키가 교체되었으면 다시 암호화해 둔다 */
export async function loadKey(provider: SecretName): Promise<string | null> {
  const enc = (await readSecrets())[provider];
  if (!enc) return null;
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new KeyDecryptError();
  let result: string;
  let shouldReEncrypt: boolean;
  try {
    ({ result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(enc, 'base64')));
  } catch (err) {
    console.error('저장된 키 복호화 실패', provider, err instanceof Error ? err.name : 'unknown');
    throw new KeyDecryptError();
  }
  if (shouldReEncrypt) {
    await saveKey(provider, result).catch((err: unknown) => {
      console.error('저장된 키 다시 암호화 실패', provider, err instanceof Error ? err.name : 'unknown');
    });
  }
  return result;
}
