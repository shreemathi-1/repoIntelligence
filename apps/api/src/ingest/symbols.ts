import { parseBlockComment, parseDocstring } from './comments.js';
import type { CodeSymbol, DocComment, Language } from './types.js';

const NOT_METHODS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'function',
  'return',
  'new',
  'else',
  'do',
  'try',
  'super',
  'import',
]);

type Draft = Omit<CodeSymbol, 'language' | 'path' | 'approximate' | 'endLine'>;

/** Reads from `start` until parentheses balance and a body or terminator starts (max 8 lines). */
function readSignature(lines: string[], start: number): { text: string; end: number } {
  let depth = 0;
  let out = '';
  for (let i = start; i < Math.min(lines.length, start + 8); i++) {
    const line = lines[i] ?? '';
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (depth <= 0 && (ch === '{' || ch === ';' || (ch === '=' && line[c + 1] === '>'))) {
        return { text: (out + line.slice(0, c)).replace(/\s+/g, ' ').trim(), end: i };
      }
    }
    out += `${line} `;
    if (depth <= 0 && /:\s*$/.test(line) && !line.includes('{')) {
      return { text: out.replace(/\s+/g, ' ').trim(), end: i };
    }
  }
  const last = Math.min(lines.length, start + 8) - 1;
  return { text: out.replace(/\s+/g, ' ').trim(), end: last };
}

/** Finds the end line of a brace-delimited body starting at `from`, or `from` if there is none. */
function braceEnd(lines: string[], from: number): number {
  let depth = 0;
  let seen = false;
  for (let i = from; i < lines.length; i++) {
    for (const ch of lines[i] ?? '') {
      if (ch === '{') {
        depth += 1;
        seen = true;
      } else if (ch === '}') depth -= 1;
    }
    if (seen && depth <= 0) return i;
    if (!seen && i - from > 12) break;
  }
  return from;
}

/** Collects `/** ... *\/` comments and remembers the line each one ends on. */
function blockComments(lines: string[]): Map<number, { comment: DocComment; start: number }> {
  const byEndLine = new Map<number, { comment: DocComment; start: number }>();
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*\/\*\*(?!\/)/.test(lines[i] ?? '')) continue;
    let end = i;
    while (end < lines.length && !(lines[end] ?? '').includes('*/')) end += 1;
    byEndLine.set(end, {
      comment: parseBlockComment(lines.slice(i, end + 1).join('\n')),
      start: i,
    });
    i = end;
  }
  return byEndLine;
}

/** The comment that sits right above `line`, ignoring annotations and decorators. */
function commentAbove(
  lines: string[],
  line: number,
  comments: Map<number, { comment: DocComment; start: number }>,
): DocComment | null {
  let i = line - 1;
  while (i >= 0 && /^\s*@\w/.test(lines[i] ?? '')) i -= 1;
  if (i >= 0 && (lines[i] ?? '').trim() === '') return null;
  return comments.get(i)?.comment ?? null;
}

function finish(
  drafts: Draft[],
  lines: string[],
  language: Language,
  path: string,
  brace: boolean,
): CodeSymbol[] {
  return drafts.map((d, index) => {
    const start = d.startLine - 1;
    const next = drafts.slice(index + 1).find((n) => n.startLine > d.startLine);
    const end = brace
      ? braceEnd(lines, start)
      : Math.max(start, next ? next.startLine - 2 : lines.length - 1);
    return { ...d, language, path, endLine: Math.max(d.startLine, end + 1), approximate: true };
  });
}

