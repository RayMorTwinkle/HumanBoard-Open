import { edgeGeometry, edgePathPoints, edgeLabelPoint } from "./edge-routing";
export {
  computeAnchorPoint,
  edgeGeometry,
  edgePathPoints,
  edgeLabelPoint,
} from "./edge-routing";
import {
  SceneSchema,
  wrapText,
  nodeColorPalette,
  resolveNodeColor,
  canonicalJson,
  canonicalizeScene,
  round2HalfAwayFromZero,
  type Anchor,
  type AssetRef,
  type Edge,
  type Node,
  type NodeKind,
  type Rect,
  type Scene,
  type Stroke,
} from "@humanboard/schema/scene";

import { HumanBoardError } from "../domain/errors";

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface SceneBoundsOptions {
  readonly padding?: number;
  readonly minViewport?: {
    readonly width: number;
    readonly height: number;
  };
}

export interface RenderSceneOptions extends SceneBoundsOptions {
  readonly theme?: "light" | "dark";
  readonly background?: string;
  readonly assetImages?: Readonly<Record<string, string>>;
  readonly assetTitles?: Readonly<Record<string, string>>;
  readonly assetCards?: Readonly<
    Record<string, { readonly url: string; readonly description?: string }>
  >;
  readonly bounds?: Bounds;
  readonly routeStructuredEdges?: boolean;
}

export const SCENE_MIN_VIEWPORT = Object.freeze({
  width: 1024,
  height: 640,
});
export const SCENE_PADDING = 48;

const NODE_PALETTE: Record<
  NodeKind,
  { readonly fill: string; readonly stroke: string; readonly text: string }
> = {
  state: { fill: "#EAF0FF", stroke: "#7C9CFF", text: "#25324D" },
  job: { fill: "#FFF4E5", stroke: "#F2B24C", text: "#4A3515" },
  queue: { fill: "#F3EDFF", stroke: "#A78BFA", text: "#382B57" },
  service: { fill: "#E8F7F1", stroke: "#57B894", text: "#1E4638" },
  gateway: { fill: "#E8F3FF", stroke: "#5B9BD5", text: "#203B57" },
  database: { fill: "#FFF0F0", stroke: "#E07A7A", text: "#512626" },
  external: { fill: "#F2F3F5", stroke: "#8B94A3", text: "#303741" },
  saga: { fill: "#FDF0FF", stroke: "#C084FC", text: "#44265B" },
  group: { fill: "#F7F8FA", stroke: "#A3AAB7", text: "#343A44" },
  note: { fill: "#FFFBE6", stroke: "#D4B106", text: "#4A4108" },
  unknown: { fill: "#F1F2F4", stroke: "#8B94A3", text: "#3E4650" },
};

function validateOption(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new HumanBoardError(
      "E_USAGE",
      `${name} must be a non-negative number`,
    );
  }
  return value;
}

function boundsOptions(options: SceneBoundsOptions): {
  padding: number;
  minViewport: { width: number; height: number };
} {
  const minViewport = options.minViewport ?? SCENE_MIN_VIEWPORT;
  return {
    padding: validateOption(options.padding ?? SCENE_PADDING, "padding"),
    minViewport: {
      width: validateOption(minViewport.width, "minViewport.width"),
      height: validateOption(minViewport.height, "minViewport.height"),
    },
  };
}

function expandRect(
  current: { left: number; top: number; right: number; bottom: number },
  rect: Rect,
): void {
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;
  current.left = Math.min(current.left, rect.x, right);
  current.top = Math.min(current.top, rect.y, bottom);
  current.right = Math.max(current.right, rect.x, right);
  current.bottom = Math.max(current.bottom, rect.y, bottom);
}

function expandPoint(
  current: { left: number; top: number; right: number; bottom: number },
  point: readonly [number, number],
): void {
  current.left = Math.min(current.left, point[0]);
  current.top = Math.min(current.top, point[1]);
  current.right = Math.max(current.right, point[0]);
  current.bottom = Math.max(current.bottom, point[1]);
}

