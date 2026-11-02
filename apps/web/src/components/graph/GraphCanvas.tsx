import type { ViewEdge, ViewNode } from '@repointelligence/shared';
import { Background, Controls, MarkerType, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMemo } from 'react';
import { LAYER_COLOR, layoutByLayer } from './layout';

export interface GraphCanvasProps {
  nodes: ViewNode[];
  edges: ViewEdge[];
  onSelect: (node: ViewNode) => void;
}

/** The interactive graph. Loaded lazily because React Flow is large. */
export default function GraphCanvas({ nodes, edges, onSelect }: GraphCanvasProps) {
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n] as const)), [nodes]);
  const flowNodes = useMemo<Node[]>(() => {
    const positions = new Map(layoutByLayer(nodes, edges).map((p) => [p.id, p] as const));
    return nodes.map((node) => ({
      id: node.id,
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      data: { label: node.label },
      style: {
        background: node.layer ? LAYER_COLOR[node.layer] : '#f3f4f6',
        color: '#111827',
        border: node.inCycle ? '2px solid #dc2626' : '1px solid #9ca3af',
        borderRadius: 6,
        fontSize: 12,
        padding: 6,
        width: 180,
      },
    }));
  }, [nodes, edges]);
  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        label: edge.weight > 1 ? String(edge.weight) : undefined,
        animated: edge.violation,
        style: {
          stroke: edge.violation ? '#dc2626' : edge.kind === 'extends' ? '#7c3aed' : '#6b7280',
        },
        markerEnd: { type: MarkerType.ArrowClosed },
      })),
    [edges],
  );
  return (
    <div className="h-[520px] rounded-md border" data-testid="graph-canvas">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        fitView
        minZoom={0.1}
        nodesDraggable={false}
        onNodeClick={(_event, node) => {
          const selected = byId.get(node.id);
          if (selected) onSelect(selected);
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