export function extractJsTs(
  source: string,
  path: string,
  language: 'typescript' | 'javascript',
): CodeSymbol[] {
  const lines = source.split(/\r?\n/);
  const comments = blockComments(lines);
  const drafts: Draft[] = [];
  let currentClass: { name: string; indent: number; exported: boolean } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const indent = line.length - line.trimStart().length;
    if (currentClass && indent <= currentClass.indent && /^\s*\}/.test(line)) currentClass = null;

    const add = (name: string, kind: Draft['kind'], exported: boolean, qualified = name): void => {
      const sig = readSignature(lines, i)
        .text.replace(/^export\s+(default\s+)?/, '')
        .trim();
      drafts.push({
        name,
        qualifiedName: qualified,
        kind,
        signature: sig,
        exported,
        doc: commentAbove(lines, i, comments),
        startLine: i + 1,
      });
    };

    let m =
      /^(\s*)(export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(
        line,
      );
    if (m?.[3] && m[1] === '') {
      add(m[3], 'function', Boolean(m[2]));
      continue;
    }
    m =
      /^(\s*)(export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(
        line,
      );
    if (m?.[3] && m[1] === '') {
      add(m[3], 'class', Boolean(m[2]));
      currentClass = { name: m[3], indent: 0, exported: Boolean(m[2]) };
      continue;
    }
    m =
      /^(\s*)(export\s+)?(?:declare\s+)?(interface|type|enum|const\s+enum)\s+([A-Za-z_$][\w$]*)/.exec(
        line,
      );
    if (m?.[4] && m[1] === '') {
      const kindWord = m[3] ?? '';
      add(
        m[4],
        kindWord === 'interface' ? 'interface' : kindWord === 'type' ? 'type' : 'enum',
        Boolean(m[2]),
      );
      continue;
    }
    m =
      /^(\s*)(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+?)?\s*=>/.exec(
        line,
      );
    if (m?.[3] && m[1] === '') {
      add(m[3], 'const', Boolean(m[2]));
      continue;
    }
    if (currentClass && indent > currentClass.indent) {
      m =
        /^\s+((?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*([A-Za-z_$#][\w$]*)\s*\(/.exec(
          line,
        );
      const name = m?.[2];
      if (
        name &&
        !NOT_METHODS.has(name) &&
        /\)\s*(?::[^{;=]+)?\s*[{;]|\)\s*$/.test(readSignature(lines, i).text + '{')
      ) {
        const isPrivate = /\bprivate\b/.test(line) || name.startsWith('#');
        add(name, 'method', currentClass.exported && !isPrivate, `${currentClass.name}.${name}`);
      }
    }
  }
  return finish(drafts, lines, language, path, true);
}

export function extractPython(source: string, path: string): CodeSymbol[] {
  const lines = source.split(/\r?\n/);
  const drafts: Draft[] = [];
  const stack: { indent: number; name: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    while (stack.length && indent <= (stack[stack.length - 1] as { indent: number }).indent)
      stack.pop();

    const def = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/.exec(line);
    const cls = /^(\s*)class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/.exec(line);
    if (!def && !cls) continue;

    const sig = readSignature(lines, i);
    const name = def?.[2] ?? cls?.[2] ?? '';
    const parent = stack[stack.length - 1];
    const qualified = parent ? `${parent.name}.${name}` : name;
    const signature = sig.text.replace(/:\s*$/, '').replace(/^async\s+/, 'async ');

    // The docstring is the first statement of the body.
    let doc: DocComment | null = null;
    for (let k = sig.end + 1; k < lines.length; k++) {
      if ((lines[k] ?? '').trim() === '') continue;
      const open = /^\s*[rRuUbB]?("""|''')(.*)$/.exec(lines[k] ?? '');
      if (open?.[1]) {
        const quote = open[1];
        const rest = open[2] ?? '';
        const body: string[] = [];
        if (rest.includes(quote)) body.push(rest.slice(0, rest.indexOf(quote)));
        else {
          body.push(rest);
          for (let n = k + 1; n < lines.length; n++) {
            const l = lines[n] ?? '';
            if (l.includes(quote)) {
              body.push(l.slice(0, l.indexOf(quote)));
              break;
            }
            body.push(l);
          }
        }
        doc = parseDocstring(body.join('\n'));
      }
      break;
    }

    const kind: Draft['kind'] = cls ? 'class' : parent ? 'method' : 'function';
    drafts.push({
      name,
      qualifiedName: qualified,
      kind,
      signature,
      exported: !name.startsWith('_') || (name.startsWith('__') && name.endsWith('__')),
      doc,
      startLine: i + 1,
    });
    stack.push({ indent, name: qualified });
  }
  return finish(drafts, lines, 'python', path, false);
}

export function extractJava(source: string, path: string): CodeSymbol[] {
  const lines = source.split(/\r?\n/);
  const comments = blockComments(lines);
  const drafts: Draft[] = [];
  let currentType: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const type =
      /^\s*(?:@\w+(?:\([^)]*\))?\s*)*((?:public|protected|private|abstract|final|static|sealed|non-sealed|strictfp)\s+)*(class|interface|enum|record)\s+(\w+)/.exec(
        line,
      );
    if (type?.[3]) {
      const kind = type[2] === 'interface' ? 'interface' : type[2] === 'enum' ? 'enum' : 'class';
      const sig = readSignature(lines, i).text;
      drafts.push({
        name: type[3],
        qualifiedName: type[3],
        kind,
        signature: sig,
        exported: /\bpublic\b/.test(line),
        doc: commentAbove(lines, i, comments),
        startLine: i + 1,
      });
      currentType = type[3];
      continue;
    }
    const method =
      /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|protected|private|static|final|abstract|synchronized|native|default)\s+)+(?:<[^>]+>\s+)?[\w<>[\],.? ]+?\s+(\w+)\s*\(/.exec(
        line,
      );
    const name = method?.[1];
    if (name && !NOT_METHODS.has(name) && !/\bnew\b|=/.test(line.split('(')[0] ?? '')) {
      const sig = readSignature(lines, i).text;
      drafts.push({
        name,
        qualifiedName: currentType ? `${currentType}.${name}` : name,
        kind: 'method',
        signature: sig,
        exported: /\b(public|protected)\b/.test(line),
        doc: commentAbove(lines, i, comments),
        startLine: i + 1,
      });
    }
  }
  return finish(drafts, lines, 'java', path, true);
}

export function extractSymbols(source: string, path: string, language: Language): CodeSymbol[] {
  switch (language) {
    case 'typescript':
    case 'javascript':
      return extractJsTs(source, path, language);
    case 'python':
      return extractPython(source, path);
    case 'java':
      return extractJava(source, path);
  }
}