function outwardRound(value: number, direction: "floor" | "ceil"): number {
  const rounded =
    direction === "floor"
      ? Math.floor(value / 8) * 8
      : Math.ceil(value / 8) * 8;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function computeUnionBoundsFromParsed(
  scenes: readonly Scene[],
  options: SceneBoundsOptions = {},
): Bounds {
  const { padding, minViewport } = boundsOptions(options);
  const structured = scenes.some((s) => s.diagram && s.nodes.length);
  const extent = {
    left: structured ? Infinity : 0,
    top: structured ? Infinity : 0,
    right: structured ? -Infinity : minViewport.width,
    bottom: structured ? -Infinity : minViewport.height,
  };

  for (const scene of scenes) {
    for (const node of scene.nodes) {
      expandRect(extent, node.rect);
    }
    if (scene.diagram) {
      const byId = new Map(scene.nodes.map((n) => [n.id, n]));
      for (const edge of scene.edges) {
        const a = byId.get(edge.from.node_id),
          b = byId.get(edge.to.node_id);
        if (a && b) {
          const g = edgeGeometry(
            edge,
            a.rect,
            b.rect,
            scene.nodes
              .filter(
                (n) => n.id !== a.id && n.id !== b.id && n.kind !== "group",
              )
              .map((n) => n.rect),
          );
          for (const p of [
            ...edgePathPoints(g),
            ...(g.c1 && g.c2 ? [g.c1, g.c2] : []),
          ])
            expandPoint(extent, [p.x, p.y]);
        }
      }
    }
    for (const asset of scene.assets) {
      expandRect(extent, asset.rect);
    }
    for (const stroke of scene.strokes) {
      for (const point of stroke.points) {
        expandPoint(extent, point);
      }
    }
  }

  if (structured) {
    const dx = Math.max(0, 640 - (extent.right - extent.left)) / 2,
      dy = Math.max(0, 320 - (extent.bottom - extent.top)) / 2;
    extent.left -= dx;
    extent.right += dx;
    extent.top -= dy;
    extent.bottom += dy;
  }
  const left = outwardRound(extent.left - padding, "floor");
  const top = outwardRound(extent.top - padding, "floor");
  const right = outwardRound(extent.right + padding, "ceil");
  const bottom = outwardRound(extent.bottom + padding, "ceil");

  return {
    x: left,
    y: top,
    w: right - left,
    h: bottom - top,
  };
}

export function computeSceneBounds(
  scene: Scene,
  options: SceneBoundsOptions = {},
): Bounds {
  return computeUnionBoundsFromParsed(
    [canonicalizeScene(SceneSchema.parse(scene))],
    options,
  );
}

export function computeScenesBounds(
  scenes: readonly Scene[],
  options: SceneBoundsOptions = {},
): Bounds {
  return computeUnionBoundsFromParsed(
    scenes.map((scene) => canonicalizeScene(SceneSchema.parse(scene))),
    options,
  );
}

export function formatSvgNumber(value: number): string {
  return canonicalJson(round2HalfAwayFromZero(value));
}

export function escapeSvgXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function svgAttr(name: string, value: string | number): string {
  return `${name}="${escapeSvgXml(String(value))}"`;
}

function arrowHead(
  tip: { x: number; y: number },
  from: { x: number; y: number },
  color: string,
  placement: "start" | "end",
): string {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return "";
  }

  const ux = dx / length;
  const uy = dy / length;
  const baseX = tip.x - ux * 10;
  const baseY = tip.y - uy * 10;
  const px = -uy * 5;
  const py = ux * 5;
  const points = [
    `${formatSvgNumber(tip.x)},${formatSvgNumber(tip.y)}`,
    `${formatSvgNumber(baseX + px)},${formatSvgNumber(baseY + py)}`,
    `${formatSvgNumber(baseX - px)},${formatSvgNumber(baseY - py)}`,
  ].join(" ");

  return `<polygon ${svgAttr("data-arrow", placement)} points="${points}" fill="${escapeSvgXml(color)}" />`;
}

