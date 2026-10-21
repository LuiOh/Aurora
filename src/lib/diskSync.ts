// 저장 전 디스크 변경 확인용 내용 해시, 클라우드에서 바뀐 파일을 열린 탭에 반영할지 가르는 판단, 상태 막대 문구
import type { CloudStatus, SkippedFile } from '../../electron/cloud/types';
import { contentHash } from '../../electron/contentHash';
import { clockText } from './cloudForm';

export { contentHash };

/**
 * 저장하려는 파일이 탭을 열거나 저장한 뒤 다른 곳에서 바뀌었는지.
 * 디스크에 파일이 없거나(disk null) 기준 해시가 없으면(제목 없는 탭) 묻지 않는다
 */
export function changedOnDisk(disk: string | null, baseline: string | null): boolean {
  return disk !== null && baseline !== null && contentHash(disk) !== baseline;
}

/** 경로 비교용. 구분자를 /로, 유니코드를 NFC로 맞춘다 (맥 파일 이름은 NFD로 올 수 있다) */
export const normalizePath = (p: string): string => p.replace(/\\/g, '/').normalize('NFC');

export interface TabRef {
  id: number;
  path: string | null;
  dirty: boolean;
}

/** 바뀐 파일 가운데 열린 탭. 저장하지 않은 변경이 없으면 다시 읽고(reload), 있으면 건드리지 않고 알린다(keep) */
export function splitChangedTabs(tabs: TabRef[], changed: string[]): { reload: number[]; keep: number[] } {
  const set = new Set(changed.map(normalizePath));
  const reload: number[] = [];
  const keep: number[] = [];
  for (const t of tabs) {
    if (!t.path || !set.has(normalizePath(t.path))) continue;
    (t.dirty ? keep : reload).push(t.id);
  }
  return { reload, keep };
}

export interface StatusBarView {
  hidden: boolean;
  text: string;
  title: string;
}

const OPEN_HINT = '눌러서 저장소 설정 열기';

/** 건너뛴 파일을 "경로 — 까닭" 줄로 max개까지. 더 있으면 "그 밖에 N개" 줄을 붙인다 */
export function skippedLines(files: readonly SkippedFile[], max: number): string[] {
  const lines = files.slice(0, max).map((f) => `${f.path} — ${f.reason}`);
  if (files.length > max) lines.push(`그 밖에 ${files.length - max}개`);
  return lines;
}

/** 상태 막대 오른쪽의 클라우드 표시. 로컬 모드면 숨긴다 */
export function cloudStatusBar(s: CloudStatus): StatusBarView {
  switch (s.state) {
    case 'off': return { hidden: true, text: '', title: '' };
    case 'idle': {
      const base = s.lastSync ? `☁ 맞춤 ${clockText(s.lastSync)}` : '☁ 맞춤';
      const skipped = s.skipped ?? [];
      if (skipped.length === 0) return { hidden: false, text: base, title: `클라우드와 맞춰져 있습니다. ${OPEN_HINT}` };
      const title = [`${skipped.length}개 파일은 맞추지 못했습니다.`, ...skippedLines(skipped, 10), OPEN_HINT].join('\n');
      return { hidden: false, text: `${base} · ${skipped.length}개 건너뜀`, title };
    }
    case 'syncing':
      return {
        hidden: false,
        text: s.progress && s.progress.total > 0 ? `☁ 맞추는 중 ${s.progress.done}/${s.progress.total}` : '☁ 맞추는 중',
        title: `클라우드와 맞추고 있습니다. ${OPEN_HINT}`,
      };
    case 'offline':
      return { hidden: false, text: '☁ 오프라인', title: s.message ?? `저장소에 연결할 수 없습니다. 연결되면 다시 맞춥니다. ${OPEN_HINT}` };
    case 'error':
      return { hidden: false, text: '☁ 오류', title: s.message ?? `알 수 없는 오류가 났습니다. ${OPEN_HINT}` };
  }
}
