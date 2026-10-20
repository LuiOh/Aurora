// JSON과 XML 문자열을 정리(들여쓰기)하거나 압축하는 순수 함수 모음

/**
 * 문자열 밖의 공백만 다시 배치한다. 숫자·문자열·중복 키 같은 원문 글자는 그대로 둔다.
 * JSON.parse로 다시 쓰면 큰 숫자가 깎이고 1.0이 1로 바뀌므로 쓰지 않는다.
 */
function reflowJson(text: string, indent: string | null): string {
  JSON.parse(text); // 문법 검사만 한다. 틀리면 에러를 던진다
  const nl = (depth: number) => (indent === null ? '' : '\n' + indent.repeat(depth));
  let out = '';
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      // 문자열은 이스케이프를 건너뛰며 닫는 따옴표까지 그대로 옮긴다
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '{' || c === '[') {
      // 빈 객체·배열은 {} [] 그대로 둔다
      let j = i + 1;
      while (/\s/.test(text[j])) j++;
      if (text[j] === (c === '{' ? '}' : ']')) {
        out += c + text[j];
        i = j;
      } else {
        out += c + nl(++depth);
      }
    } else if (c === '}' || c === ']') {
      out += nl(--depth) + c;
    } else if (c === ',') {
      out += ',' + nl(depth);
    } else if (c === ':') {
      out += indent === null ? ':' : ': ';
    } else if (!/\s/.test(c)) {
      out += c;
    }
  }
  return out;
}

export function formatJson(text: string, indent = 2): string {
  return reflowJson(text, ' '.repeat(indent));
}

export function minifyJson(text: string): string {
  return reflowJson(text, null);
}

type XmlToken =
  | { kind: 'open' | 'close' | 'self' | 'decl' | 'comment' | 'cdata' | 'doctype'; text: string }
  | { kind: 'text'; text: string };

/** XML을 태그와 텍스트 조각으로 나눈다. 닫히지 않은 구문이 있으면 에러를 던진다 */
export function tokenizeXml(xml: string): XmlToken[] {
  const tokens: XmlToken[] = [];
  let i = 0;
  const take = (end: string, kind: XmlToken['kind']) => {
    const j = xml.indexOf(end, i);
    if (j < 0) throw new Error(`XML 구문이 닫히지 않았습니다 (위치 ${i})`);
    tokens.push({ kind, text: xml.slice(i, j + end.length) } as XmlToken);
    i = j + end.length;
  };
  while (i < xml.length) {
    if (xml.startsWith('<!--', i)) take('-->', 'comment');
    else if (xml.startsWith('<![CDATA[', i)) take(']]>', 'cdata');
    else if (xml.startsWith('<?', i)) take('?>', 'decl');
    else if (xml.startsWith('<!', i)) take('>', 'doctype');
    else if (xml.startsWith('</', i)) take('>', 'close');
    else if (xml[i] === '<') {
      // 속성값 안의 '>'를 건너뛰기 위해 따옴표를 추적한다
      let j = i + 1;
      let quote = '';
      for (; j < xml.length; j++) {
        const c = xml[j];
        if (quote) { if (c === quote) quote = ''; }
        else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      if (j >= xml.length) throw new Error(`XML 태그가 닫히지 않았습니다 (위치 ${i})`);
      const text = xml.slice(i, j + 1);
      tokens.push({ kind: text.endsWith('/>') ? 'self' : 'open', text });
      i = j + 1;
    } else {
      const j = xml.indexOf('<', i);
      const end = j < 0 ? xml.length : j;
      tokens.push({ kind: 'text', text: xml.slice(i, end) });
      i = end;
    }
  }
  return tokens;
}

export function formatXml(xml: string, indent = '  '): string {
  const tokens = tokenizeXml(xml).filter((t) => !(t.kind === 'text' && t.text.trim() === ''));
  const lines: string[] = [];
  let depth = 0;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    const pad = indent.repeat(depth);
    if (t.kind === 'open') {
      // <a>텍스트</a> 처럼 텍스트 하나만 감싼 요소는 한 줄로 둔다
      const next = tokens[k + 1];
      const after = tokens[k + 2];
      if (next?.kind === 'text' && after?.kind === 'close') {
        lines.push(pad + t.text + next.text.trim() + after.text);
        k += 2;
      } else if (next?.kind === 'close') {
        lines.push(pad + t.text + next.text);
        k += 1;
      } else {
        lines.push(pad + t.text);
        depth++;
      }
    } else if (t.kind === 'close') {
      depth = Math.max(0, depth - 1);
      lines.push(indent.repeat(depth) + t.text);
    } else {
      lines.push(pad + t.text.trim());
    }
  }
  return lines.join('\n');
}

export function minifyXml(xml: string): string {
  return tokenizeXml(xml)
    .filter((t) => !(t.kind === 'text' && t.text.trim() === ''))
    .map((t) => (t.kind === 'text' ? t.text.trim() : t.text))
    .join('');
}
