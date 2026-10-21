// S3 목록·오류 XML 파서가 엔티티, 인코딩 없는 키, 쪽 넘김을 바르게 읽는지 검사하는 단위 테스트
import { describe, expect, it } from 'vitest';
import { decodeEntities, parseListObjects, parseS3Error } from '../electron/cloud/xml';

const page1 = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>notes</Name>
  <Prefix>aurora/</Prefix>
  <KeyCount>3</KeyCount>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=&amp;x</NextContinuationToken>
  <Contents>
    <Key>aurora/회의/서울 날씨.md</Key>
    <LastModified>2026-10-21T01:02:03.000Z</LastModified>
    <ETag>&quot;9e107d9d372bb6826bd81d3542a419d6&quot;</ETag>
    <Size>42</Size>
    <StorageClass>STANDARD</StorageClass>
  </Contents>
  <Contents>
    <Key>aurora/a+b c 100%25.md</Key>
    <LastModified>2026-10-21T01:02:04.000Z</LastModified>
    <ETag>"d41d8cd98f00b204e9800998ecf8427e-3"</ETag>
    <Size>0</Size>
  </Contents>
  <Contents>
    <Key>aurora/R&amp;D &amp;amp; &lt;x&gt;.txt</Key>
    <LastModified>2026-10-21T01:02:05.000Z</LastModified>
    <ETag>"abc"</ETag>
    <Size>7</Size>
  </Contents>
</ListBucketResult>`;

describe('클라우드 XML 파서', () => {
  it('엔티티를 푼다', () => {
    expect(decodeEntities('&amp;&lt;&gt;&quot;&apos;&#44032;&#xAC00;&#x1F600;')).toBe('&<>"\'가가😀');
    expect(decodeEntities('&nope; &amp')).toBe('&nope; &amp');
  });

  it('키는 엔티티만 풀고 공백·+·%를 그대로 두며 ETag 따옴표를 떼며 쪽 넘김 표시를 읽는다', () => {
    const p = parseListObjects(page1);
    expect(p.isTruncated).toBe(true);
    expect(p.nextContinuationToken).toBe('1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=&x');
    expect(p.objects).toEqual([
      { key: 'aurora/회의/서울 날씨.md', etag: '9e107d9d372bb6826bd81d3542a419d6', size: 42, lastModified: '2026-10-21T01:02:03.000Z' },
      { key: 'aurora/a+b c 100%25.md', etag: 'd41d8cd98f00b204e9800998ecf8427e-3', size: 0, lastModified: '2026-10-21T01:02:04.000Z' },
      { key: 'aurora/R&D &amp; <x>.txt', etag: 'abc', size: 7, lastModified: '2026-10-21T01:02:05.000Z' },
    ]);
  });

  it("응답에 EncodingType이 있어도 퍼센트 디코딩하지 않고 '+'도 그대로 둔다", () => {
    const xml = '<ListBucketResult><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated><Contents><Key>a+b%20.md</Key><ETag>"x"</ETag><Size>1</Size><LastModified>t</LastModified></Contents></ListBucketResult>';
    expect(parseListObjects(xml).objects[0].key).toBe('a+b%20.md');
  });

  it('인코딩이 없으면 키를 엔티티만 풀어 그대로 쓴다', () => {
    const xml = '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>노트 &amp; 100%.md</Key><ETag>&quot;e&quot;</ETag><Size>3</Size><LastModified>t</LastModified></Contents></ListBucketResult>';
    const p = parseListObjects(xml);
    expect(p.objects[0].key).toBe('노트 & 100%.md');
    expect(p.isTruncated).toBe(false);
    expect(p.nextContinuationToken).toBeNull();
  });

  it('빈 목록', () => {
    const p = parseListObjects('<ListBucketResult><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>');
    expect(p.objects).toEqual([]);
  });

  it('오류 XML에서 코드와 메시지를 읽는다', () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?><Error><Code>SignatureDoesNotMatch</Code><Message>The request signature &amp; stuff</Message><RequestId>1</RequestId></Error>';
    expect(parseS3Error(xml)).toEqual({ code: 'SignatureDoesNotMatch', message: 'The request signature & stuff' });
    expect(parseS3Error('')).toBeNull();
  });
});
