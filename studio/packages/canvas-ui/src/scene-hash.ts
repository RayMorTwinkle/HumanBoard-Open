import { canonicalSceneJson, type Scene } from "@humanboard/schema/scene";
/** Same canonical bytes as the server; Web Crypto keeps Node APIs out of the browser. */
export async function browserSceneHash(scene: Scene): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalSceneJson(scene));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
