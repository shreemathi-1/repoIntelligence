import type { FolderNode } from '@repointelligence/shared';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';

export function FolderTree({
  node,
  onOpen,
  depth = 0,
}: {
  node: FolderNode;
  onOpen: (path: string) => void;
  depth?: number;
}) {
  const [open, setOpen] = useState(depth < 1);
  return (
    <li>
      <div
        className="flex flex-wrap items-center gap-2 py-0.5 text-sm"
        style={{ paddingLeft: depth * 12 }}
      >
        {node.children.length > 0 ? (
          <button
            type="button"
            className="w-4 text-left"
            aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`}
            onClick={() => {
              setOpen((v) => !v);
            }}
          >
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-4" />
        )}
        <button
          type="button"
          className="font-mono underline-offset-2 hover:underline"
          onClick={() => {
            onOpen(node.path);
          }}
        >
          {node.name}
        </button>
        <span className="text-muted-foreground text-xs">
          {node.files} file{node.files === 1 ? '' : 's'} · {node.lines.toLocaleString()} lines
        </span>
        {node.layer && node.layer !== 'other' && <Badge variant="outline">{node.layer}</Badge>}
        {node.purpose && <span className="text-muted-foreground text-xs">{node.purpose}</span>}
      </div>
      {open && node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <FolderTree key={child.path} node={child} onOpen={onOpen} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}
