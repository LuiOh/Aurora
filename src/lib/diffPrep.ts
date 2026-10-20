// 비교하기 전에 대소문자 무시 같은 옵션을 텍스트에 적용하는 순수 함수

export interface DiffOptions {
  ignoreWhitespace: boolean;
  ignoreCase: boolean;
}

/**
 * Monaco 비교 편집기는 대소문자 무시를 지원하지 않으므로 소문자로 바꾼 사본을 비교한다.
 * 공백 무시는 Monaco의 ignoreTrimWhitespace 옵션이 처리하므로 여기서는 손대지 않는다.
 */
export function prepareForDiff(text: string, opts: DiffOptions): string {
  return opts.ignoreCase ? text.toLowerCase() : text;
}
