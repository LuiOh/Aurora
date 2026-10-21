// 저장소 설정 창의 서비스별 기본값, 입력 검사, 연결 확인·동기화 상태 문구를 만드는 순수 함수
import type { CloudPreview, CloudSettingsInput, CloudStatus, CloudTestResult } from '../../electron/cloud/types';

export type PresetId = 'r2' | 'b2' | 'aws' | 'other';

export interface Preset {
  id: PresetId;
  label: string;
  /** 고르면 엔드포인트 칸에 넣을 값. 계정마다 다르면 빈 값으로 두고 예시만 보인다 */
  endpoint: string;
  endpointPlaceholder: string;
  region: string;
  regionPlaceholder: string;
  pathStyle: boolean;
}

export const PRESETS: Preset[] = [
  {
    id: 'r2', label: 'Cloudflare R2 (추천 · 10GB 무료)',
    endpoint: '', endpointPlaceholder: 'https://<계정 ID>.r2.cloudflarestorage.com',
    region: 'auto', regionPlaceholder: 'auto', pathStyle: true,
  },
  {
    id: 'b2', label: 'Backblaze B2 (카드 없이 10GB 무료)',
    endpoint: '', endpointPlaceholder: 'https://s3.<region>.backblazeb2.com',
    region: '', regionPlaceholder: '엔드포인트의 <region> 부분 (예: us-west-004)', pathStyle: true,
  },
  {
    id: 'aws', label: 'AWS S3',
    endpoint: 'https://s3.ap-northeast-2.amazonaws.com', endpointPlaceholder: 'https://s3.<region>.amazonaws.com',
    region: 'ap-northeast-2', regionPlaceholder: 'ap-northeast-2', pathStyle: false,
  },
  {
    id: 'other', label: 'MinIO · 기타 S3 호환',
    endpoint: '', endpointPlaceholder: 'https://minio.example.com',
    region: 'us-east-1', regionPlaceholder: 'us-east-1', pathStyle: true,
  },
];

export const presetById = (id: PresetId): Preset => PRESETS.find((p) => p.id === id) ?? PRESETS[0];

