// 번호 넣기, JSON·XML 정리, 비교 전처리, 언어 판별 로직을 검사하는 단위 테스트
import { describe, expect, it } from 'vitest';
import { generateNumbers, parseNumberingInput } from '../src/lib/numbering';
import { formatJson, minifyJson, formatXml, minifyXml } from '../src/lib/format';
import { prepareForDiff } from '../src/lib/diffPrep';
import { languageForPath, baseName } from '../src/lib/language';

describe('번호 넣기', () => {
  it('시작값과 증가값으로 번호를 만든다', () => {
    expect(generateNumbers(4, { start: 1, step: 1, zeroPad: false })).toEqual(['1', '2', '3', '4']);
    expect(generateNumbers(3, { start: 10, step: 5, zeroPad: false })).toEqual(['10', '15', '20']);
  });
  it('0 채우기는 가장 긴 번호에 자릿수를 맞춘다', () => {
    expect(generateNumbers(3, { start: 8, step: 1, zeroPad: true })).toEqual(['08', '09', '10']);
  });
  it('음수 증가값과 음수 번호도 처리한다', () => {
    expect(generateNumbers(3, { start: 1, step: -1, zeroPad: false })).toEqual(['1', '0', '-1']);
  });
  it('입력값을 검사한다', () => {
    expect(parseNumberingInput('1', '2', false)).toEqual({ start: 1, step: 2, zeroPad: false });
    expect(parseNumberingInput('', '1', false)).toBeNull();
    expect(parseNumberingInput('1.5', '1', false)).toBeNull();
    expect(parseNumberingInput('a', '1', false)).toBeNull();
  });
});

describe('JSON 정리·압축', () => {
  it('들여쓰기와 압축이 서로 되돌려진다', () => {
    const src = '{"a":1,"b":[1,2],"c":{"d":"x"}}';
    expect(formatJson(src)).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ],\n  "c": {\n    "d": "x"\n  }\n}');
    expect(minifyJson(formatJson(src))).toBe(src);
  });
  it('숫자 표기, 큰 숫자, 중복 키, 이스케이프를 원문 그대로 둔다', () => {
    const src = '{"id":12345678901234567890,"price":1.0,"exp":1e3,"dup":1,"dup":2,"s":"a\\"b, c:{d}\\u00e9"}';
    expect(minifyJson(formatJson(src))).toBe(src);
    expect(formatJson(src)).toContain('"id": 12345678901234567890,');
    expect(formatJson(src)).toContain('"price": 1.0,');
  });
  it('빈 객체·배열은 한 줄로 두고 기존 공백은 다시 맞춘다', () => {
    expect(formatJson('{ "a" : [ ] , "b":{  } }')).toBe('{\n  "a": [],\n  "b": {}\n}');
    expect(minifyJson('{\n  "a": [ 1 ,\n 2 ]\n}')).toBe('{"a":[1,2]}');
  });
  it('잘못된 JSON은 에러를 던진다', () => {
    expect(() => formatJson('{a:1}')).toThrow();
  });
});

describe('XML 정리·압축', () => {
  const src = '<?xml version="1.0"?><root><a x="1>2">text</a><b/><c><d></d></c><!-- note --></root>';
  it('중첩 깊이에 맞춰 들여쓴다', () => {
    expect(formatXml(src)).toBe(
      [
        '<?xml version="1.0"?>',
        '<root>',
        '  <a x="1>2">text</a>',
        '  <b/>',
        '  <c>',
        '    <d></d>',
        '  </c>',
        '  <!-- note -->',
        '</root>',
      ].join('\n'),
    );
  });
  it('정리한 결과를 압축하면 원본과 같다', () => {
    expect(minifyXml(formatXml(src))).toBe(src);
  });
  it('CDATA는 그대로 둔다', () => {
    expect(minifyXml('<a>\n  <![CDATA[ <x> ]]>\n</a>')).toBe('<a><![CDATA[ <x> ]]></a>');
  });
  it('닫히지 않은 태그는 에러를 던진다', () => {
    expect(() => formatXml('<a><b')).toThrow();
  });
});

describe('비교 전처리', () => {
  it('대소문자 무시면 소문자 사본을 만든다', () => {
    expect(prepareForDiff('Hello World', { ignoreCase: true, ignoreWhitespace: false })).toBe('hello world');
    expect(prepareForDiff('Hello World', { ignoreCase: false, ignoreWhitespace: true })).toBe('Hello World');
  });
});

describe('언어 판별', () => {
  it('확장자로 언어를 고른다', () => {
    expect(languageForPath('/a/b/c.JSON')).toBe('json');
    expect(languageForPath('/a/.zshrc')).toBe('plaintext');
    expect(languageForPath(null)).toBe('plaintext');
    expect(baseName('/a/b/c.txt')).toBe('c.txt');
  });
});
