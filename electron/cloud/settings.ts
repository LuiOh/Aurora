// 화면이 보낸 클라우드 설정을 검사·정리하고, 동기화 상태 파일을 고를 열쇠를 만드는 순수 함수
import { createHash } from 'node:crypto';
import { normalizePrefix } from './keys';
import type { CloudConfig, CloudSettingsInput } from './types';

export type ParsedSettings = { ok: true; cfg: CloudSettingsInput } | { ok: false; message: string };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function parseCloudInput(raw: unknown, defaultDevice: string): ParsedSettings {
  if (typeof raw !== 'object' || raw === null) return { ok: false, message: '클라우드 설정이 비어 있습니다' };
  const r = raw as Record<string, unknown>;
  const endpoint = str(r.endpoint);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, message: '엔드포인트 주소가 올바르지 않습니다' };
  }
  // 비밀 키로 서명한 요청이 평문으로 나가지 않게 http는 이 컴퓨터 주소에만 허용한다 (화면 검사와 같은 규칙)
  const local = LOCAL_HOSTS.has(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    return { ok: false, message: '엔드포인트는 https:// 주소여야 합니다. http는 이 컴퓨터(localhost)에서만 쓸 수 있습니다' };
  }
  const bucket = str(r.bucket);
  if (!bucket) return { ok: false, message: '버킷 이름을 넣으세요' };
  const accessKeyId = str(r.accessKeyId);
  if (!accessKeyId) return { ok: false, message: '액세스 키 ID를 넣으세요' };
  return {
    ok: true,
    cfg: {
      endpoint,
      region: str(r.region) || 'auto',
      bucket,
      prefix: normalizePrefix(str(r.prefix)),
      accessKeyId,
      pathStyle: r.pathStyle === true,
      device: str(r.device) || defaultDevice,
    },
  };
}

export const toClientConfig = (cfg: CloudSettingsInput, secretAccessKey: string): CloudConfig => ({
  endpoint: cfg.endpoint,
  region: cfg.region,
  bucket: cfg.bucket,
  prefix: cfg.prefix,
  accessKeyId: cfg.accessKeyId,
  secretAccessKey,
  pathStyle: cfg.pathStyle,
});

/** 같은 버킷·접두사·노트 폴더 조합은 같은 상태 파일을 쓴다 */
export function stateFileName(cfg: Pick<CloudConfig, 'endpoint' | 'bucket' | 'prefix'>, notesDir: string): string {
  const id = [cfg.endpoint.trim().replace(/\/+$/, ''), cfg.bucket, normalizePrefix(cfg.prefix), notesDir].join('|');
  return `state-${createHash('sha256').update(id).digest('hex')}.json`;
}

export interface StorageSettings { mode: 'local' | 'cloud'; cloud: CloudSettingsInput | null }

/** config.json의 storage 값을 읽는다. 모르는 값이면 지금처럼 로컬 모드다 */
export function readStorage(raw: unknown, defaultDevice: string): StorageSettings {
  if (typeof raw !== 'object' || raw === null) return { mode: 'local', cloud: null };
  const r = raw as Record<string, unknown>;
  const parsed = parseCloudInput(r.cloud, defaultDevice);
  const cloud = parsed.ok ? parsed.cfg : null;
  return { mode: r.mode === 'cloud' && cloud ? 'cloud' : 'local', cloud };
}
