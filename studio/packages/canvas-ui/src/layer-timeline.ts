export interface TimelineLayer {
  id: string;
  seq: number;
  parent_id: string | null;
  redo_of: string | null;
}
export interface TimelineNode {
  id: string;
  row: number;
  lane: number;
  parentId: string | null;
  redoOf: string | null;
  missingParent: boolean;
}
export interface LayerTimeline {
  nodes: TimelineNode[];
  byId: Map<string, TimelineNode>;
  laneCount: number;
  width: number;
}
const LANE_GAP = 14,
  LANE_START = 18;
export const laneX = (lane: number) => LANE_START + lane * LANE_GAP;
/** Keep a branch in its lane while it is alive; reuse lanes only after its last row. */
export function buildLayerTimeline(
  layers: readonly TimelineLayer[],
): LayerTimeline {
  const ordered = [...layers].sort(
    (a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const rows = new Map(ordered.map((layer, row) => [layer.id, row]));
  const byLayer = new Map(ordered.map((l) => [l.id, l]));
  const firstChild = new Map<string, string>();
  for (const layer of ordered)
    if (
      layer.parent_id &&
      rows.has(layer.parent_id) &&
      layer.parent_id !== layer.id &&
      !firstChild.has(layer.parent_id)
    )
      firstChild.set(layer.parent_id, layer.id);
  const visited = new Set<string>();
  const chains: { ids: string[]; start: number; end: number }[] = [];
  const addChain = (first: TimelineLayer) => {
    const ids: string[] = [];
    let current: TimelineLayer | undefined = first;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      ids.push(current.id);
      const next = firstChild.get(current.id);
      current = next ? byLayer.get(next) : undefined;
    }
    if (!ids.length) return;
    const firstRow = rows.get(first.id)!;
    const start = Math.min(
      firstRow,
      first.parent_id ? (rows.get(first.parent_id) ?? firstRow) : firstRow,
    );
    chains.push({
      ids,
      start,
      end: ids.reduce((end, id) => Math.max(end, rows.get(id)!), firstRow),
    });
  };
  for (const layer of ordered)
    if (
      !layer.parent_id ||
      !rows.has(layer.parent_id) ||
      firstChild.get(layer.parent_id) !== layer.id
    )
      addChain(layer);
  // Malformed/cyclic input should not lock up the UI, even though storage rejects it.
  for (const layer of ordered) if (!visited.has(layer.id)) addChain(layer);
  chains.sort(
    (a, b) => a.start - b.start || rows.get(a.ids[0]!)! - rows.get(b.ids[0]!)!,
  );
  const laneEnds: number[] = [],
    lanes = new Map<string, number>();
  for (const chain of chains) {
    let lane = laneEnds.findIndex((end) => end < chain.start);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = chain.end;
    for (const id of chain.ids) lanes.set(id, lane);
  }
  const nodes = ordered.map((l, row) => ({
    id: l.id,
    row,
    lane: lanes.get(l.id)!,
    parentId: l.parent_id,
    redoOf: l.redo_of,
    missingParent: l.parent_id !== null && !rows.has(l.parent_id),
  }));
  const laneCount = Math.max(1, laneEnds.length);
  return {
    nodes,
    byId: new Map(nodes.map((n) => [n.id, n])),
    laneCount,
    width: 36 + (laneCount - 1) * LANE_GAP,
  };
}
export function timelineEdges(
  layout: LayerTimeline,
  centers: readonly number[],
): {
  from: string;
  to: string;
  kind: "parent" | "redo";
  lane: number;
  d: string;
}[] {
  const edges: {
    from: string;
    to: string;
    kind: "parent" | "redo";
    lane: number;
    d: string;
  }[] = [];
  for (const node of layout.nodes) {
    const parent = node.parentId ? layout.byId.get(node.parentId) : undefined;
    const x = laneX(node.lane),
      y = centers[node.row] ?? node.row * 78 + 37;
    if (parent) {
      const px = laneX(parent.lane),
        py = centers[parent.row] ?? parent.row * 78 + 37;
      const step = Math.min(18, Math.abs(y - py) / 2) * Math.sign(y - py);
      edges.push({
        from: parent.id,
        to: node.id,
        kind: "parent",
        lane: node.lane,
        d:
          px === x
            ? `M ${px} ${py} L ${x} ${y}`
            : `M ${px} ${py} C ${px} ${py + step} ${x} ${py + step} ${x} ${py + step * 2} L ${x} ${y}`,
      });
    }
    const previous = node.redoOf ? layout.byId.get(node.redoOf) : undefined;
    if (previous) {
      const px = laneX(previous.lane),
        py = centers[previous.row] ?? previous.row * 78 + 37;
      edges.push({
        from: previous.id,
        to: node.id,
        kind: "redo",
        lane: node.lane,
        d: `M ${px} ${py} Q ${Math.max(px, x) + 10} ${(py + y) / 2} ${x} ${y}`,
      });
    }
  }
  return edges;
}
