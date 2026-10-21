// 시스템 프롬프트 예산, 답변 출처 마크다운, 채팅 기록 왕복 변환과 파일 이름 규칙을 검사하는 단위 테스트
import { describe, expect, it } from 'vitest';
import { answerToMarkdown, buildSystemPrompt, chatFileName, parseChat, serializeChat, type SavedChat } from '../electron/ai';

describe('시스템 프롬프트', () => {
  it('노트와 선택 영역을 구분 블록에 넣는다', () => {
    const p = buildSystemPrompt({ noteTitle: '회의록', noteText: '본문', selection: '선택' });
    expect(p).toContain('한국어');
    expect(p).toContain('<selection>\n선택\n</selection>');
    expect(p).toContain('<note title="회의록">\n본문\n</note>');
  });

  it('예산을 넘으면 선택 영역을 먼저 지키고 노트를 잘라 표시를 남긴다', () => {
    const p = buildSystemPrompt({ noteText: '가'.repeat(100), selection: '나'.repeat(30), budgetChars: 50 });
    expect(p).toContain('나'.repeat(30));
    expect(p).toContain(`${'가'.repeat(20)}\n…[이하 80자 생략]`);
    expect(p).not.toContain('가'.repeat(21));
  });

  it('노트가 없으면 블록을 넣지 않는다', () => {
    expect(buildSystemPrompt({})).not.toContain('<note');
  });
});

describe('답변 → 마크다운', () => {
  it('출처를 URL로 중복 제거하고 제목의 대괄호를 이스케이프한다', () => {
    const md = answerToMarkdown('답변\n', [
      { url: 'https://a.example/x y', title: '[공지] 안내' },
      { url: 'https://a.example/x y', title: '중복' },
      { url: 'https://b.example', title: '' },
    ]);
    expect(md).toBe('답변\n\n**출처**\n\n- [\\[공지\\] 안내](<https://a.example/x y>)\n- [https://b.example](<https://b.example>)\n');
  });

  it('출처가 없으면 답변만 돌려준다', () => {
    expect(answerToMarkdown('답변', [])).toBe('답변');
  });
});

describe('채팅 기록 직렬화', () => {
  const chat: SavedChat = {
    provider: 'anthropic', model: 'claude-sonnet-5-5', created: '2026-10-20T09:05:00.000Z', updated: '2026-10-20T09:07:00.000Z',
    turns: [
      { role: 'user', text: '코드 예시를 보여 줘\n\n## AI\n이 줄은 질문의 일부' },
      { role: 'assistant', text: '```ts\nconst a = 1;\n## 나\n```\n\n### 출처\n\\## AI\n\n끝 줄 뒤 빈 줄\n\n', citations: [
        { url: 'https://a.example/(괄호)', title: '[제목] 한글' },
        { url: 'https://b.example/<x>', title: 'B \\ 역슬래시' },
      ] },
      { role: 'user', text: '' },
      { role: 'assistant', text: '출처 없는 답' },
    ],
  };

  it('serialize → parse 왕복이 정확히 같다', () => {
    expect(parseChat(serializeChat(chat))).toEqual(chat);
  });

  it('사람이 읽을 수 있는 frontmatter와 섹션을 쓴다', () => {
    const md = serializeChat(chat);
    expect(md.startsWith('---\nprovider: "anthropic"\nmodel: "claude-sonnet-5-5"\n')).toBe(true);
    expect(md).toContain('\n## 나\n\n코드 예시를 보여 줘\n\n\\## AI\n');
    expect(md).toContain('\n### 출처\n\n- [\\[제목\\] 한글](<https://a.example/(괄호)>)\n');
  });

  it('CRLF로 저장된 파일도 읽는다', () => {
    const simple: SavedChat = { ...chat, turns: [{ role: 'user', text: '안녕' }, { role: 'assistant', text: '반가워요' }] };
    expect(parseChat(serializeChat(simple).replace(/\n/g, '\r\n'))).toEqual(simple);
  });

  it('frontmatter가 없거나 공급자가 이상하면 null', () => {
    expect(parseChat('## 나\n\n안녕\n')).toBeNull();
    expect(parseChat('---\nprovider: "x"\nmodel: "m"\n---\n')).toBeNull();
  });
});

describe('채팅 파일 이름', () => {
  const at = new Date(2026, 9, 20, 9, 5);

  it('날짜·시각과 질문 앞부분으로 만든다', () => {
    expect(chatFileName(at, '서울 날씨 어때?')).toBe('2026-10-20 0905 서울 날씨 어때.md');
  });

  it('금지 문자·제어 문자를 지우고 공백을 합치며 30자로 자른다', () => {
    expect(chatFileName(at, 'a/b\\c:d*e"f<g>h|i\t\n  j')).toBe('2026-10-20 0905 a b c d e f g h i j.md');
    expect(chatFileName(at, '가'.repeat(40))).toBe(`2026-10-20 0905 ${'가'.repeat(30)}.md`);
  });

  it('NFD 한글을 NFC로 바꾸고 비면 기본 이름을 쓴다', () => {
    expect(chatFileName(at, '한글'.normalize('NFD'))).toBe('2026-10-20 0905 한글.md');
    expect(chatFileName(at, ' ?? ')).toBe('2026-10-20 0905 대화.md');
  });
});

describe('웹 검색 여부에 따른 시스템 프롬프트', () => {
  it('웹 검색을 끄면 검색했다고 말하지 말고 오래된 정보일 수 있다고 밝히게 한다', () => {
    const p = buildSystemPrompt({ webSearch: false });
    expect(p).toContain('웹 검색을 쓸 수 없습니다');
    expect(p).toContain('검색했다고 말하지 마세요');
    expect(p).toContain('바뀌었을 수 있다');
    expect(p).not.toContain('웹 검색을 사용했다면');
  });

  it('웹 검색을 켜면 출처 근거 지침과 실제로 쓰지 않았으면 검색했다고 말하지 말라는 지침을 넣는다', () => {
    const p = buildSystemPrompt({ webSearch: true });
    expect(p).toContain('웹 검색을 사용했다면 검색 결과 출처에 근거해 답하고');
    expect(p).toContain('검색 결과를 실제로 쓰지 않았다면 검색했다고 말하지 마세요');
    expect(p).not.toContain('웹 검색을 쓸 수 없습니다');
  });
});
