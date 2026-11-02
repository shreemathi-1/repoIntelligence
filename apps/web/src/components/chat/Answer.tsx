import type { Citation } from '@repointelligence/shared';

const MARKER = /\[\[([^[\]:\s][^[\]:]*):(\d+)-(\d+)\]\]/g;

export interface AnswerTextProps {
  content: string;
  onCite: (citation: Citation) => void;
}

/**
 * Renders an answer as plain text with its citation markers turned into buttons. Nothing the
 * model wrote is interpreted as HTML.
 */
export function AnswerText({ content, onCite }: AnswerTextProps) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of content.matchAll(MARKER)) {
    const index = match.index;
    if (index > last) parts.push(content.slice(last, index));
    const citation = {
      path: match[1] ?? '',
      startLine: Number(match[2]),
      endLine: Number(match[3]),
    };
    const label =
      citation.startLine === citation.endLine
        ? `${citation.path}:${citation.startLine}`
        : `${citation.path}:${citation.startLine}-${citation.endLine}`;
    parts.push(
      <button
        key={`${index}-${label}`}
        type="button"
        className="bg-muted hover:bg-accent mx-0.5 rounded px-1 font-mono text-xs underline-offset-2 hover:underline"
        onClick={() => {
          onCite(citation);
        }}
      >
        {label}
      </button>,
    );
    last = index + match[0].length;
  }
  if (last < content.length) parts.push(content.slice(last));
  return <div className="whitespace-pre-wrap break-words text-sm leading-6">{parts}</div>;
}
