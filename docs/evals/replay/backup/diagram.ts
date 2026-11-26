import { z } from "zod";
import type { Scene, Node, Edge } from "./schema";
import { facingAnchors } from "./defaults";
import { diagramNodeSize } from "./text-layout";

/** Coordinate-free authoring contract. Free boards continue to use Scene directly. */
export const DiagramSchema = z
  .object({
    mode: z.enum(["mindmap", "logic"]),
    layout: z.enum(["right", "down", "bilateral"]).default("right"),
    layout_revision: z.number().int().nonnegative().optional(),
    nodes: z
      .array(
        z
          .object({
            id: z.string().min(1),
            title: z.string(),
            sub: z.string().optional(),
            parent: z.string().optional(),
            parentLabel: z.string().optional(),
            order: z.number().finite().optional(),
            color: z.string().optional(),
            role: z.enum(["step", "decision", "terminal"]).default("step"),
          })
          .strict(),
      )
      .max(500),
    edges: z
      .array(
        z
          .object({
            id: z.string().min(1),
            from: z.string(),
            to: z.string(),
            label: z.string().optional(),
            dashed: z.boolean().optional(),
            color: z.string().optional(),
            curve: z.boolean().optional(),
            arrow: z.enum(["end", "both", "none"]).optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type Diagram = z.input<typeof DiagramSchema>;

/** Deterministic layout; rejects structural ambiguity instead of silently dropping content. */
export function compileDiagram(
  input: Diagram,
  previous: readonly Node[] = [],
): Scene {
  const d = DiagramSchema.parse(input);
  if (d.mode === "logic" && d.layout === "bilateral")
    throw new Error("Logic diagrams support right or down layout");
  const ids = new Set(d.nodes.map((n) => n.id));
  if (ids.size !== d.nodes.length) throw new Error("Duplicate node id");
  const byId = new Map(d.nodes.map((n) => [n.id, n]));
  const connections = [...d.edges];
  if (d.mode === "mindmap") {
    if (d.nodes.length && d.nodes.filter((n) => !n.parent).length !== 1)
      throw new Error("Mindmap requires exactly one root");
    for (const n of d.nodes) {
      if (n.parent) {
        if (!ids.has(n.parent)) throw new Error(`Unknown parent ${n.parent}`);
        connections.push({
          id: `tree:${n.id}`,
          from: n.parent,
          to: n.id,
          label: n.parentLabel,
        });
      }
      const visited = new Set<string>();
      let current: typeof n | undefined = n;
      while (current) {
        if (visited.has(current.id)) throw new Error("Mindmap parent cycle");
        visited.add(current.id);
        current = current.parent ? byId.get(current.parent) : undefined;
      }
    }
  } else if (d.nodes.some((n) => n.parent))
    throw new Error("Logic nodes use edges, not parents");
  if (new Set(connections.map((e) => e.id)).size !== connections.length)
    throw new Error("Duplicate edge id");
  for (const e of connections)
    if (!ids.has(e.from) || !ids.has(e.to))
      throw new Error(`Unknown edge endpoint ${e.id}`);
  const sorted = [...d.nodes].sort(
    (a, b) => (a.order ?? d.nodes.indexOf(a)) - (b.order ?? d.nodes.indexOf(b)),
  );
  const sizes = new Map(
    sorted.map((n) => [n.id, diagramNodeSize(n.title, n.sub, n.role)]),
  );
  const cross = (id: string) =>
    d.layout === "down" ? sizes.get(id)!.w : sizes.get(id)!.h;
  const depthGap = Math.max(
    320,
    ...[...sizes.values()].map((s) => (d.layout === "down" ? s.h : s.w) + 80),
  );
  const positions = new Map<string, { x: number; y: number }>();
  if (d.mode === "mindmap" && sorted.length) {
    const children = (id: string) => sorted.filter((n) => n.parent === id);
    const span = (id: string): number =>
      Math.max(
        cross(id) + 32,
        children(id).reduce((sum, n) => sum + span(n.id), 0),
      );
    const root = sorted.find((n) => !n.parent)!;
    const place = (id: string, depth: number, top: number, side: number) => {
      const size = sizes.get(id)!,
        height = span(id);
      positions.set(id, {
        x: side * depth * depthGap,
        y: top + (height - cross(id)) / 2,
      });
      let y = top;
      for (const n of children(id)) {
        place(n.id, depth + 1, y, side);
        y += span(n.id);
      }
    };
    if (d.layout === "bilateral") {
      const branches = children(root.id),
        left = branches.filter((_, i) => i % 2),
        right = branches.filter((_, i) => !(i % 2));
      const height = Math.max(
        sizes.get(root.id)!.h + 32,
        ...[left, right].map((list) =>
          list.reduce((sum, n) => sum + span(n.id), 0),
        ),
      );
      positions.set(root.id, { x: 0, y: (height - sizes.get(root.id)!.h) / 2 });
      for (const [list, side] of [
        [left, -1],
        [right, 1],
      ] as const) {
        let y = (height - list.reduce((sum, n) => sum + span(n.id), 0)) / 2;
        for (const n of list) {
          place(n.id, 1, y, side);
          y += span(n.id);
        }
      }
    } else place(root.id, 0, 0, 1);
  } else {
    // DFS identifies feedback edges. Remaining forward edges form a DAG for ranking.
    const state = new Map<string, number>(),
      feedback = new Set<string>();
    const visit = (id: string) => {
      state.set(id, 1);
      for (const e of connections.filter((e) => e.from === id)) {
        if (state.get(e.to) === 1) feedback.add(e.id);
        else if (!state.has(e.to)) visit(e.to);
      }
      state.set(id, 2);
    };
    for (const n of sorted) if (!state.has(n.id)) visit(n.id);
    const forward = connections.filter((e) => !feedback.has(e.id)),
      ranks = new Map(sorted.map((n) => [n.id, 0]));
    for (let i = 0; i < sorted.length; i++) {
      let changed = false;
      for (const e of forward) {
        const rank = ranks.get(e.from)! + 1;
        if (rank > ranks.get(e.to)!) {
          ranks.set(e.to, rank);
          changed = true;
        }
      }
      if (!changed) break;
    }
    const cursors = new Map<number, number>();
    for (const n of sorted) {
      const rank = ranks.get(n.id)!,
        y = cursors.get(rank) ?? 0;
      positions.set(n.id, { x: rank * depthGap, y });
      cursors.set(rank, y + cross(n.id) + 48);
    }
  }
  const colorFor = (id: string): string => {
    const n = byId.get(id)!;
    if (n.color) return n.color;
    if (d.mode === "logic")
      return n.role === "decision"
        ? "amber"
        : n.role === "terminal"
          ? "teal"
          : "blue";
    if (!n.parent) return "slate";
    const parent = byId.get(n.parent)!;
    if (!parent.parent && !parent.color) {
      const branches = sorted.filter((n) => n.parent === parent.id);
      return ["blue", "teal", "purple", "amber", "green", "rose"][
        branches.findIndex((n) => n.id === id) % 6
      ]!;
    }
    return colorFor(parent.id);
  };
  const nodes: Node[] = sorted.map((n) => {
    const p = positions.get(n.id)!,
      size = sizes.get(n.id)!;
    return {
      id: n.id,
      kind: n.role === "decision" ? "gateway" : "note",
      title: n.title,
      ...(n.sub ? { sub: n.sub } : {}),
      rect: {
        x: d.layout === "down" ? p.y : p.x,
        y: d.layout === "down" ? p.x : p.y,
        ...size,
      },
      style: {
        color: colorFor(n.id),
        autoText: true,
        shape:
          n.role === "decision"
            ? "diamond"
            : n.role === "terminal"
              ? "ellipse"
              : "rounded",
      },
    };
  });
  // Materialized coordinates are the baseline for incremental edits. Untouched
  // cards stay exactly where annotations were drawn; only an explicit re-layout
  // calls this compiler without a baseline.
  const existing = new Map(previous.map((n) => [n.id, n]));
  const pinned = nodes.filter((n) => existing.has(n.id));
  for (const n of pinned) {
    const old = existing.get(n.id)!;
    const unchanged =
      n.title === old.title &&
      n.sub === old.sub &&
      n.style?.shape === old.style?.shape;
    const desired = n.rect;
    n.rect = { ...old.rect };
    if (!unchanged) {
      const others = previous.filter((p) => p.id !== n.id && ids.has(p.id));
      const right = Math.min(
        Infinity,
        ...others
          .filter(
            (p) =>
              p.rect.x >= old.rect.x + old.rect.w &&
              p.rect.y < old.rect.y + desired.h &&
              p.rect.y + p.rect.h > old.rect.y,
          )
          .map((p) => p.rect.x - old.rect.x - 16),
      );
      n.rect.w = Math.min(desired.w, Math.max(old.rect.w, right));
      const below = Math.min(
        Infinity,
        ...others
          .filter(
            (p) =>
              p.rect.y >= old.rect.y + old.rect.h &&
              p.rect.x < old.rect.x + n.rect.w &&
              p.rect.x + p.rect.w > old.rect.x,
          )
          .map((p) => p.rect.y - old.rect.y - 16),
      );
      n.rect.h = Math.min(desired.h, Math.max(old.rect.h, below));
    }
  }
  const occupied = pinned.map((n) => n.rect);
  for (const n of nodes.filter((n) => !existing.has(n.id))) {
    const hits = () =>
      occupied.filter(
        (r) =>
          r.x < n.rect.x + n.rect.w + 16 &&
          r.x + r.w + 16 > n.rect.x &&
          r.y < n.rect.y + n.rect.h + 16 &&
          r.y + r.h + 16 > n.rect.y,
      );
    let overlaps = hits();
    while (overlaps.length) {
      n.rect.y = Math.max(...overlaps.map((r) => r.y + r.h + 48));
      overlaps = hits();
    }
    occupied.push(n.rect);
  }
  const placed = new Map(nodes.map((n) => [n.id, n]));
  const edges: Edge[] = connections.map((e) => {
    const a = placed.get(e.from)!,
      b = placed.get(e.to)!,
      sides = facingAnchors(a.rect, b.rect);
    const loop = a.id === b.id;
    const feedback =
      d.mode === "logic" &&
      (d.layout === "down" ? a.rect.y >= b.rect.y : a.rect.x >= b.rect.x);
    if (loop) {
      sides.from = "top";
      sides.to = "right";
    } else if (feedback) {
      sides.from = d.layout === "down" ? "right" : "bottom";
      sides.to = sides.from;
    }
    return {
      id: e.id,
      from: { node_id: a.id, side: sides.from, offset: 0.5 },
      to: { node_id: b.id, side: sides.to, offset: 0.5 },
      ...(e.label ? { label: e.label } : {}),
      style: {
        ...(e.color ? { color: e.color } : {}),
        ...(e.curve ? { curve: true } : {}),
        ...(e.dashed ? { dashed: true } : {}),
        ...(loop || feedback ? { curve: true } : {}),
        arrow:
          e.arrow ??
          (d.mode === "mindmap" && e.id.startsWith("tree:") ? "none" : "end"),
      },
    };
  });
  return { nodes, edges, strokes: [], assets: [] };
}
