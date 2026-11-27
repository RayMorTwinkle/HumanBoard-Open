import { facingAnchors, type Scene } from "@humanboard/schema";

/**
 * One line per object: what an agent needs to place, connect and refer to things,
 * at a fraction of the AST's tokens. Values that equal their defaults are left out.
 */
export function sceneIndex(
  scene: Scene,
  assetTitles: ReadonlyMap<
    string,
    { display_no: string; title: string }
  > = new Map(),
  strokeLimit = 40,
): string[] {
  if (scene.diagram)
    return [
      `diagram ${JSON.stringify(scene.diagram)}`,
      ...sceneIndex(
        { ...scene, diagram: undefined, nodes: [], edges: [] },
        assetTitles,
        strokeLimit,
      ),
    ];
  const q = (text: string) => JSON.stringify(text);
  const rects = new Map(scene.nodes.map((n) => [n.id, n.rect]));
  const lines: string[] = [];
  for (const n of scene.nodes) {
    const r = n.rect;
    const style = Object.entries(n.style ?? {})
      .filter(([, v]) => v !== undefined && v !== false)
      .map(([k, v]) => (v === true ? k : `${k}=${String(v)}`));
    lines.push(
      [
        "node",
        n.id,
        n.kind,
        q(n.title),
        `${r.x},${r.y}`,
        `${r.w}x${r.h}`,
        ...(n.sub ? [`sub=${q(n.sub)}`] : []),
        ...style,
      ].join(" "),
    );
  }
  for (const e of scene.edges) {
    const a = rects.get(e.from.node_id),
      b = rects.get(e.to.node_id);
    const facing = a && b ? facingAnchors(a, b) : undefined;
    const end = (anchor: typeof e.from, side?: string) =>
      anchor.side === side && anchor.offset === 0.5
        ? anchor.node_id
        : `${anchor.node_id}.${anchor.side}${anchor.offset === 0.5 ? "" : `@${anchor.offset}`}`;
    const style = e.style ?? {};
    lines.push(
      [
        "edge",
        e.id,
        `${end(e.from, facing?.from)}->${end(e.to, facing?.to)}`,
        ...(e.label ? [q(e.label)] : []),
        ...(style.arrow && style.arrow !== "end"
          ? [style.arrow === "both" ? "both" : "no-arrow"]
          : []),
        ...(style.dashed ? ["dashed"] : []),
        ...(style.curve ? ["curve"] : []),
        ...(style.color ? [`color=${style.color}`] : []),
      ].join(" "),
    );
  }
  for (const ref of scene.assets) {
    const meta = assetTitles.get(ref.asset_id);
    const r = ref.rect;
    lines.push(
      `asset #${meta?.display_no ?? ref.display_no} ${q(meta?.title ?? "")} ${r.x},${r.y} ${r.w}x${r.h} z=${ref.z}`,
    );
  }
  // Ink is summarized by where it lies; points stay in `get --with-strokes`.
  for (const s of scene.strokes.slice(0, strokeLimit)) {
    const xs = s.points.map((p) => p[0]),
      ys = s.points.map((p) => p[1]);
    if (!xs.length) continue;
    const x = Math.min(...xs),
      y = Math.min(...ys);
    lines.push(
      `stroke ${s.id} ${s.tool} ${s.color} ${Math.round(x)},${Math.round(y)} ${Math.round(Math.max(...xs) - x)}x${Math.round(Math.max(...ys) - y)}`,
    );
  }
  if (scene.strokes.length > strokeLimit)
    lines.push(`…${scene.strokes.length - strokeLimit} more strokes`);
  return lines;
}
