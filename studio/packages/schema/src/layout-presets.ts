import type { Scene } from "./schema";
import { compileDiagram } from "./diagram";

export const presets = ["hierarchy", "lanes", "mindmap"] as const;
export type LayoutPreset = (typeof presets)[number];

/** Rank actual connections. For a mind map, choose a spanning forest while
 * retaining all original cross-links; lanes group nodes by kind. */
export function layoutScene(scene: Scene, preset: LayoutPreset): Scene {
  if (!scene.nodes.length) return scene;
  const nodes = scene.nodes;
  const edges = scene.edges.map((e) => ({
    id: e.id,
    from: e.from.node_id,
    to: e.to.node_id,
  }));
  const ranked = compileDiagram({
    mode: "logic",
    layout: "right",
    nodes: nodes.map((n) => ({ id: n.id, title: n.title })),
    edges,
  });
  const groups = new Map<number, string[]>();
  for (const n of ranked.nodes) {
    const list = groups.get(n.rect.x) ?? [];
    list.push(n.id);
    groups.set(n.rect.x, list);
  }
  const rank = new Map(
    [...groups.keys()].sort((a, b) => a - b).map((v, i) => [v, i]),
  );
  const sizes = new Map(nodes.map((n) => [n.id, n.rect]));
  const coords = new Map<string, { x: number; y: number }>();
  const dx = Math.max(160, ...nodes.map((n) => n.rect.w)) + 72;
  if (preset === "mindmap") {
    const byParent = new Map<string, string[]>(),
      incoming = new Set<string>();
    for (const e of edges) {
      const list = byParent.get(e.from) ?? [];
      list.push(e.to);
      byParent.set(e.from, list);
      incoming.add(e.to);
    }
    const parents = new Map<string, string>(),
      roots: string[] = [];
    for (const n of [...nodes.filter((n) => !incoming.has(n.id)), ...nodes]) {
      if (parents.has(n.id)) continue;
      roots.push(n.id);
      parents.set(n.id, "");
      const queue = [n.id];
      for (let i = 0; i < queue.length; i++)
        for (const child of byParent.get(queue[i]!) ?? []) {
          if (parents.has(child)) continue;
          parents.set(child, queue[i]!);
          queue.push(child);
        }
    }
    let top = 0;
    for (const root of roots) {
      const tree = new Set<string>([root]);
      for (const [id, parent] of parents) if (tree.has(parent)) tree.add(id);
      const layout = compileDiagram({
        mode: "mindmap",
        layout: "bilateral",
        nodes: nodes
          .filter((n) => tree.has(n.id))
          .map((n) => ({
            id: n.id,
            title: n.title,
            sub: n.sub,
            parent: parents.get(n.id) || undefined,
          })),
      });
      // Columns accommodate original free-board dimensions, including oversized nodes.
      const columns = [...new Set(layout.nodes.map((n) => n.rect.x))].sort(
        (a, b) => a - b,
      );
      const middle = columns.indexOf(0);
      const stepY = Math.max(96, ...nodes.map((n) => n.rect.h)) + 40;
      const rows = [
        ...new Set(layout.nodes.map((n) => n.rect.y + n.rect.h / 2)),
      ].sort((a, b) => a - b);
      for (const n of layout.nodes)
        coords.set(n.id, {
          x: (columns.indexOf(n.rect.x) - middle) * dx,
          y: top + rows.indexOf(n.rect.y + n.rect.h / 2) * stepY,
        });
      top += rows.length * stepY + 96;
    }
  } else if (preset === "lanes") {
    const kinds = [...new Set(nodes.map((n) => n.kind))];
    let y = 0;
    for (const kind of kinds) {
      const lane = nodes.filter((n) => n.kind === kind);
      const ranks = new Map(
        ranked.nodes.map((n) => [n.id, rank.get(n.rect.x)!]),
      );
      lane.sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)!);
      let column = 0;
      for (const n of lane) {
        column = Math.max(column, ranks.get(n.id)!);
        coords.set(n.id, { x: column++ * dx, y });
      }
      y += Math.max(...lane.map((n) => n.rect.h)) + 96;
    }
  } else {
    for (const [x, ids] of groups) {
      let y = 0;
      for (const id of ids) {
        coords.set(id, { x: rank.get(x)! * dx, y });
        y += sizes.get(id)!.h + 44;
      }
    }
  }
  return {
    ...scene,
    nodes: nodes.map((n) => ({
      ...n,
      rect: { ...n.rect, ...coords.get(n.id)! },
    })),
  };
}