function cardLines(
  value: string,
  width: number,
  fontSize: number,
  maxLines: number,
): string[] {
  return wrapText(value, width, fontSize, maxLines);
}
function renderUrlCard(
  asset: AssetRef,
  title: string,
  card: { url: string; description?: string },
  dark: boolean,
): string {
  let url: URL;
  try {
    url = new URL(card.url);
    if (!["http:", "https:"].includes(url.protocol)) return "";
  } catch {
    return "";
  }
  const { x, y, w, h } = asset.rect,
    clip = `hb-url-${asset.asset_id}`;
  const lines = cardLines(
    title || url.hostname,
    w - 32,
    14,
    Math.min(3, Math.max(1, Math.floor((h - 80) / 20))),
  );
  const bodyY = y + 88 + lines.length * 20;
  const descriptions = cardLines(
    card.description ?? "",
    w - 32,
    12,
    Math.min(3, Math.max(0, Math.floor((y + h - 28 - bodyY) / 18))),
  );
  return `<g data-asset-id="${escapeSvgXml(asset.asset_id)}" data-asset-type="url" data-display-no="${asset.display_no}" data-z="${asset.z}">
    <defs><clipPath id="${clip}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12"/></clipPath></defs>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${dark ? "#121A27" : "#F6F8FC"}" stroke="${dark ? "#3A485E" : "#B4C1D8"}"/>
    <g clip-path="url(#${clip})"><rect x="${x + 12}" y="${y + 12}" width="58" height="24" rx="6" fill="#253248"/>
    <text x="${x + 20}" y="${y + 29}" fill="#FFFFFF" font-size="12" font-family="sans-serif">#${asset.display_no}</text>
    <text x="${x + 16}" y="${y + 60}" fill="${dark ? "#9BB9F3" : "#4568A5"}" font-size="12" font-family="sans-serif">${escapeSvgXml(url.hostname)}</text>
    ${lines.map((line, i) => `<text x="${x + 16}" y="${y + 84 + i * 20}" fill="${dark ? "#E3E9F4" : "#24344D"}" font-size="14" font-weight="600" font-family="sans-serif">${escapeSvgXml(line)}</text>`).join("")}
    ${descriptions.map((line, i) => `<text x="${x + 16}" y="${bodyY + i * 18}" fill="${dark ? "#8F9FB9" : "#697891"}" font-size="12" font-family="sans-serif">${escapeSvgXml(line)}</text>`).join("")}
    <text x="${x + 16}" y="${y + h - 13}" fill="${dark ? "#64738C" : "#8793A6"}" font-size="10" font-family="sans-serif">${escapeSvgXml(cardLines(url.pathname + url.search, w - 32, 10, 1)[0] ?? "/")}</text></g></g>`;
}

function renderAsset(
  asset: AssetRef,
  images: Readonly<Record<string, string>> = {},
  titles: Readonly<Record<string, string>> = {},
  dark = false,
  card?: { url: string; description?: string },
): string {
  if (card) {
    const rendered = renderUrlCard(
      asset,
      titles[asset.asset_id] ?? "",
      card,
      dark,
    );
    if (rendered) return rendered;
  }
  const { x, y, w, h } = asset.rect;
  const badgeWidth = Math.min(
    Math.max(54, asset.display_no.length * 11 + 18),
    w - 16,
  );
  return [
    `<g ${svgAttr("data-asset-id", asset.asset_id)} ${svgAttr("data-display-no", asset.display_no)} ${svgAttr("data-z", asset.z)}>`,
    `<rect ${svgAttr("x", formatSvgNumber(x))} ${svgAttr("y", formatSvgNumber(y))} ${svgAttr("width", formatSvgNumber(w))} ${svgAttr("height", formatSvgNumber(h))} rx="12" fill="${dark ? "#101722" : "#F5F6F8"}" stroke="${dark ? "#38404D" : "#AAB2C0"}" stroke-width="1.5" stroke-dasharray="6 4" />`,
    images[asset.asset_id]?.match(/^data:image\/(png|jpeg);base64,/)
      ? `<image x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none" href="${escapeSvgXml(images[asset.asset_id]!)}" />`
      : "",
    `<rect ${svgAttr("x", formatSvgNumber(x + 12))} ${svgAttr("y", formatSvgNumber(y + 12))} ${svgAttr("width", formatSvgNumber(Math.max(0, badgeWidth)))} height="24" rx="6" fill="#111827" />`,
    `<text ${svgAttr("x", formatSvgNumber(x + 21))} ${svgAttr("y", formatSvgNumber(y + 29))} fill="#FFFFFF" font-size="12" font-family="ui-sans-serif, sans-serif" font-weight="700">#${escapeSvgXml(asset.display_no)}</text>`,
    `<text ${svgAttr("x", formatSvgNumber(x + 16))} ${svgAttr("y", formatSvgNumber(y + h - 16))} fill="#6B7280" font-size="12" font-family="ui-sans-serif, sans-serif">${escapeSvgXml(titles[asset.asset_id] ?? "图片 / 网页资产")}</text>`,
    `</g>`,
  ].join("");
}

