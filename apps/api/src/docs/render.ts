import { posix } from 'node:path';
import { Marked, type Tokens } from 'marked';
import { parseCitations } from '../rag/citations.js';

export type LinkMode =
  { mode: 'github'; fullName: string; sha: string } | { mode: 'relative'; from: string };

/** Turns [[path:a-b]] markers into Markdown links, pinned to the commit or relative to the file. */
export function linkCitations(markdown: string, links: LinkMode): string {
  let out = markdown;
  for (const c of parseCitations(markdown)) {
    const lines = c.startLine === c.endLine ? `L${c.startLine}` : `L${c.startLine}-L${c.endLine}`;
    const label = c.startLine === c.endLine ? `${c.path}:${c.startLine}` : `${c.path}:${c.startLine}-${c.endLine}`;
    const href =
      links.mode === 'github'
        ? `https://github.com/${links.fullName}/blob/${links.sha}/${c.path}#${lines}`
        : `${posix.relative(posix.dirname(links.from), c.path) || posix.basename(c.path)}#${lines}`;
    out = out.split(c.raw).join(`([${label}](${encodeURI(href)}))`);
  }
  return out;
} // prettier-ignore

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SAFE_HREF = /^(https?:\/\/|mailto:|#|\.{0,2}\/|[\w-][\w./-]*(#[\w-]*)?$)/i;

/** Markdown to HTML with raw HTML shown as text and only safe link targets kept. */
const marked = new Marked({
  gfm: true,
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(text);
    },
    link({ href, title, tokens }: Tokens.Link): string {
      const inner = this.parser.parseInline(tokens);
      if (!SAFE_HREF.test(href) || /^\s*(javascript|data|vbscript):/i.test(href)) return inner;
      const t = title ? ` title="${escapeHtml(title)}"` : '';
      return `<a href="${escapeHtml(href)}"${t} rel="noreferrer">${inner}</a>`;
    },
    image({ href, text }: Tokens.Image): string {
      return /^https?:\/\//.test(href) || !href.includes(':')
        ? `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}">`
        : escapeHtml(text);
    },
  },
});

export function toHtml(markdown: string, title: string): string {
  const body = marked.parse(markdown, { async: false });
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>body{font:16px/1.6 system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#1f2328}',
    'pre,code{background:#f6f8fa;border-radius:6px}pre{padding:1rem;overflow:auto}code{padding:.1em .3em}',
    'table{border-collapse:collapse}td,th{border:1px solid #d0d7de;padding:.3rem .6rem}',
    'blockquote{color:#59636e;border-left:4px solid #d0d7de;margin:0;padding-left:1rem}</style>',
    `</head><body>${body}</body></html>`,
  ].join('\n');
}
