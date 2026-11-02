import type { Layer, ViewEdge, ViewNode } from '@repointelligence/shared';

export const LAYER_ORDER: Layer[] = [
  'presentation',
  'service',
  'integration',
  'data',
  'config',
  'test',
  'other',
];

export const LAYER_COLOR: Record<Layer, string> = {
  presentation: '#dbeafe',
  service: '#dcfce7',
  data: '#fef3c7',
  integration: '#ede9fe',
  config: '#e5e7eb',
  test: '#fce7f3',
  other: '#f3f4f6',
};

export interface Positioned {
  id: string;
  x: number;
  y: number;
}

/**
 * Rows by layer (presentation at the top, data at the bottom), nodes spread along each row.
 * Good enough to read a dependency direction without a layout library.
 */
export function layoutByLayer(nodes: ViewNode[], _edges: ViewEdge[]): Positioned[] {
  const rows = new Map<number, ViewNode[]>();
  for (const node of nodes) {
    const row = node.layer ? LAYER_ORDER.indexOf(node.layer) : LAYER_ORDER.length;
    rows.set(row, [...(rows.get(row) ?? []), node]);
  }
  const positioned: Positioned[] = [];
  const rowHeight = 120;
  const columnWidth = 220;
  for (const [row, members] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    members.sort((a, b) => b.size - a.size || a.label.localeCompare(b.label));
    const perLine = Math.max(1, Math.ceil(Math.sqrt(members.length * 2)));
    members.forEach((node, index) => {
      positioned.push({
        id: node.id,
        x: (index % perLine) * columnWidth,
        y:
          row * rowHeight * Math.max(1, Math.ceil(members.length / perLine)) +
          Math.floor(index / perLine) * rowHeight,
      });
    });
  }
  return positioned;
}
