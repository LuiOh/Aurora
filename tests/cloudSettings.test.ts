// 메인 프로세스가 화면에서 받은 클라우드 설정을 화면 검사와 같은 규칙으로 거르는지 검사하는 단위 테스트
import { describe, expect, it } from 'vitest';
import { parseCloudInput } from '../electron/cloud/settings';

const base = { endpoint: 'https://s3.test', bucket: 'notes', accessKeyId: 'AK' };

describe('클라우드 설정 읽기', () => {
  it('http는 이 컴퓨터 주소에만 허용한다', () => {
    expect(parseCloudInput({ ...base, endpoint: 'http://minio.example.com' }, 'A').ok).toBe(false);
    for (const host of ['localhost:9000', '127.0.0.1:9000', '[::1]:9000']) {
      expect(parseCloudInput({ ...base, endpoint: `http://${host}` }, 'A').ok).toBe(true);
    }
    expect(parseCloudInput(base, 'A').ok).toBe(true);
    expect(parseCloudInput({ ...base, endpoint: 'ftp://s3.test' }, 'A').ok).toBe(false);
  });
});
