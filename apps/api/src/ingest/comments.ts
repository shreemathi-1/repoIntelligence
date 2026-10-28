import type { DocComment, DocTag } from './types.js';
import { emptyToNull } from './util.js';

const NAMED_TAGS = new Set([
  'param',
  'throws',
  'exception',
  'typeparam',
  'template',
  'property',
  'prop',
]);

function summaryOf(description: string): string {
  const firstParagraph =
    description
      .split(/\n\s*\n/)[0]
      ?.replace(/\s+/g, ' ')
      .trim() ?? '';
  const sentence = /^(.+?[.!?])(\s|$)/.exec(firstParagraph);
  return (sentence?.[1] ?? firstParagraph).slice(0, 300);
}

/** Parses the text of a `/** ... *\/` comment (JSDoc or Javadoc). */
export function parseBlockComment(raw: string): DocComment {
  const body = raw
    .replace(/^\s*\/\*\*?/, '')
    .replace(/\*\/\s*$/, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*? ?/, ''))
    .join('\n')
    .trim();

  const descriptionLines: string[] = [];
  const tags: DocTag[] = [];
  let current: { tag: string; rest: string[] } | null = null;

  const flush = (): void => {
    if (!current) return;
    let rest = current.rest.join(' ').replace(/\s+/g, ' ').trim();
    // Drop JSDoc type annotations such as {string} so the name comes first.
    rest = rest.replace(/^\{[^}]*\}\s*/, '');
    let name: string | null = null;
    if (NAMED_TAGS.has(current.tag)) {
      const m = /^(\[?[\w$.<>]+\]?)\s*(?:-\s*)?(.*)$/.exec(rest);
      if (m?.[1]) {
        name = m[1].replace(/^\[|\]$/g, '');
        rest = m[2] ?? '';
      }
    } else {
      rest = rest.replace(/^-\s*/, '');
    }
    tags.push({ tag: current.tag, name, text: rest });
    current = null;
  };

  for (const line of body.split('\n')) {
    const tag = /^@(\w+)\s*(.*)$/.exec(line);
    if (tag?.[1]) {
      flush();
      current = { tag: tag[1], rest: [tag[2] ?? ''] };
    } else if (current) {
      current.rest.push(line.trim());
    } else {
      descriptionLines.push(line);
    }
  }
  flush();

  const description = descriptionLines.join('\n').trim();
  return { summary: summaryOf(description), description, tags };
}

/** Parses a Python docstring body (already unquoted). */
export function parseDocstring(raw: string): DocComment {
  const lines = raw.replace(/\t/g, '    ').split(/\r?\n/);
  const indents = lines
    .slice(1)
    .filter((l) => l.trim() !== '')
    .map((l) => l.length - l.trimStart().length);
  const cut = indents.length ? Math.min(...indents) : 0;
  const description = [lines[0]?.trim() ?? '', ...lines.slice(1).map((l) => l.slice(cut))]
    .join('\n')
    .trim();

  const tags: DocTag[] = [];
  // Sphinx style: ":param name: text" and ":returns: text".
  for (const m of description.matchAll(/^:(param|returns?|raises)\s*([\w.]*)\s*:\s*(.*)$/gm)) {
    tags.push({
      tag: m[1] === 'return' ? 'returns' : (m[1] ?? ''),
      name: emptyToNull(m[2]),
      text: m[3] ?? '',
    });
  }
  return { summary: summaryOf(description), description, tags };
}