// Dark mirrors NODE_PALETTE kind for kind: same hue, tinted surface, light text.
// Themes differ only in color; node layout must stay identical across them.
const DARK_NODE_PALETTE: Record<
  NodeKind,
  { readonly fill: string; readonly stroke: string; readonly text: string }
> = {
  state: { fill: "#1B2333", stroke: "#7C9CFF", text: "#DCE4FF" },
  job: { fill: "#2A2216", stroke: "#F2B24C", text: "#F5E3C4" },
  queue: { fill: "#241F35", stroke: "#A78BFA", text: "#E4DBFF" },
  service: { fill: "#172A23", stroke: "#57B894", text: "#CDEFE1" },
  gateway: { fill: "#172434", stroke: "#5B9BD5", text: "#D3E6F8" },
  database: { fill: "#2D1C1C", stroke: "#E07A7A", text: "#F5D6D6" },
  external: { fill: "#212328", stroke: "#8B94A3", text: "#DDE1E7" },
  saga: { fill: "#2A1D31", stroke: "#C084FC", text: "#F0DAFF" },
  group: { fill: "#1F2125", stroke: "#A3AAB7", text: "#DEE1E6" },
  note: { fill: "#2A2614", stroke: "#D4B106", text: "#F3E9B5" },
  unknown: { fill: "#212226", stroke: "#8B94A3", text: "#DADDE2" },
};
function nodePalette(kind: NodeKind, dark: boolean) {
  const palette = dark ? DARK_NODE_PALETTE : NODE_PALETTE;
  return palette[kind] ?? palette.unknown;
}
export function nodeAccentColor(node: Node, dark = false): string {
  return (
    resolveNodeColor(node.style?.color) ??
    (typeof node.style?.accent === "string"
      ? node.style.accent
      : nodePalette(node.kind, dark).stroke)
  );
}
function renderNodeText(node: Node, textColor: string): string {
  const { x, y, w, h } = node.rect;
  const inset = 16,
    width = Math.max(0, w - inset * 2);
  const hasSub = Boolean(node.sub),
    bottom = h - 12;
  // A group labels its region from the top; cards center a lone title.
  const firstLine =
    hasSub || node.kind === "group" ? Math.min(30, h * 0.5) : h / 2 + 5;
  const maxLines = !hasSub
    ? Math.max(
        1,
        Math.min(node.style?.autoText ? 500 : 3, Math.floor((h - 24) / 18)),
      )
    : Math.max(
        1,
        Math.min(
          node.style?.autoText ? 500 : 3,
          1 + Math.floor((bottom - firstLine - 19) / 18),
        ),
      );
  const titles = cardLines(node.title, width, 14, maxLines);
  const titleY =
    !hasSub && node.kind !== "group"
      ? firstLine - (titles.length - 1) * 9
      : firstLine;
  const subY = titleY + (titles.length - 1) * 18 + 19;
  const descriptions = cardLines(
    node.sub ?? "",
    width,
    12,
    Math.min(
      node.style?.autoText ? 500 : 8,
      Math.max(0, 1 + Math.floor((bottom - subY) / 15)),
    ),
  );
  const fill = escapeSvgXml(textColor);
  return `<svg x="${x + inset}" y="${y}" width="${width}" height="${h}" overflow="hidden">
    ${titles.map((line, i) => `<text x="0" y="${titleY + i * 18}" fill="${fill}" font-size="14" font-weight="600" font-family="-apple-system, BlinkMacSystemFont, PingFang SC, sans-serif">${escapeSvgXml(line)}</text>`).join("")}
    ${descriptions.map((line, i) => `<text x="0" y="${subY + i * 15}" fill="${fill}" opacity=".72" font-size="12" font-family="ui-sans-serif, PingFang SC, sans-serif">${escapeSvgXml(line)}</text>`).join("")}
  </svg>`;
}
function renderStyledNode(node: Node, dark: boolean): string {
  const { x, y, w, h } = node.rect;
  const unified = nodeColorPalette(node.style?.color, dark);
  const palette = unified ?? nodePalette(node.kind, dark);
  const color = (v: unknown) =>
    typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : undefined;
  const fill = unified ? undefined : color(node.style?.fill);
  const border =
    unified?.stroke ??
    color(node.style?.borderColor) ??
    color(node.style?.accent);
  const attrs = `fill="${fill ?? palette.fill}" stroke="${border ?? palette.stroke}" stroke-width="1.5"${node.style?.dashed === true ? ' stroke-dasharray="8 6"' : ""}`;
  const shape = node.style?.shape;
  const shell =
    shape === "ellipse"
      ? `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" ${attrs}/>`
      : shape === "diamond"
        ? `<polygon points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}" ${attrs}/>`
        : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${shape === "rectangle" ? 0 : 12}" ${attrs}/>`;
  const inset = shape === "diamond" ? 0.25 : shape === "ellipse" ? 0.15 : 0;
  const textNode = inset
    ? {
        ...node,
        rect: {
          x: x + w * inset,
          y: y + h * inset,
          w: w * (1 - 2 * inset),
          h: h * (1 - 2 * inset),
        },
      }
    : node;
  // A custom fill picks its text color by luminance; otherwise the kind palette decides.
  const textColor = fill
    ? 0.2126 * parseInt(fill.slice(1, 3), 16) +
        0.7152 * parseInt(fill.slice(3, 5), 16) +
        0.0722 * parseInt(fill.slice(5, 7), 16) <
      145
      ? "#ECEEF2"
      : "#1F2329"
    : palette.text;
  return `<g ${svgAttr("data-node-id", node.id)} ${svgAttr("data-kind", node.kind)}><title>${escapeSvgXml(node.title)}</title>${shell}${renderNodeText(textNode, textColor)}</g>`;
}
function renderDarkNode(node: Node): string {
  return renderStyledNode(node, true);
}
function renderNode(node: Node): string {
  return renderStyledNode(node, false);
}

