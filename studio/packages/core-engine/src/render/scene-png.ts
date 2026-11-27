import { Resvg, renderAsync } from "@resvg/resvg-js";

import type { Scene } from "@humanboard/schema";

import { HumanBoardError } from "../domain/errors";
import {
  renderDiffToSVGs,
  type DiffSVGs,
  type RenderDiffOptions,
} from "./scene-diff-svg";
import {
  renderSceneToSVG,
  type Bounds,
  type RenderSceneOptions,
} from "./scene-svg";

export interface DiffPNGs {
  readonly bounds: Bounds;
  readonly before: Buffer;
  readonly after: Buffer;
  readonly highlight: Buffer;
}

function validateSvgSize(svg: string): void {
  const root = svg.slice(0, svg.indexOf(">") + 1);
  const w = Number(/\bwidth="([\d.]+)"/.exec(root)?.[1]);
  const h = Number(/\bheight="([\d.]+)"/.exec(root)?.[1]);
  if (
    !Number.isFinite(w) ||
    !Number.isFinite(h) ||
    w <= 0 ||
    h <= 0 ||
    w > 16384 ||
    h > 16384 ||
    w * h > 40_000_000
  ) {
    throw new HumanBoardError(
      "E_USAGE",
      "Rendered image exceeds the 40 megapixel / 16384px limit",
      { width: w, height: h },
    );
  }
}

export function rasterizeSvgToPNG(svg: string, label = "SVG"): Buffer {
  validateSvgSize(svg);
  try {
    return Buffer.from(new Resvg(svg).render().asPng());
  } catch (error) {
    throw new HumanBoardError("E_INTERNAL", `Cannot rasterize ${label} SVG`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Native async rendering keeps HTTP/capture/layer navigation responsive on cache misses. */
export async function renderSceneToPNGAsync(
  scene: Scene,
  options: RenderSceneOptions = {},
): Promise<Buffer> {
  const svg = renderSceneToSVG(scene, options);
  validateSvgSize(svg);
  try {
    return Buffer.from((await renderAsync(svg)).asPng());
  } catch (error) {
    throw new HumanBoardError("E_INTERNAL", "Cannot rasterize Scene SVG", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function renderDiffToPNGsAsync(
  base: Scene,
  target: Scene,
  options: RenderDiffOptions = {},
): Promise<DiffPNGs> {
  const svgs = renderDiffToSVGs(base, target, options);
  const keys = ["before", "after", "highlight"] as const;
  keys.forEach((key) => validateSvgSize(svgs[key]));
  try {
    const [before, after, highlight] = await Promise.all(
      keys.map(async (key) =>
        Buffer.from((await renderAsync(svgs[key])).asPng()),
      ),
    );
    return {
      bounds: svgs.bounds,
      before: before!,
      after: after!,
      highlight: highlight!,
    };
  } catch (error) {
    throw new HumanBoardError("E_INTERNAL", "Cannot rasterize Diff SVG", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function renderSceneToPNG(
  scene: Scene,
  options: RenderSceneOptions = {},
): Buffer {
  return rasterizeSvgToPNG(renderSceneToSVG(scene, options), "Scene");
}

export function renderDiffToPNGs(
  base: Scene,
  target: Scene,
  options: RenderDiffOptions = {},
): DiffPNGs {
  const svgs: DiffSVGs = renderDiffToSVGs(base, target, options);
  return {
    bounds: svgs.bounds,
    before: rasterizeSvgToPNG(svgs.before, "before"),
    after: rasterizeSvgToPNG(svgs.after, "after"),
    highlight: rasterizeSvgToPNG(svgs.highlight, "highlight"),
  };
}