const hostOf = (endpoint: string): string | null => {
  try {
    return new URL(endpoint.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/** 저장된 엔드포인트로 어느 서비스인지 짐작한다 */
export function guessPreset(endpoint: string): PresetId {
  const host = hostOf(endpoint) ?? '';
  if (host.endsWith('.r2.cloudflarestorage.com')) return 'r2';
  if (host.endsWith('.backblazeb2.com')) return 'b2';
  if (host.endsWith('.amazonaws.com')) return 'aws';
  return 'other';
}

/** 엔드포인트 주소에서 리전을 읽는다. B2·AWS는 주소 안의 리전, R2는 auto. 알 수 없으면 null */
export function regionFromEndpoint(endpoint: string): string | null {
  const host = hostOf(endpoint);
  if (!host) return null;
  if (host.endsWith('.r2.cloudflarestorage.com')) return 'auto';
  const b2 = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/.exec(host);
  if (b2) return b2[1];
  const aws = /^s3[.-]([a-z0-9-]+)\.amazonaws\.com$/.exec(host);
  if (aws && aws[1] !== 'external-1') return aws[1];
  return null;
}

export interface CloudFormValues {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secret: string;
  device: string;
  pathStyle: boolean;
}

export type CloudFormField = 'endpoint' | 'region' | 'bucket' | 'prefix' | 'accessKeyId' | 'secret';

export type CloudFormResult =
  | { ok: true; input: CloudSettingsInput; secret?: string }
  | { ok: false; field: CloudFormField; message: string };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** S3 버킷 이름 규칙에 어긋나면 그 까닭을, 맞으면 null을 돌려준다 */
export function bucketError(name: string): string | null {
  if (!name) return '버킷 이름을 넣으세요.';
  if (name.length < 3 || name.length > 63) return '버킷 이름은 3~63자여야 합니다.';
  if (!/^[a-z0-9.-]+$/.test(name)) return '버킷 이름에는 영어 소문자, 숫자, 하이픈(-), 점(.)만 쓸 수 있습니다.';
  if (!/^[a-z0-9]/.test(name) || !/[a-z0-9]$/.test(name)) return '버킷 이름은 영어 소문자나 숫자로 시작하고 끝나야 합니다.';
  if (name.includes('..')) return '버킷 이름에 점을 잇달아 쓸 수 없습니다.';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return '버킷 이름을 IP 주소 모양으로 쓸 수 없습니다.';
  return null;
}

/** 입력을 검사해 메인 프로세스에 보낼 설정으로 바꾼다. 비밀 키는 이미 저장돼 있으면 비워도 된다 */
export function validateCloudForm(v: CloudFormValues, hasSecret: boolean): CloudFormResult {
  const fail = (field: CloudFormField, message: string): CloudFormResult => ({ ok: false, field, message });
  const endpoint = v.endpoint.trim().replace(/\/+$/, '');
  if (!endpoint) return fail('endpoint', '엔드포인트 주소를 넣으세요.');
  if (/[<>]/.test(endpoint)) return fail('endpoint', '엔드포인트의 <…> 부분을 실제 값으로 바꾸세요.');
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return fail('endpoint', '엔드포인트 주소가 올바르지 않습니다. https://로 시작하는 주소를 넣으세요.');
  }
  const local = LOCAL_HOSTS.has(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    return fail('endpoint', '엔드포인트는 https:// 주소여야 합니다. http는 이 컴퓨터(localhost)에서만 쓸 수 있습니다.');
  }
  const region = v.region.trim();
  if (!region) return fail('region', '리전을 넣으세요.');
  const bucket = v.bucket.trim();
  const bErr = bucketError(bucket);
  if (bErr) return fail('bucket', bErr);
  const prefix = v.prefix.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (prefix && prefix.split('/').some((p) => p === '' || p === '.' || p === '..')) {
    return fail('prefix', '폴더 이름에 빈 칸이나 . 또는 .. 부분을 쓸 수 없습니다.');
  }
  const accessKeyId = v.accessKeyId.trim();
  if (!accessKeyId) return fail('accessKeyId', 'Access Key ID를 넣으세요.');
  const secret = v.secret.trim();
  if (!secret && !hasSecret) return fail('secret', 'Secret Access Key를 넣으세요.');
  return {
    ok: true,
    input: { endpoint, region, bucket, prefix, accessKeyId, pathStyle: v.pathStyle, device: v.device.trim() },
    secret: secret || undefined,
  };
}

/** 메인이 돌려준 오류 문구 끝에 마침표를 붙인다 */
export const sentence = (msg: string): string => (/[.?!。]$/.test(msg.trim()) ? msg.trim() : `${msg.trim()}.`);

export function testResultText(res: CloudTestResult): string {
  if (!res.ok) return sentence(res.message);
  const guard = res.conditionalWrites
    ? '동시 저장 보호 지원'
    : '동시 저장 보호 미지원 (두 기기가 동시에 저장하면 충돌 사본이 생길 수 있습니다)';
  return `연결됨 · 객체 ${res.objectCount}개 · ${guard}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 시:분 (예: 09:05) */
export const clockText = (ms: number): string => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 마지막으로 맞춘 때. 오늘이면 "오늘 09:05", 아니면 "10월 20일 09:05" */
export function syncTimeText(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const n = new Date(now);
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return `${sameDay ? '오늘' : `${d.getMonth() + 1}월 ${d.getDate()}일`} ${clockText(ms)}`;
}

/** 설정 창에 보일 동기화 상태 한 줄. verb는 진행 중일 때 쓸 말(첫 동기화는 "올리는 중") */
export function syncStatusText(s: CloudStatus, verb = '맞추는 중', now = Date.now()): string {
  switch (s.state) {
    case 'off': return '클라우드와 맞추지 않습니다.';
    case 'syncing': return s.progress && s.progress.total > 0 ? `${verb} ${s.progress.done}/${s.progress.total}` : `${verb}…`;
    case 'offline': return `오프라인입니다. 연결되면 다시 맞춥니다.${s.message ? ` (${s.message})` : ''}`;
    case 'error': return `오류: ${sentence(s.message ?? '알 수 없는 오류')}`;
    case 'idle': return s.lastSync ? `맞춰져 있습니다 · 마지막으로 맞춘 때 ${syncTimeText(s.lastSync, now)}` : '맞춰져 있습니다.';
  }
}

/** 사람이 읽는 크기 (예: 34 MB, 512 KB, 120 B) */
export function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export const MANY_UPLOAD_FILES = 500;
export const MANY_UPLOAD_BYTES = 200 * 1024 * 1024;

/** 클라우드로 바꾸기 확인 창에 보일 첫 동기화 규모 문장들 */
export function previewLines(p: CloudPreview): string[] {
  const lines = [`올릴 파일 ${p.upload.count}개 (${sizeText(p.upload.bytes)}) · 받을 파일 ${p.download.count}개 · 충돌 사본 ${p.conflicts}개.`];
  if (p.topFolders.length) lines.push(`많이 올라가는 폴더: ${p.topFolders.map((f) => `${f.name} (${f.count})`).join(', ')}.`);
  if (p.skipped > 0) lines.push(`${p.skipped}개 파일은 건너뜁니다.`);
  if (p.upload.count > MANY_UPLOAD_FILES || p.upload.bytes > MANY_UPLOAD_BYTES) lines.push('노트 폴더가 맞는지 한 번 더 확인하세요.');
  return lines;
}