function renderEdge(
  edge: Edge,
  nodes: ReadonlyMap<string, Node>,
  dark = false,
  avoidNodes = false,
): string {
  const fromNode = nodes.get(edge.from.node_id);
  const toNode = nodes.get(edge.to.node_id);
  if (!fromNode || !toNode) {
    return "";
  }

  const g = edgeGeometry(
    edge,
    fromNode.rect,
    toNode.rect,
    avoidNodes
      ? [...nodes.values()]
          .filter(
            (n) =>
              n.id !== fromNode.id && n.id !== toNode.id && n.kind !== "group",
          )
          .map((n) => n.rect)
      : [],
  );
  const { start, end, c1, c2, points } = g;
  const color = edge.style?.color ?? (dark ? "#7C8696" : "#5B6475");
  const dashed = edge.style?.dashed === true;
  const arrow = edge.style?.arrow ?? "end";
  const dash = dashed ? ' stroke-dasharray="8 6"' : "";
  const n = formatSvgNumber;
  const parts = [
    `<g ${svgAttr("data-edge-id", edge.id)}>`,
    points
      ? `<path d="${points.map((p, i) => `${i ? "L" : "M"}${n(p.x)} ${n(p.y)}`).join(" ")}" fill="none" stroke="${escapeSvgXml(color)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${dash}/>`
      : c1 && c2
        ? `<path d="M${n(start.x)} ${n(start.y)} C${n(c1.x)} ${n(c1.y)} ${n(c2.x)} ${n(c2.y)} ${n(end.x)} ${n(end.y)}" fill="none" stroke="${escapeSvgXml(color)}" stroke-width="2" stroke-linecap="round"${dash} />`
        : `<line ${svgAttr("x1", n(start.x))} ${svgAttr("y1", n(start.y))} ${svgAttr("x2", n(end.x))} ${svgAttr("y2", n(end.y))} stroke="${escapeSvgXml(color)}" stroke-width="2" stroke-linecap="round"${dash} />`,
  ];

  // On a curve the arrow follows the tangent, which points from the near control point.
  if (arrow === "end" || arrow === "both") {
    parts.push(
      arrowHead(end, points?.[points.length - 2] ?? c2 ?? start, color, "end"),
    );
  }
  if (arrow === "both") {
    parts.push(arrowHead(start, points?.[1] ?? c1 ?? end, color, "start"));
  }
  if (edge.label !== undefined) {
    const mid = edgeLabelPoint(g);
    parts.push(
      `<text ${svgAttr("x", n(mid.x))} ${svgAttr("y", n(mid.y - 8))} fill="${escapeSvgXml(color)}" stroke="${dark ? "#18181B" : "#FBFAF7"}" stroke-width="4" stroke-linejoin="round" paint-order="stroke" text-anchor="middle" font-size="12" font-family="ui-sans-serif, sans-serif">${escapeSvgXml(edge.label)}</text>`,
    );
  }
  parts.push("</g>");
  return parts.join("");
}

