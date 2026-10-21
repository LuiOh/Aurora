// 클라우드(S3 호환) 저장소 동기화에서 함께 쓰는 설정·객체·계획·오류 형식

export interface CloudConfig {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
}

/** 버킷에 있는 객체 한 개. etag는 따옴표를 뗀 값 */
export interface RemoteObject {
  key: string;
  /** 저장소가 돌려준 키 그대로 (정규화하지 않음). 읽기·쓰기·조건 확인은 이 키로 한다. 없으면 key와 같다 */
  rawKey?: string;
  etag: string;
  size: number;
  lastModified: string;
}

/** 노트 폴더의 파일 한 개. rel은 '/'로 이은 NFC 경로, md5는 내용의 16진 MD5 */
export interface LocalFile {
  rel: string;
  md5: string;
  size: number;
}

/** 마지막으로 양쪽이 같았을 때의 내용 해시와 ETag (rel 기준) */
export type SyncState = Record<string, { md5: string; etag: string }>;

export type PlanAction =
  | { type: 'upload'; rel: string; ifMatch?: string; ifNoneMatch?: '*' }
  | { type: 'download'; rel: string; etag: string }
  | { type: 'record'; rel: string; md5: string; etag: string }
  /** 로컬 내용을 copyRel로 저장·업로드한 뒤 원격 내용을 rel로 내려받는다 */
  | { type: 'conflict'; rel: string; copyRel: string; etag: string }
  | { type: 'skip'; rel: string; reason: string };

export type CloudErrorKind = 'auth' | 'not-found' | 'precondition' | 'network' | 'server' | 'bad-request';

export class CloudError extends Error {
  readonly kind: CloudErrorKind;
  readonly status?: number;
  readonly code?: string;

  constructor(kind: CloudErrorKind, message: string, details?: { status?: number; code?: string }) {
    super(message);
    this.name = 'CloudError';
    this.kind = kind;
    this.status = details?.status;
    this.code = details?.code;
  }
}

/** 화면에서 보고 고치는 클라우드 설정 (비밀 키는 빼고 기기 이름을 더한다) */
export interface CloudSettingsInput {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  pathStyle: boolean;
  device: string;
}

/** 동기화하지 못한 파일 하나. path는 노트 폴더 기준 / 경로, reason은 화면에 보일 까닭 */
export interface SkippedFile { path: string; reason: string }

export interface CloudStatus {
  state: 'off' | 'idle' | 'syncing' | 'offline' | 'error';
  message?: string;
  /** 다음 전체 맞춤까지 남겨 두는, 건너뛰거나 맞추지 못한 파일 */
  skipped?: SkippedFile[];
  lastSync?: number;
  progress?: { done: number; total: number };
}

/** paths·path·copyPath는 / 구분자 절대 경로 */
export type CloudEvent =
  | { type: 'status'; status: CloudStatus }
  | { type: 'changed'; paths: string[] }
  | { type: 'conflict'; path: string; copyPath: string };

export interface CloudSettingsView {
  mode: 'local' | 'cloud';
  cloud: CloudSettingsInput | null;
  hasSecret: boolean;
  status: CloudStatus;
}

export type CloudFailure = { ok: false; kind: CloudErrorKind; message: string };
export type CloudTestResult = { ok: true; conditionalWrites: boolean; objectCount: number } | CloudFailure;
export type CloudResult = { ok: true } | CloudFailure;

/** 클라우드로 바꾸기 전에 보여 줄 첫 동기화 규모. topFolders는 올릴 파일이 많은 맨 위 폴더(최대 5개) */
export interface CloudPreview {
  upload: { count: number; bytes: number };
  download: { count: number; bytes: number };
  conflicts: number;
  topFolders: { name: string; count: number }[];
  skipped: number;
}
export type CloudPreviewResult = { ok: true; preview: CloudPreview } | CloudFailure;
