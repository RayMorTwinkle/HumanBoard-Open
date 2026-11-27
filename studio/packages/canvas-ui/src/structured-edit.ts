import {
  compileDiagram,
  DiagramSchema,
  type Scene,
} from "@humanboard/schema/scene";
/** Translate ordinary editor actions into structural edits, then materialize coordinates. */
export function structuredEdit(
  before: Scene,
  next: Scene,
  selected: string | null,
): Scene {
  if (!next.diagram) return next;
  const d = structuredClone(next.diagram);
  if (JSON.stringify(before.diagram) === JSON.stringify(next.diagram)) {
    const removed = new Set(
      before.nodes
        .filter((n) => !next.nodes.some((m) => m.id === n.id))
        .map((n) => n.id),
    );
    if (d.mode === "mindmap")
      for (let i = 0; i < d.nodes.length; i++)
        for (const n of d.nodes)
          if (n.parent && removed.has(n.parent)) removed.add(n.id);
    d.nodes = d.nodes.filter((n) => !removed.has(n.id));
    for (const node of next.nodes) {
      if (removed.has(node.id)) continue;
      const old = before.nodes.find((n) => n.id === node.id);
      let item = d.nodes.find((n) => n.id === node.id);
      if (!item) {
        item = {
          id: node.id,
          title: node.title,
          role: "step",
          ...(d.mode === "mindmap" && d.nodes.length
            ? {
                parent:
                  d.nodes.find((n) => n.id === selected)?.id ??
                  d.nodes.find((n) => !n.parent)!.id,
              }
            : {}),
        };
        d.nodes.push(item);
      }
      item.role =
        node.style?.shape === "diamond"
          ? "decision"
          : node.style?.shape === "ellipse"
            ? "terminal"
            : "step";
      item.parentLabel = next.edges.find(
        (e) => e.id === `tree:${node.id}`,
      )?.label;
      item.title = node.title;
      item.sub = node.sub;
      if (!old || node.style?.color !== old.style?.color)
        item.color =
          typeof node.style?.color === "string" ? node.style.color : undefined;
      if (old && (node.rect.x !== old.rect.x || node.rect.y !== old.rect.y)) {
        if (d.mode === "mindmap" && item.parent) {
          const target = next.nodes.find(
            (n) =>
              n.id !== node.id &&
              node.rect.x + node.rect.w / 2 >= n.rect.x &&
              node.rect.x + node.rect.w / 2 <= n.rect.x + n.rect.w &&
              node.rect.y + node.rect.h / 2 >= n.rect.y &&
              node.rect.y + node.rect.h / 2 <= n.rect.y + n.rect.h,
          );
          if (target) {
            let ancestor = d.nodes.find((n) => n.id === target.id);
            let cycle = false;
            while (ancestor) {
              if (ancestor.id === item.id) {
                cycle = true;
                break;
              }
              ancestor = d.nodes.find((n) => n.id === ancestor?.parent);
            }
            if (!cycle) item.parent = target.id;
          }
        }
        const peers = d.nodes.filter((n) =>
          d.mode === "mindmap" ? n.parent === item!.parent : true,
        );
        peers
          .sort((a, b) => {
            const pa = next.nodes.find((n) => n.id === a.id)?.rect,
              pb = next.nodes.find((n) => n.id === b.id)?.rect;
            return d.layout === "down"
              ? (pa?.x ?? 0) - (pb?.x ?? 0)
              : (pa?.y ?? 0) - (pb?.y ?? 0);
          })
          .forEach((n, index) => (n.order = index));
      }
    }
    d.edges = next.edges
      .filter(
        (e) =>
          !(d.mode === "mindmap" && e.id.startsWith("tree:")) &&
          !removed.has(e.from.node_id) &&
          !removed.has(e.to.node_id),
      )
      .map((e) => ({
        id: e.id,
        from: e.from.node_id,
        to: e.to.node_id,
        label: e.label,
        dashed: e.style?.dashed,
        color: e.style?.color,
        curve: e.style?.curve,
        arrow: e.style?.arrow,
      }));
  }
  const explicitLayout =
    before.diagram?.layout !== next.diagram?.layout ||
    (before.diagram?.layout_revision ?? 0) !==
      (next.diagram?.layout_revision ?? 0) ||
    before.diagram?.mode !== next.diagram?.mode ||
    next.nodes.some((n) => {
      const old = before.nodes.find((p) => p.id === n.id);
      return old && (old.rect.x !== n.rect.x || old.rect.y !== n.rect.y);
    });
  if (
    explicitLayout &&
    before.diagram &&
    before.diagram.layout === next.diagram?.layout &&
    before.diagram.mode === next.diagram?.mode &&
    (before.diagram.layout_revision ?? 0) ===
      (next.diagram?.layout_revision ?? 0)
  )
    d.layout_revision = (d.layout_revision ?? 0) + 1;
  const diagram = DiagramSchema.parse(JSON.parse(JSON.stringify(d))),
    compiled = compileDiagram(diagram, explicitLayout ? [] : before.nodes);
  return { ...next, diagram, nodes: compiled.nodes, edges: compiled.edges };
}
