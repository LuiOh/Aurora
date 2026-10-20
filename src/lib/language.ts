// 파일 이름의 확장자로 Monaco 언어 ID를 고르는 함수

const EXT_TO_LANG: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  json: 'json', xml: 'xml', html: 'html', htm: 'html', css: 'css', scss: 'scss',
  md: 'markdown', py: 'python', java: 'java', kt: 'kotlin', sql: 'sql',
  sh: 'shell', zsh: 'shell', yml: 'yaml', yaml: 'yaml', go: 'go', rs: 'rust',
  swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', php: 'php', rb: 'ruby',
};

export function languageForPath(path: string | null): string {
  if (!path) return 'plaintext';
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'plaintext';
  return EXT_TO_LANG[name.slice(dot + 1).toLowerCase()] ?? 'plaintext';
}

export function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}
