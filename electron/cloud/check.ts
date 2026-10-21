// 클라우드 설정이 맞는지 목록을 받아 보고 조건부 쓰기를 지원하는지 확인하는 연결 점검
import { toRel } from './keys';
import { createS3Client } from './s3';
import { CloudError, type CloudConfig, type CloudTestResult } from './types';

export async function testConnection(cfg: CloudConfig, fetchImpl: typeof fetch): Promise<CloudTestResult> {
  try {
    const s3 = createS3Client(cfg, fetchImpl);
    const objects = await s3.list(cfg.prefix);
    const conditionalWrites = await s3.probeConditionalWrites();
    return { ok: true, conditionalWrites, objectCount: objects.filter((o) => toRel(cfg.prefix, o.key) !== null).length };
  } catch (err) {
    if (err instanceof CloudError) return { ok: false, kind: err.kind, message: err.message };
    return { ok: false, kind: 'network', message: `저장소에 연결하지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
  }
}
