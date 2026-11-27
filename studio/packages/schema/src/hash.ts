import { createHash } from "node:crypto";
import type { Scene } from "./schema";
import { canonicalSceneJson } from "./canonical";
export function sceneContentHash(scene: Scene): `sha256:${string}` {
  const digest = createHash("sha256")
    .update(canonicalSceneJson(scene), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}
