import { dirname } from 'node:path/posix';
import { closesFence, emptyToNull } from './util.js';
import type { MdAsset, MdCodeBlock, MdDocument, MdLink, MdSection, MdTable } from './types.js';

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)?.*$/;
const ATX = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** The anchor GitHub generates for a heading. */
export function slugify(heading: string): string {
  return heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .replace(/<[^>]+>/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

interface Raw {
  heading: string | null;
  level: number;
  startLine: number;
  lines: string[];
}

function stripFrontMatter(lines: string[]): number {
  if (lines[0]?.trim() !== '---') return 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') return i + 1;
  }
  return 0;
}

/** Blanks out inline code so link syntax inside it is ignored. */
function maskInlineCode(line: string): string {
  return line.replace(/(`+)(.+?)\1/g, (match) => ' '.repeat(match.length));
}

interface Scan {
  links: { text: string; href: string; line: number }[];
  images: { alt: string; src: string; line: number }[];
}

function scanInline(lines: { text: string; line: number }[]): Scan {
  const refs = new Map<string, string>();
  for (const { text } of lines) {
    const def = /^ {0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+["'(].*)?$/.exec(text);
    if (def?.[1] && def[2]) refs.set(def[1].toLowerCase(), def[2]);
  }

  const scan: Scan = { links: [], images: [] };
  for (const { text, line } of lines) {
    if (/^ {0,3}\[[^\]]+\]:\s/.test(text)) continue;
    let work = maskInlineCode(text);

    // Images first, so a badge like [![alt](img)](url) leaves a plain link behind.
    work = work.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_m, alt, src) => {
      scan.images.push({ alt: String(alt), src: String(src), line });
      // Plain word, so a badge like [![alt](img)](url) still reads as [image](url).
      return 'image';
    });
    work = work.replace(/<img\b[^>]*?\bsrc=["']([^"']+)["'][^>]*>/gi, (match, src) => {
      const alt = /\balt=["']([^"']*)["']/i.exec(match)?.[1] ?? '';
      scan.images.push({ alt, src: String(src), line });
      return ' ';
    });
    work.replace(
      /(?<!!)\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g,
      (_m, label, href) => {
        scan.links.push({ text: String(label), href: String(href), line });
        return '';
      },
    );
    work.replace(/<a\b[^>]*?\bhref=["']([^"']+)["'][^>]*>/gi, (_m, href) => {
      scan.links.push({ text: '', href: String(href), line });
      return '';
    });
    work.replace(/(?<!!)\[([^\]]+)\]\[([^\]]*)\]/g, (_m, label, ref) => {
      const key = (emptyToNull(String(ref)) ?? String(label)).toLowerCase();
      const href = refs.get(key);
      if (href) scan.links.push({ text: String(label), href, line });
      return '';
    });
  }
  return scan;
}

export interface LinkContext {
  repo: string;
  sha: string;
  /** Every file path in the tree. */
  paths: Set<string>;
  /** Every directory path in the tree. */
  dirs: Set<string>;
  /** Heading anchors of each parsed Markdown file, for cross-file anchor checks. */
  anchors: Map<string, Set<string>>;
}

function normalize(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join('/');
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export function rawUrl(ctx: LinkContext, path: string): string {
  return `https://raw.githubusercontent.com/${ctx.repo}/${ctx.sha}/${path}`;
}

interface Resolved {
  kind: MdLink['kind'];
  target: string | null;
  status: MdLink['status'];
  reason: string | null;
}

/** Works out what a link points at and, for repository links, whether it exists. */
export function resolveLink(href: string, fromPath: string, ctx: LinkContext): Resolved {
  const link = href.trim();
  if (/^mailto:/i.test(link)) return { kind: 'mailto', target: null, status: 'ok', reason: null };
  if (/^(https?:)?\/\//i.test(link)) {
    return {
      kind: 'external',
      target: null,
      status: 'unchecked',
      reason: 'external links are not fetched',
    };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(link)) {
    return { kind: 'external', target: null, status: 'unchecked', reason: 'unsupported scheme' };
  }

  const hashAt = link.indexOf('#');
  const fragment = hashAt >= 0 ? safeDecode(link.slice(hashAt + 1)).toLowerCase() : '';
  const pathPart = (hashAt >= 0 ? link.slice(0, hashAt) : link).split('?')[0] ?? '';

  if (pathPart === '') {
    if (fragment === '' || fragment === 'top')
      return { kind: 'anchor', target: fromPath, status: 'ok', reason: null };
    const ok = ctx.anchors.get(fromPath)?.has(fragment) ?? false;
    return {
      kind: 'anchor',
      target: fromPath,
      status: ok ? 'ok' : 'broken',
      reason: ok ? null : `no heading "#${fragment}" in this document`,
    };
  }

  const decoded = safeDecode(pathPart);
  const joined = decoded.startsWith('/')
    ? decoded
    : `${dirname(fromPath) === '.' ? '' : dirname(fromPath)}/${decoded}`;
  const target = normalize(joined);
  if (target === null) {
    return {
      kind: 'internal',
      target: null,
      status: 'broken',
      reason: 'points outside the repository',
    };
  }
  if (!ctx.paths.has(target) && !ctx.dirs.has(target) && target !== '') {
    return { kind: 'internal', target, status: 'broken', reason: 'file not found in this commit' };
  }
  if (fragment && ctx.paths.has(target)) {
    const anchors = ctx.anchors.get(target);
    if (anchors && !anchors.has(fragment)) {
      return {
        kind: 'internal',
        target,
        status: 'broken',
        reason: `no heading "#${fragment}" in ${target}`,
      };
    }
  }
  return { kind: 'internal', target, status: 'ok', reason: null };
}

export function isReadmePath(path: string): boolean {
  return /^readme(\.[\w-]+)?\.(md|mdx|markdown)$/i.test(path.slice(path.lastIndexOf('/') + 1));
}

/** Structure of one Markdown file: sections (with tables and code kept), links and assets. */
export function parseMarkdown(
  text: string,
  path: string,
): Omit<MdDocument, 'links' | 'assets'> & {
  rawLinks: Scan['links'];
  rawImages: Scan['images'];
} {
  const lines = text.split(/\r?\n/);
  const first = stripFrontMatter(lines);

  const preamble: Raw = { heading: null, level: 0, startLine: first + 1, lines: [] };
  const raws: Raw[] = [preamble];
  let current = preamble;
  const inlineLines: { text: string; line: number }[] = [];
  let fence: string | null = null;

  for (let i = first; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const fenceMatch = FENCE.exec(line);

    if (fence) {
      current.lines.push(line);
      if (closesFence(fence, fenceMatch?.[1]) && !fenceMatch?.[2]) fence = null;
      continue;
    }
    if (fenceMatch?.[1]) {
      fence = fenceMatch[1];
      current.lines.push(line);
      continue;
    }

    let heading: { level: number; title: string } | null = null;
    const atx = ATX.exec(line);
    if (atx?.[1]) heading = { level: atx[1].length, title: (atx[2] ?? '').trim() };
    else if (
      line.trim() !== '' &&
      /^ {0,3}(=+|-+)\s*$/.test(lines[i + 1] ?? '') &&
      !/^\s*[-*+>|]/.test(line)
    ) {
      heading = { level: (lines[i + 1] ?? '').trim().startsWith('=') ? 1 : 2, title: line.trim() };
      i += 1;
    }

    if (heading) {
      inlineLines.push({ text: line, line: i + 1 });
      current = {
        heading: heading.title,
        level: heading.level,
        startLine: i + 1 - (atx ? 0 : 1),
        lines: [line],
      };
      raws.push(current);
      continue;
    }
    current.lines.push(line);
    inlineLines.push({ text: line, line: i + 1 });
  }

  const sections: MdSection[] = [];
  const trailStack: { level: number; title: string }[] = [];
  const seen = new Map<string, number>();

  for (const raw of raws) {
    if (raw.heading === null && raw.lines.every((l) => l.trim() === '')) continue;
    if (raw.heading !== null) {
      while (
        trailStack.length &&
        (trailStack[trailStack.length - 1] as { level: number }).level >= raw.level
      )
        trailStack.pop();
      trailStack.push({ level: raw.level, title: raw.heading });
    }
    let slug: string | null = null;
    if (raw.heading !== null) {
      const base = slugify(raw.heading);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      slug = count === 0 ? base : `${base}-${count}`;
    }

    const codeBlocks: MdCodeBlock[] = [];
    const tables: MdTable[] = [];
    let open: { lang: string | null; start: number; fence: string; body: string[] } | null = null;
    for (let k = 0; k < raw.lines.length; k++) {
      const line = raw.lines[k] ?? '';
      const f = FENCE.exec(line);
      if (open) {
        if (closesFence(open.fence, f?.[1]) && !f?.[2]) {
          codeBlocks.push({ lang: open.lang, code: open.body.join('\n'), startLine: open.start });
          open = null;
        } else open.body.push(line);
        continue;
      }
      if (f?.[1]) {
        open = { lang: emptyToNull(f[2]), start: raw.startLine + k, fence: f[1], body: [] };
        continue;
      }
      if (
        line.includes('|') &&
        TABLE_SEPARATOR.test(raw.lines[k + 1] ?? '') &&
        !TABLE_SEPARATOR.test(line)
      ) {
        const rows = [splitRow(line)];
        let n = k + 2;
        while (
          n < raw.lines.length &&
          (raw.lines[n] ?? '').includes('|') &&
          (raw.lines[n] ?? '').trim() !== ''
        ) {
          rows.push(splitRow(raw.lines[n] ?? ''));
          n += 1;
        }
        tables.push({ startLine: raw.startLine + k, rows });
        k = n - 1;
      }
    }
    if (open)
      codeBlocks.push({ lang: open.lang, code: open.body.join('\n'), startLine: open.start });

    const body = raw.lines.join('\n').replace(/\s+$/, '');
    sections.push({
      heading: raw.heading,
      level: raw.level,
      trail: trailStack.map((t) => t.title),
      slug,
      startLine: raw.startLine,
      endLine: raw.startLine + raw.lines.length - 1,
      text: body,
      codeBlocks,
      tables,
    });
  }

  const scan = scanInline(inlineLines);
  const title = sections.find((s) => s.level === 1)?.heading ?? null;
  return {
    path,
    title,
    isReadme: isReadmePath(path),
    sections,
    rawLinks: scan.links,
    rawImages: scan.images,
  };
}

/** Resolves every link and image of a parsed document against the repository tree. */
export function resolveDocument(
  parsed: ReturnType<typeof parseMarkdown>,
  ctx: LinkContext,
): MdDocument {
  const links: MdLink[] = parsed.rawLinks.map((link) => ({
    text: link.text,
    href: link.href,
    line: link.line,
    ...resolveLink(link.href, parsed.path, ctx),
  }));

  const assets: MdAsset[] = parsed.rawImages.map((image) => {
    const resolved = resolveLink(image.src, parsed.path, ctx);
    if (resolved.kind === 'external' || resolved.kind === 'mailto') {
      return {
        alt: image.alt,
        src: image.src,
        line: image.line,
        kind: 'external',
        target: null,
        exists: null,
        rawUrl: null,
      };
    }
    const exists =
      resolved.status === 'ok' && resolved.target !== null && ctx.paths.has(resolved.target);
    return {
      alt: image.alt,
      src: image.src,
      line: image.line,
      kind: 'internal',
      target: resolved.target,
      exists,
      rawUrl: exists && resolved.target ? rawUrl(ctx, resolved.target) : null,
    };
  });

  return {
    path: parsed.path,
    title: parsed.title,
    isReadme: parsed.isReadme,
    sections: parsed.sections,
    links,
    assets,
  };
}

/** The standard community files and whether each exists at the repository root. */
export function missingDocuments(rootNames: string[]): { name: string; present: boolean }[] {
  const lower = rootNames.map((n) => n.toLowerCase());
  const has = (re: RegExp) => lower.some((n) => re.test(n));
  return [
    { name: 'README', present: has(/^readme(\.|$)/) },
    { name: 'LICENSE', present: has(/^(license|licence|copying)(\.|$)/) },
    { name: 'CONTRIBUTING', present: has(/^contributing(\.|$)/) },
    { name: 'CODE_OF_CONDUCT', present: has(/^code[_-]of[_-]conduct(\.|$)/) },
    { name: 'SECURITY', present: has(/^security(\.|$)/) },
    { name: 'CHANGELOG', present: has(/^(changelog|changes|history|releases)(\.|$)/) },
  ];
}
