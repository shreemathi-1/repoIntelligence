import { useEffect, useId, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Citation } from '@repointelligence/shared';

const MARKER = /\[\[([^[\]:\s][^[\]:]*):(\d+)-(\d+)\]\]/g;

/** Turns citation markers into links with a private scheme the preview handles itself. */
function withCitationLinks(markdown: string): string {
  return markdown.replace(MARKER, (_m, path: string, start: string, end: string) => {
    const label = start === end ? `${path}:${start}` : `${path}:${start}-${end}`;
    return `[${label}](cite:${encodeURIComponent(path)}?${start}-${end})`;
  });
}

function parseCite(href: string): Citation | null {
  const m = /^cite:([^?]+)\?(\d+)-(\d+)$/.exec(href);
  if (!m) return null;
  return { path: decodeURIComponent(m[1] ?? ''), startLine: Number(m[2]), endLine: Number(m[3]) };
}

/** Renders Mermaid lazily, in strict mode, which strips scripts and event handlers. */
function MermaidBlock({ code }: { code: string }) {
  const id = `m${useId().replace(/[^\w]/g, '')}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    import('mermaid')
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
        const out = await mermaid.render(id, code);
        if (alive) setSvg(out.svg);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [code, id]);
  if (svg && !failed) {
    // Mermaid's strict mode sanitises its own SVG output.
    return (
      <div
        className="overflow-auto"
        data-testid="mermaid"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }
  return (
    <pre className="bg-muted overflow-auto rounded-md p-3 text-xs">
      {failed ? `Diagram could not be drawn:\n${code}` : code}
    </pre>
  );
}

export interface MarkdownPreviewProps {
  content: string;
  onCite?: (citation: Citation) => void;
}

/** Markdown without raw HTML; citation markers become buttons that open the cited lines. */
export function MarkdownPreview({ content, onCite }: MarkdownPreviewProps) {
  return (
    <div className="prose-sm max-w-none space-y-3 text-sm leading-6 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:font-semibold [&_table]:w-full [&_td]:border [&_td]:px-2 [&_th]:border [&_th]:px-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_blockquote]:text-muted-foreground [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_code]:bg-muted [&_code]:rounded [&_code]:px-1">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => (url.startsWith('cite:') ? url : defaultUrlTransform(url))}
        components={{
          a({ href = '', children }) {
            const citation = parseCite(href);
            if (citation) {
              return (
                <button
                  type="button"
                  className="bg-muted hover:bg-accent rounded px-1 font-mono text-xs"
                  onClick={() => onCite?.(citation)}
                >
                  {children}
                </button>
              );
            }
            return (
              <a href={href} className="underline" rel="noreferrer" target="_blank">
                {children}
              </a>
            );
          },
          pre({ node, children }) {
            const first = node?.children[0];
            const classes = first?.type === 'element' ? first.properties.className : undefined;
            if (Array.isArray(classes) && classes.includes('language-mermaid') && first?.type === 'element') {
              const text = first.children.map((c) => (c.type === 'text' ? c.value : '')).join('');
              return <MermaidBlock code={text.replace(/\n$/, '')} />;
            }
            return <pre className="bg-muted overflow-auto rounded-md p-3 text-xs">{children}</pre>;
          },
        }}
      >
        {withCitationLinks(content)}
      </ReactMarkdown>
    </div>
  );
} // prettier-ignore
