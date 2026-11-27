/** Pen presets: all readable on the light sheet and the dark one. Red stays the default. */
export const PEN_COLORS: readonly { color: string; label: string }[] = [
  { color: "#ff5b47", label: "红" },
  { color: "#f59e0b", label: "橙" },
  { color: "#1fa774", label: "绿" },
  { color: "#2f7bf6", label: "蓝" },
  { color: "#8b5cf6", label: "紫" },
];
export const DEFAULT_PEN = PEN_COLORS[0]!.color;
const KEY = "humanboard.pen";

export function readPenColor(): string {
  try {
    const saved = localStorage.getItem(KEY);
    return PEN_COLORS.some((p) => p.color === saved) ? saved! : DEFAULT_PEN;
  } catch {
    return DEFAULT_PEN;
  }
}

export function savePenColor(color: string): void {
  try {
    localStorage.setItem(KEY, color);
  } catch {
    /* private mode: the choice lasts for this session */
  }
}

/** Line presets for new edges. The first is what an unstyled edge already looks like. */
export const EDGE_PRESETS = [
  { id: "arrow", label: "实线箭头", style: undefined },
  { id: "dashed", label: "虚线箭头", style: { dashed: true } },
  { id: "both", label: "双向", style: { arrow: "both" } },
  { id: "none", label: "无向线", style: { arrow: "none" } },
  { id: "curve", label: "曲线箭头", style: { curve: true } },
] as const satisfies readonly {
  id: string;
  label: string;
  style?: import("@humanboard/schema").Edge["style"];
}[];
export type EdgePresetId = (typeof EDGE_PRESETS)[number]["id"];
const EDGE_KEY = "humanboard.edge";

export function readEdgePreset(): EdgePresetId {
  try {
    const saved = localStorage.getItem(EDGE_KEY);
    return EDGE_PRESETS.find((p) => p.id === saved)?.id ?? "arrow";
  } catch {
    return "arrow";
  }
}

export function saveEdgePreset(id: EdgePresetId): void {
  try {
    localStorage.setItem(EDGE_KEY, id);
  } catch {
    /* private mode: the choice lasts for this session */
  }
}
