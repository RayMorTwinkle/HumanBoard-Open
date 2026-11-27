import { z } from "zod";
import { DiagramSchema } from "./diagram";

export const NODE_KINDS = [
  "state",
  "job",
  "queue",
  "service",
  "gateway",
  "database",
  "external",
  "saga",
  "group",
  "note",
  "unknown",
] as const;

export type KnownNodeKind = (typeof NODE_KINDS)[number];
export type NodeKind = KnownNodeKind;

const NODE_KIND_SET: ReadonlySet<string> = new Set(NODE_KINDS);

const FiniteNumberSchema = z.number().refine(Number.isFinite, {
  message: "Expected a finite number",
});

export const UlidSchema = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/i, "Expected a 26-character ULID");

export const NodeKindSchema = z
  .string()
  .transform(
    (value): NodeKind =>
      NODE_KIND_SET.has(value) ? (value as NodeKind) : "unknown",
  );

export const RectSchema = z
  .object({
    x: FiniteNumberSchema,
    y: FiniteNumberSchema,
    w: FiniteNumberSchema,
    h: FiniteNumberSchema,
  })
  .strict();

export const NodeSchema = z
  .object({
    id: z.string().min(1),
    kind: NodeKindSchema,
    title: z.string(),
    sub: z.string().optional(),
    rect: RectSchema,
    style: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const AnchorSchema = z
  .object({
    node_id: z.string().min(1),
    side: z.enum(["top", "right", "bottom", "left"]),
    offset: FiniteNumberSchema.pipe(z.number().min(0).max(1)),
  })
  .strict();

export const EdgeStyleSchema = z
  .object({
    dashed: z.boolean().optional(),
    color: z.string().optional(),
    arrow: z.enum(["end", "none", "both"]).optional(),
    /** Bends out of each anchor's side instead of a straight segment. */
    curve: z.boolean().optional(),
  })
  .strict();

export const EdgeSchema = z
  .object({
    id: z.string().min(1),
    from: AnchorSchema,
    to: AnchorSchema,
    label: z.string().optional(),
    style: EdgeStyleSchema.optional(),
  })
  .strict();

export const StrokeSchema = z
  .object({
    id: z.string().min(1),
    tool: z.enum(["pen", "highlighter"]),
    color: z.string(),
    width: FiniteNumberSchema,
    points: z.array(z.tuple([FiniteNumberSchema, FiniteNumberSchema])),
    pressure: z.array(FiniteNumberSchema).optional(),
  })
  .strict();

export const AssetRefSchema = z
  .object({
    asset_id: UlidSchema,
    display_no: z
      .string()
      .regex(/^\d{3,}$/, "Expected a numeric display number"),
    rect: RectSchema,
    z: FiniteNumberSchema,
  })
  .strict();

export const SceneSchema = z
  .object({
    diagram: DiagramSchema.optional(),
    nodes: z.array(NodeSchema),
    edges: z.array(EdgeSchema),
    strokes: z.array(StrokeSchema),
    assets: z.array(AssetRefSchema),
  })
  .strict();

export type Rect = z.infer<typeof RectSchema>;
export type Node = z.infer<typeof NodeSchema>;
export type Anchor = z.infer<typeof AnchorSchema>;
export type EdgeStyle = z.infer<typeof EdgeStyleSchema>;
export type Edge = z.infer<typeof EdgeSchema>;
export type Stroke = z.infer<typeof StrokeSchema>;
export type AssetRef = z.infer<typeof AssetRefSchema>;
export type Scene = z.infer<typeof SceneSchema>;