function renderStroke(stroke: Stroke): string {
  if (stroke.points.length === 0) {
    return "";
  }
  const points = stroke.points
    .map(([x, y]) => `${formatSvgNumber(x)},${formatSvgNumber(y)}`)
    .join(" ");
  const opacity = stroke.tool === "highlighter" ? ' opacity="0.35"' : "";
  return `<polyline ${svgAttr("data-stroke-id", stroke.id)} points="${points}" fill="none" stroke="${escapeSvgXml(stroke.color)}" stroke-width="${formatSvgNumber(stroke.width)}" stroke-linecap="round" stroke-linejoin="round"${opacity} />`;
}

export function renderSceneBodyFromParsed(
  scene: Scene,
  _bounds: Bounds,
  options: RenderSceneOptions = {},
): string {
  scene = canonicalizeScene(scene);
  const nodesById = new Map(scene.nodes.map((node) => [node.id, node]));
  const assets = [...scene.assets].sort(
    (left, right) =>
      left.z - right.z ||
      (left.asset_id < right.asset_id
        ? -1
        : left.asset_id > right.asset_id
          ? 1
          : 0),
  );

  return [
    `<g data-layer="assets">${assets.map((asset) => renderAsset(asset, options.assetImages, options.assetTitles, options.theme === "dark", options.assetCards?.[asset.asset_id])).join("")}</g>`,
    `<g data-layer="nodes">${backToFront(scene.nodes)
      .map(options.theme === "dark" ? renderDarkNode : renderNode)
      .join("")}</g>`,
    `<g data-layer="edges">${scene.edges
      .map((edge) =>
        renderEdge(edge, nodesById, options.theme === "dark", !!scene.diagram),
      )
      .join("")}</g>`,
    `<g data-layer="strokes">${scene.strokes.map(renderStroke).join("")}</g>`,
  ].join("");
}

/** Groups are containers: they sit beneath every card, whatever their ids sort as. */
export function backToFront<T extends Pick<Node, "kind">>(
  nodes: readonly T[],
): T[] {
  return [
    ...nodes.filter((n) => n.kind === "group"),
    ...nodes.filter((n) => n.kind !== "group"),
  ];
}

/** Renders edges alone, resolving endpoints against a wider set of nodes. */
export function renderSceneEdges(
  edges: readonly Edge[],
  nodes: readonly Node[],
  options: RenderSceneOptions = {},
): string {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  return edges
    .map((edge) =>
      renderEdge(
        edge,
        nodesById,
        options.theme === "dark",
        options.routeStructuredEdges,
      ),
    )
    .join("");
}

export function renderSvgDocument(
  body: string,
  bounds: Bounds,
  background = "#FFFFFF",
  defs = "",
  title = "HumanBoard Scene",
): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" ${svgAttr("viewBox", `${formatSvgNumber(bounds.x)} ${formatSvgNumber(bounds.y)} ${formatSvgNumber(bounds.w)} ${formatSvgNumber(bounds.h)}`)} ${svgAttr("width", formatSvgNumber(bounds.w))} ${svgAttr("height", formatSvgNumber(bounds.h))} ${svgAttr("data-bounds-x", formatSvgNumber(bounds.x))} ${svgAttr("data-bounds-y", formatSvgNumber(bounds.y))} ${svgAttr("data-bounds-w", formatSvgNumber(bounds.w))} ${svgAttr("data-bounds-h", formatSvgNumber(bounds.h))}>`,
    `<title>${escapeSvgXml(title)}</title>`,
    defs,
    `<rect ${svgAttr("x", formatSvgNumber(bounds.x))} ${svgAttr("y", formatSvgNumber(bounds.y))} ${svgAttr("width", formatSvgNumber(bounds.w))} ${svgAttr("height", formatSvgNumber(bounds.h))} fill="${escapeSvgXml(background)}" />`,
    body,
    `</svg>`,
  ].join("");
}

export function renderSceneToSVG(
  scene: Scene,
  options: RenderSceneOptions = {},
): string {
  const parsed = canonicalizeScene(SceneSchema.parse(scene));
  const bounds =
    options.bounds ?? computeUnionBoundsFromParsed([parsed], options);
  const background =
    options.background ??
    (options.theme === "dark" ? "transparent" : "#FFFFFF");

  return renderSvgDocument(
    renderSceneBodyFromParsed(parsed, bounds, options),
    bounds,
    background,
  );
}
