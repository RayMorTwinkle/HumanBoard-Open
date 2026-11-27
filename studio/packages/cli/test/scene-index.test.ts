import { expect, test } from "bun:test";

import { sceneIndex } from "@humanboard/application-service/scene-index";

import { outputModeForCommand, parseCliArgs } from "../src/parser";

test("index lists one object per line and leaves out default anchors", () => {
  const rect = (x: number) => ({ x, y: 0, w: 184, h: 68 });
  const lines = sceneIndex({
    nodes: [
      { id: "api", kind: "service", title: "API", sub: "v2", rect: rect(0) },
      { id: "db", kind: "database", title: "订单库", rect: rect(300) },
    ],
    edges: [
      {
        id: "e1",
        from: { node_id: "api", side: "right", offset: 0.5 },
        to: { node_id: "db", side: "left", offset: 0.5 },
        label: "写入",
      },
      {
        id: "e2",
        from: { node_id: "db", side: "bottom", offset: 0.5 },
        to: { node_id: "api", side: "bottom", offset: 0.3 },
        style: { curve: true, dashed: true },
      },
    ],
    strokes: [],
    assets: [],
  });
  expect(lines).toEqual([
    'node api service "API" 0,0 184x68 sub="v2"',
    'node db database "订单库" 300,0 184x68',
    'edge e1 api->db "写入"',
    "edge e2 db.bottom->api.bottom@0.3 dashed curve",
  ]);
});

test("get --format index prints text by default", () => {
  const parsed = parseCliArgs(["get", "--format", "index"]);
  expect(parsed.command).toMatchObject({ kind: "get", format: "index" });
  expect(outputModeForCommand(parsed)).toBe("text");
});

test("structured index returns authored content without generated coordinates", async()=>{
 const {compileDiagram,DiagramSchema}=await import("@humanboard/schema");
 const diagram=DiagramSchema.parse({mode:"logic",nodes:[{id:"start",title:"Start"}]});
 const index=sceneIndex({...compileDiagram(diagram),diagram});
 expect(index[0]).toStartWith("diagram ");expect(index.join("\n")).not.toContain('"rect"');
});
