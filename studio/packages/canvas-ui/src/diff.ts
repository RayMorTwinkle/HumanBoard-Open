import type { DiffBox } from "./client/types";

export interface DiffBoxCounts {
  readonly stroke: number;
  readonly node: number;
}

export function countDiffBoxes(boxes: readonly DiffBox[]): DiffBoxCounts {
  let stroke = 0;
  let node = 0;
  for (const box of boxes) {
    if (box.kind === "node") {
      node += 1;
    } else if (box.kind === "stroke") {
      stroke += 1;
    }
  }
  return { stroke, node };
}
