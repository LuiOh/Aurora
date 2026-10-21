// S3 ListObjectsV2 응답과 오류 응답 XML을 읽는 작은 파서 (Node에는 DOMParser가 없다)
import type { RemoteObject } from './types';

export interface ListPage {
  objects: RemoteObject[];
  isTruncated: boolean;
  nextContinuationToken: string | null;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (whole, ent: string) => {
    if (ent.startsWith('#x')) return String.fromCodePoint(parseInt(ent.slice(2), 16));
    if (ent.startsWith('#')) return String.fromCodePoint(parseInt(ent.slice(1), 10));
    return NAMED[ent] ?? whole;
  });
}

const tagText = (xml: string, tag: string): string | null => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? decodeEntities(m[1]) : null;
};

const allBlocks = (xml: string, tag: string): string[] =>
  [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);

export const stripEtag = (etag: string): string => etag.trim().replace(/^W\//, '').replace(/^"|"$/g, '');

/**
 * 목록은 encoding-type 없이 받는다. AWS는 url 인코딩 때 공백을 '+'로 보내 '+'와 구별할 수 없기 때문이다.
 * 키는 XML 엔티티만 푼다. 제어 문자가 든 키는 isSyncable이 걸러 낸다
 */
export function parseListObjects(xml: string): ListPage {
  const objects = allBlocks(xml, 'Contents').map((block): RemoteObject => ({
    key: tagText(block, 'Key') ?? '',
    etag: stripEtag(tagText(block, 'ETag') ?? ''),
    size: Number(tagText(block, 'Size') ?? '0'),
    lastModified: (tagText(block, 'LastModified') ?? '').trim(),
  }));
  const token = tagText(xml, 'NextContinuationToken');
  return {
    objects,
    isTruncated: (tagText(xml, 'IsTruncated') ?? '').trim().toLowerCase() === 'true',
    nextContinuationToken: token ? token.trim() : null,
  };
}

export function parseS3Error(xml: string): { code: string; message: string } | null {
  const block = allBlocks(xml, 'Error')[0];
  if (block === undefined) return null;
  return { code: (tagText(block, 'Code') ?? '').trim(), message: (tagText(block, 'Message') ?? '').trim() };
}
