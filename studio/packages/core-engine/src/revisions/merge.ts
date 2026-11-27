import {
  compileDiagram,
  canonicalJson,
  type Scene,
} from "@humanboard/schema/scene";

export interface Conflict {
  path: string[];
  base: unknown;
  current: unknown;
  incoming: unknown;
}
export const equal = (a: unknown, b: unknown) =>
  a === b ||
  (a !== undefined && b !== undefined && canonicalJson(a) === canonicalJson(b));
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Undefined means field/entity deletion. Arrays such as pen samples stay atomic. */
export function mergeScenes(base: Scene, current: Scene, incoming: Scene) {
  const conflicts: Conflict[] = [];
  function field(a: unknown, b: unknown, c: unknown, path: string[]): unknown {
    if (equal(b, c) || equal(a, c)) return b;
    if (equal(a, b)) return c;
    if (
      path.length === 2 &&
      path[0] === "diagram" &&
      (path[1] === "nodes" || path[1] === "edges") &&
      Array.isArray(a) &&
      Array.isArray(b) &&
      Array.isArray(c)
    ) {
      return entities(path, [a, b, c], (item) => item.id);
    }
    if (object(a) && object(b) && object(c)) {
      const entries = [
        ...new Set([...Object.keys(a), ...Object.keys(b), ...Object.keys(c)]),
      ]
        .map(
          (key) =>
            [
              key,
              field(
                Object.hasOwn(a, key) ? a[key] : undefined,
                Object.hasOwn(b, key) ? b[key] : undefined,
                Object.hasOwn(c, key) ? c[key] : undefined,
                [...path, key],
              ),
            ] as const,
        )
        .filter(([, value]) => value !== undefined);
      return Object.fromEntries(entries);
    }
    conflicts.push({
      path,
      base: a ?? null,
      current: b ?? null,
      incoming: c ?? null,
    });
    return b;
  }
  function entities<T>(
    path: string[],
    lists: [T[], T[], T[]],
    key: (t: T) => string,
  ): T[] {
    if (equal(lists[0], lists[1])) return lists[2];
    if (equal(lists[0], lists[2]) || equal(lists[1], lists[2])) return lists[1];
    const maps = lists.map(
      (list) => new Map(list.map((item) => [key(item), item])),
    );
    const result: T[] = [];
    const orders = maps.map((map) =>
      [...map.keys()].filter((id) => maps.every((m) => m.has(id))),
    );
    const useIncomingOrder = equal(orders[0], orders[1]);
    if (
      !useIncomingOrder &&
      !equal(orders[0], orders[2]) &&
      !equal(orders[1], orders[2])
    )
      conflicts.push({
        path: [...path, "order"],
        base: orders[0],
        current: orders[1],
        incoming: orders[2],
      });
    const ids = new Set(
      (useIncomingOrder
        ? [maps[2]!, maps[1]!, maps[0]!]
        : [maps[1]!, maps[2]!, maps[0]!]
      ).flatMap((map) => [...map.keys()]),
    );
    for (const id of ids) {
      const item = field(maps[0]!.get(id), maps[1]!.get(id), maps[2]!.get(id), [
        ...path,
        id,
      ]);
      if (item !== undefined) result.push(item as T);
    }
    return result;
  }
  const diagram = field(base.diagram, current.diagram, incoming.diagram, [
    "diagram",
  ]) as Scene["diagram"];
  const scene: Scene = {
    ...(diagram ? { diagram } : {}),
    nodes: entities(
      ["nodes"],
      [base.nodes, current.nodes, incoming.nodes],
      (n) => n.id,
    ),
    edges: entities(
      ["edges"],
      [base.edges, current.edges, incoming.edges],
      (e) => e.id,
    ),
    strokes: entities(
      ["strokes"],
      [base.strokes, current.strokes, incoming.strokes],
      (s) => s.id,
    ),
    assets: entities(
      ["assets"],
      [base.assets, current.assets, incoming.assets],
      (a) => a.asset_id,
    ),
  };
  const ids = new Set(scene.nodes.map((n) => n.id));
  for (const e of scene.edges)
    for (const end of ["from", "to"] as const) {
      if (!ids.has(e[end].node_id))
        conflicts.push({
          path: ["edges", e.id, end],
          base: null,
          current: null,
          incoming: e[end].node_id,
        });
    }
  if (diagram && !conflicts.length) {
    try {
      compileDiagram(diagram);
    } catch {
      conflicts.push({
        path: ["diagram"],
        base: base.diagram ?? null,
        current: current.diagram ?? null,
        incoming: incoming.diagram ?? null,
      });
    }
  }
  return { scene, conflicts };
}

/** All nearest common ancestors. Refuse ambiguous criss-cross merges. */
export function mergeBases(
  parents: Map<string, string[]>,
  ours: string,
  theirs: string,
) {
  function ancestors(start: string) {
    const seen = new Set<string>(),
      stack = [start];
    while (stack.length) {
      const id = stack.pop()!;
      if (!seen.has(id)) {
        seen.add(id);
        stack.push(...(parents.get(id) ?? []));
      }
    }
    return seen;
  }
  const other = ancestors(theirs);
  const common = [...ancestors(ours)].filter((id) => other.has(id));
  const older = new Set(common.flatMap((id) => parents.get(id) ?? []));
  return common.filter((id) => !older.has(id));
}
