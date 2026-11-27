import type { Rect, Stroke } from "@humanboard/schema";

import { HumanBoardError } from "../domain/errors";
import { escapeSvgXml, formatSvgNumber, svgAttr } from "./scene-svg";
import { rasterizeSvgToPNG } from "./scene-png";

export interface InspectOverlayOptions {
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly assetRect: Rect;
  readonly strokes: readonly Stroke[];
  readonly background?: string;
  readonly imageData?: Uint8Array;
  readonly imageMimeType?: string;
}

function validateDimension(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new HumanBoardError("E_USAGE", `${name} must be positive`);
  }
  return value;
}

function isInside(point: readonly [number, number], rect: Rect): boolean {
  return (
    point[0] >= rect.x &&
    point[0] <= rect.x + rect.w &&
    point[1] >= rect.y &&
    point[1] <= rect.y + rect.h
  );
}

function mapPoint(
  point: readonly [number, number],
  rect: Rect,
  imageWidth: number,
  imageHeight: number,
): [number, number] {
  return [
    ((point[0] - rect.x) * imageWidth) / rect.w,
    ((point[1] - rect.y) * imageHeight) / rect.h,
  ];
}

function renderStrokeRuns(
  stroke: Stroke,
  assetRect: Rect,
  imageWidth: number,
  imageHeight: number,
): string[] {
  const runs: [number, number][][] = [];
  let current: [number, number][] = [];

  for (const point of stroke.points) {
    if (isInside(point, assetRect)) {
      current.push(mapPoint(point, assetRect, imageWidth, imageHeight));
    } else if (current.length > 0) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    runs.push(current);
  }

  const scale = Math.min(imageWidth / assetRect.w, imageHeight / assetRect.h);
  const width = stroke.width * scale;
  const opacity = stroke.tool === "highlighter" ? ' opacity="0.35"' : "";
  return runs.map((run) => {
    if (run.length === 1) {
      const [x, y] = run[0]!;
      return `<circle ${svgAttr("data-stroke-id", stroke.id)} ${svgAttr("cx", formatSvgNumber(x))} ${svgAttr("cy", formatSvgNumber(y))} ${svgAttr("r", formatSvgNumber(Math.max(width / 2, 1)))} fill="${escapeSvgXml(stroke.color)}"${opacity} />`;
    }
    const points = run
      .map(([x, y]) => `${formatSvgNumber(x)},${formatSvgNumber(y)}`)
      .join(" ");
    return `<polyline ${svgAttr("data-stroke-id", stroke.id)} points="${points}" fill="none" stroke="${escapeSvgXml(stroke.color)}" stroke-width="${formatSvgNumber(width)}" stroke-linecap="round" stroke-linejoin="round"${opacity} />`;
  });
}

export function renderInspectOverlay(options: InspectOverlayOptions): string {
  const imageWidth = validateDimension(options.imageWidth, "imageWidth");
  const imageHeight = validateDimension(options.imageHeight, "imageHeight");
  if (
    !Number.isFinite(options.assetRect.x) ||
    !Number.isFinite(options.assetRect.y) ||
    !Number.isFinite(options.assetRect.w) ||
    !Number.isFinite(options.assetRect.h) ||
    options.assetRect.w <= 0 ||
    options.assetRect.h <= 0
  ) {
    throw new HumanBoardError(
      "E_USAGE",
      "assetRect must have finite coordinates and positive dimensions",
    );
  }

  const background = options.background ?? "transparent";
  const imageMimeType = options.imageMimeType ?? "image/png";
  const strokes = options.strokes
    .flatMap((stroke) =>
      renderStrokeRuns(stroke, options.assetRect, imageWidth, imageHeight),
    )
    .join("");
  const backgroundElement =
    options.imageData === undefined
      ? `<rect x="0" y="0" ${svgAttr("width", formatSvgNumber(imageWidth))} ${svgAttr("height", formatSvgNumber(imageHeight))} fill="${escapeSvgXml(background)}" />`
      : `<image x="0" y="0" ${svgAttr("width", formatSvgNumber(imageWidth))} ${svgAttr("height", formatSvgNumber(imageHeight))} preserveAspectRatio="none" href="data:${escapeSvgXml(imageMimeType)};base64,${Buffer.from(options.imageData).toString("base64")}" />`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" ${svgAttr("width", formatSvgNumber(imageWidth))} ${svgAttr("height", formatSvgNumber(imageHeight))} ${svgAttr("viewBox", `0 0 ${formatSvgNumber(imageWidth)} ${formatSvgNumber(imageHeight)}`)} ${svgAttr("data-inspect", "true")}>`,
    `<title>HumanBoard Inspect Overlay</title>`,
    backgroundElement,
    `<g data-layer="inspect-strokes">${strokes}</g>`,
    `</svg>`,
  ].join("");
}

export function renderInspectOverlayPNG(
  options: InspectOverlayOptions,
): Buffer {
  return rasterizeSvgToPNG(renderInspectOverlay(options), "Inspect overlay");
}

export function renderInspectCompositePNG(
  options: InspectOverlayOptions & {
    readonly imageData: Uint8Array;
    readonly imageMimeType: string;
  },
): Buffer {
  return rasterizeSvgToPNG(renderInspectOverlay(options), "Inspect composite");
}
